import { mkdir, mkdtemp, writeFile, readFile, copyFile, access, rm, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

import { parseTrace } from './lib/parseTrace.js';
import { parseNetwork, toNetworkIndexEntry, toNetworkPayload, redactHeaders } from './lib/parseNetwork.js';
import { parseStacks } from './lib/parseStacks.js';
import { serializeDom } from './lib/serializeDom.js';
import { sanitizeStepId, assignScreenshots, copyScreenshots, assignDomSnapshots } from './lib/renameResources.js';
import { buildSummary } from './lib/buildSummary.js';
import { buildFailureTimeline } from './lib/buildTimeline.js';
import { buildStepsOutline } from './lib/buildOutline.js';

export { parseTrace } from './lib/parseTrace.js';
export { parseNetwork } from './lib/parseNetwork.js';
export { parseStacks } from './lib/parseStacks.js';
export { serializeDom } from './lib/serializeDom.js';

/**
 * Transform a Playwright trace folder into an AI-navigable output directory.
 *
 * @param {string} inputPath - path to trace folder (or .zip)
 * @param {string} [outputDir] - output directory (defaults to inputPath + '-output')
 * @param {object} [options]
 * @param {boolean} [options.noOverwrite=false] - error if outputDir exists
 * @param {boolean} [options.includeSecrets=false] - if true, skip header redaction
 * @param {string} [options.errorContextPath] - path to error-context.md to include in summary
 * @param {object} [options.signals] - signal extraction config for network analysis
 * @param {string[]} [options.signals.apiDomains] - URL substrings identifying app API calls
 * @param {string[]} [options.signals.flagUrlPatterns] - URL substrings that must ALL match for flag eval detection
 * @param {string} [options.signals.requestIdHeader] - response header name to extract request IDs from on 4xx/5xx
 * @returns {Promise<{outputDir: string, warnings: string[]}>}
 */
export async function transformTrace(inputPath, outputDir, options = {}) {
  const warnings = [];

  // Handle ZIP input
  let traceDir = inputPath;
  let tempDir = null;
  if (inputPath.endsWith('.zip')) {
    tempDir = await mkdtemp(join(tmpdir(), 'pw-trace-'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('unzip', ['-o', '-q', inputPath, '-d', tempDir]);
    traceDir = tempDir;
    // Check if zip extracted into a subdirectory
    const entries = await readdir(tempDir);
    if (entries.length === 1) {
      const sub = join(tempDir, entries[0]);
      try {
        const subEntries = await readdir(sub);
        if (subEntries.some(f => f.endsWith('.trace'))) {
          traceDir = sub;
        }
      } catch { /* not a directory */ }
    }
  }

  // Determine output directory (derive from inputPath, not tempDir, for ZIP inputs)
  if (!outputDir) {
    outputDir = inputPath.replace(/\.zip$/i, '') + '-output';
  }

  // Check overwrite
  if (options.noOverwrite) {
    try {
      await access(outputDir);
      throw new Error(`Output directory already exists: ${outputDir}. Use --output to specify a different path.`);
    } catch (err) {
      if (err.message.startsWith('Output directory')) throw err;
      // ENOENT is expected — directory doesn't exist
    }
  }

  // Create output directories
  try {
    await mkdir(outputDir, { recursive: true });
    await mkdir(join(outputDir, 'network'), { recursive: true });
    await mkdir(join(outputDir, 'network', 'steps'), { recursive: true });
    await mkdir(join(outputDir, 'screenshots'), { recursive: true });
    await mkdir(join(outputDir, 'dom'), { recursive: true });
    await mkdir(join(outputDir, 'stacks'), { recursive: true });
    await mkdir(join(outputDir, 'logs'), { recursive: true });
  } catch (err) {
    // Cleanup temp dir on mkdir failure
    if (tempDir) { try { await rm(tempDir, { recursive: true }); } catch { /* best effort */ } }
    throw new Error(`Failed to create output directory: ${err.message}`);
  }

  // --- Parse trace ---
  const trace = await parseTrace(traceDir);
  warnings.push(...trace.warnings);

  // --- Parse network ---
  const network = await parseNetwork(traceDir, options.signals);
  warnings.push(...network.warnings);

  // --- Parse stacks ---
  const stacks = await parseStacks(traceDir);
  warnings.push(...stacks.warnings);

  // --- Build step map for correlations ---
  const stepMapByCallId = new Map();
  for (const step of trace.stepsRaw) {
    stepMapByCallId.set(step.callId, step);
  }

  // --- Correlate stacks to steps ---
  // The stacks file uses numeric callIds that map to step callIds
  // The callId in stacks is numeric, step callIds are like "call@2119"
  // We need to match: stack callId 2119 -> step callId "call@2119"
  for (const step of trace.stepsRaw) {
    // Extract numeric part from callId like "call@2119" -> 2119
    const match = step.callId.match(/@(\d+)$/);
    if (match) {
      const numericId = parseInt(match[1], 10);
      if (stacks.stacksByCallId.has(numericId)) {
        const stackData = stacks.stacksByCallId.get(numericId);
        const safeId = sanitizeStepId(step.id);
        const stackFile = `stacks/${safeId}.json`;
        step.stackFile = stackFile;

        await writeFile(
          join(outputDir, stackFile),
          JSON.stringify(stackData, null, 2)
        );
      }
    }
  }

  // --- Build step-by-id lookup for O(1) access ---
  const stepById = new Map();
  for (const step of trace.stepsRaw) {
    stepById.set(step.id, step);
  }

  // --- Assign screenshots to steps ---
  const resourcesDir = join(traceDir, 'resources');
  let hasResources = false;
  try {
    await access(resourcesDir);
    hasResources = true;
  } catch {
    warnings.push('No resources/ directory found; screenshots and DOM snapshots will be skipped');
  }

  if (hasResources) {
    const screenshotAssignments = assignScreenshots(
      trace.screenshots, trace.stepsRaw, resourcesDir, warnings
    );

    // Update step screenshot paths
    for (const a of screenshotAssignments) {
      if (a.stepId) {
        const step = stepById.get(a.stepId);
        if (step) {
          step.screenshot = `screenshots/${sanitizeStepId(a.stepId)}-${a.label}${a.ext}`;
        }
      }
    }

    await copyScreenshots(screenshotAssignments, resourcesDir, join(outputDir, 'screenshots'), warnings);
  }

  // --- Assign DOM snapshots ---
  const { domAssignments, unassigned: unassignedDom } = assignDomSnapshots(
    trace.frameSnapshots, stepMapByCallId
  );

  for (const [stepId, snap] of domAssignments) {
    const safeId = sanitizeStepId(stepId);
    const step = stepById.get(stepId);
    if (step) {
      step.domSnapshot = `dom/${safeId}.html`;
    }

    // Serialize the DOM tree to HTML
    const domWarnings = [];
    const html = serializeDom(snap.html, new Map(), domWarnings);
    for (const w of domWarnings) warnings.push(`DOM ${stepId}: ${w}`);

    await writeFile(join(outputDir, 'dom', `${safeId}.html`), html);
  }

  // Write unassigned DOM snapshots
  for (const snap of unassignedDom) {
    const sha1 = snap.snapshotName || 'unknown';
    const safeName = sha1.replace(/[^a-zA-Z0-9._-]/g, '_');
    const domWarnings = [];
    const html = serializeDom(snap.html, new Map(), domWarnings);
    await writeFile(join(outputDir, 'dom', `unassigned-${safeName}.html`), html);
  }

  // --- Write network output ---
  // network/index.json
  const networkIndex = network.calls.map(toNetworkIndexEntry);
  await writeFile(
    join(outputDir, 'network', 'index.json'),
    JSON.stringify(networkIndex, null, 2)
  );

  // network/failures.json
  const networkFailures = network.failures.map(toNetworkIndexEntry);
  await writeFile(
    join(outputDir, 'network', 'failures.json'),
    JSON.stringify(networkFailures, null, 2)
  );

  // Individual network payload files
  for (const call of network.calls) {
    const payload = toNetworkPayload(call);

    // When --include-secrets is set, restore the original unredacted headers
    if (options.includeSecrets) {
      payload.request.headers = call._request.headers;
      payload.response.headers = call._response.headers;
    }

    await writeFile(
      join(outputDir, 'network', `${call.callId}.json`),
      JSON.stringify(payload, null, 2)
    );
  }

  // --- Write network/signals.json (only when signal extraction is configured) ---
  const hasSignals = network.failuresWithRequestIds.length > 0
    || network.flagEvals.length > 0
    || network.apiBodyRefs.length > 0;
  if (hasSignals) {
    await writeFile(
      join(outputDir, 'network', 'signals.json'),
      JSON.stringify({
        failuresWithRequestIds: network.failuresWithRequestIds,
        flagEvals: network.flagEvals,
        apiBodyRefs: network.apiBodyRefs,
      }, null, 2)
    );
  }

  // --- Correlate network calls to steps by timestamp ---
  // Parse startedAt as Date for each call
  const networkCallsByTime = network.calls
    .filter(c => c.startedAt)
    .map(c => ({ ...c, startedAtMs: new Date(c.startedAt).getTime() }));

  for (const step of trace.stepsRaw) {
    const stepStartMs = step.startedAt ? new Date(step.startedAt).getTime() : null;
    const stepEndMs = step.endedAt ? new Date(step.endedAt).getTime() : null;
    if (stepStartMs == null) continue;

    const matchingCallIds = [];
    for (const call of networkCallsByTime) {
      if (call.startedAtMs >= stepStartMs && call.startedAtMs <= (stepEndMs ?? Infinity)) {
        matchingCallIds.push(call.callId);
      }
    }

    if (matchingCallIds.length > 0) {
      const safeId = sanitizeStepId(step.id);
      const stepNetworkFile = `network/steps/${safeId}.json`;
      step.networkCallsFile = stepNetworkFile;
      await writeFile(
        join(outputDir, stepNetworkFile),
        JSON.stringify(matchingCallIds, null, 2)
      );
    }
  }

  // --- Write console.jsonl ---
  const consoleLines = trace.console.map(e => JSON.stringify(e)).join('\n');
  await writeFile(join(outputDir, 'console.jsonl'), consoleLines);

  // --- Write log files per callId ---
  for (const [callId, messages] of trace.logs) {
    const safeId = callId.replace(/@/g, '_');
    const logLines = messages.map(m => JSON.stringify(m)).join('\n');
    await writeFile(join(outputDir, 'logs', `${safeId}.jsonl`), logLines);
  }

  // --- Write index.json ---
  const cleanSteps = trace.stepsRaw.map(s => ({
    id: s.id,
    callId: s.callId,
    title: s.title,
    type: s.type,
    startedAt: s.startedAt ?? trace.toISO(s.startTime),
    endedAt: s.endedAt ?? trace.toISO(s.endTime),
    duration_ms: s.duration_ms,
    parentId: s.parentId,
    children: s.children,
    error: s.error,
    status: s.status,
    screenshot: s.screenshot,
    domSnapshot: s.domSnapshot,
    networkCallsFile: s.networkCallsFile,
    stackFile: s.stackFile,
  }));

  const indexJson = {
    schemaVersion: 1,
    test: trace.test,
    errors: trace.errors,
    steps: cleanSteps,
    _meta: {
      generatedAt: new Date().toISOString(),
      traceDir,
      warnings,
    },
  };

  await writeFile(
    join(outputDir, 'index.json'),
    JSON.stringify(indexJson, null, 2)
  );

  // --- Read error-context.md if provided ---
  let errorContext = null;
  if (options.errorContextPath) {
    try {
      const content = await readFile(options.errorContextPath, 'utf-8');
      errorContext = content.length > 4096
        ? content.slice(0, 4096) + '\n... (truncated, read full file at: ' + options.errorContextPath + ')'
        : content;
    } catch { /* file not found or unreadable — skip */ }
  }

  // --- Write AI-optimized summary files ---
  const [summary, timeline, outline] = await Promise.all([
    Promise.resolve(buildSummary(trace, network, stacks, cleanSteps, { errorContext })),
    Promise.resolve(buildFailureTimeline(cleanSteps, network.calls, trace.console)),
    Promise.resolve(buildStepsOutline(cleanSteps)),
  ]);

  await Promise.all([
    writeFile(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2)),
    writeFile(join(outputDir, 'failure-timeline.json'), JSON.stringify(timeline, null, 2)),
    writeFile(join(outputDir, 'steps-outline.json'), JSON.stringify(outline, null, 2)),
  ]);

  // Cleanup temp dir if we unzipped
  if (tempDir) {
    try {
      await rm(tempDir, { recursive: true });
    } catch { /* best effort */ }
  }

  return { outputDir, warnings };
}

/**
 * Compare two traces (passing vs failing).
 * Phase 2 — stub for now.
 */
export async function compareTraces(passingDir, failingDir, outputDir, options = {}) {
  throw new Error('compareTraces() is not yet implemented. Phase 2.');
}
