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
import { diffNetwork, diffFlags, diffSteps, diffConsole, buildComparisonJson, buildComparisonMarkdown } from './lib/buildComparison.js';

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
/**
 * Extract a ZIP to a temp dir and return the trace directory path.
 * Returns { traceDir, tempDir } where tempDir should be cleaned up by the caller.
 * If inputPath is not a ZIP, returns { traceDir: inputPath, tempDir: null }.
 */
async function resolveTraceInput(inputPath) {
  if (!inputPath.endsWith('.zip')) return { traceDir: inputPath, tempDir: null };
  const tempDir = await mkdtemp(join(tmpdir(), 'pw-trace-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('unzip', ['-o', '-q', inputPath, '-d', tempDir]);
  let traceDir = tempDir;
  const entries = await readdir(tempDir);
  if (entries.length === 1) {
    try {
      const sub = join(tempDir, entries[0]);
      const subEntries = await readdir(sub);
      if (subEntries.some(f => f.endsWith('.trace'))) {
        traceDir = sub;
      }
    } catch { /* not a directory */ }
  }
  return { traceDir, tempDir };
}

export async function transformTrace(inputPath, outputDir, options = {}) {
  const warnings = [];

  // Handle ZIP input
  const { traceDir, tempDir } = await resolveTraceInput(inputPath);

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

  // --- Write console.json ---
  const consoleLines = trace.console.map(e => JSON.stringify(e)).join('\n');
  await writeFile(join(outputDir, 'console.json'), consoleLines);

  // --- Write log files per callId ---
  for (const [callId, messages] of trace.logs) {
    const safeId = callId.replace(/@/g, '_');
    const logLines = messages.map(m => JSON.stringify(m)).join('\n');
    await writeFile(join(outputDir, 'logs', `${safeId}.json`), logLines);
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
      errorContext = await readFile(options.errorContextPath, 'utf-8');
    } catch { /* file not found or unreadable — skip */ }
  }

  // --- Write AI-optimized summary files ---
  const [summary, timeline, outline] = await Promise.all([
    Promise.resolve(buildSummary(trace, network, stacks, cleanSteps, {
      errorContext,
      resourcesDir: join(traceDir, 'resources'),
    })),
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
 * Compare a passing trace against a failing trace.
 * Normalizes both, then produces comparison.json and comparison.md with structured diffs.
 *
 * @param {string} passingDir - path to passing trace folder (or .zip)
 * @param {string} failingDir - path to failing trace folder (or .zip)
 * @param {string} [outputDir] - output directory
 * @param {object} [options] - same options as transformTrace (signals, includeSecrets, etc.)
 * @returns {Promise<{outputDir: string, warnings: string[]}>}
 */
export async function compareTraces(passingDir, failingDir, outputDir, options = {}) {
  if (!outputDir) {
    outputDir = failingDir.replace(/\.zip$/i, '') + '-compare';
  }
  await mkdir(outputDir, { recursive: true });

  const warnings = [];
  const failingOut = join(outputDir, 'failing');
  const passingOut = join(outputDir, 'passing');

  // Resolve ZIP inputs once. We pass the extracted dirs to transformTrace
  // (which won't re-extract since they're not .zip) and keep them alive
  // for diffFlags to read resources/ after normalization.
  const resolved = { passing: null, failing: null };
  try {
    resolved.failing = await resolveTraceInput(failingDir);
    resolved.passing = await resolveTraceInput(passingDir);
  } catch (err) {
    if (resolved.failing?.tempDir) { try { await rm(resolved.failing.tempDir, { recursive: true }); } catch { /* best effort */ } }
    if (resolved.passing?.tempDir) { try { await rm(resolved.passing.tempDir, { recursive: true }); } catch { /* best effort */ } }
    throw err;
  }
  const resolvedFailingDir = resolved.failing.traceDir;
  const resolvedPassingDir = resolved.passing.traceDir;

  try {
    // 1. Always normalize the failing trace first
    const failingResult = await transformTrace(resolvedFailingDir, failingOut, options);
    warnings.push(...failingResult.warnings.map(w => `[failing] ${w}`));

    // 2. Try to normalize the passing trace (may fail if corrupted/incomplete)
    try {
      const passingResult = await transformTrace(resolvedPassingDir, passingOut, options);
      warnings.push(...passingResult.warnings.map(w => `[passing] ${w}`));
    } catch (err) {
      warnings.push(`Passing trace normalization failed: ${err.message}`);
      await writeFile(join(outputDir, 'comparison.json'), JSON.stringify({
        schemaVersion: 1,
        error: `Passing trace could not be normalized: ${err.message}`,
        summary: 'Compare mode failed -- use failing/summary.json for single-trace analysis.',
        drillDown: { failingSummary: 'failing/summary.json' },
      }, null, 2));
      await writeFile(join(outputDir, 'comparison.md'),
        '# Trace Comparison: failed\n\nPassing trace could not be normalized. Use `failing/summary.json` for single-trace analysis.\n');
      return { outputDir, warnings };
    }

    // 3. Read normalized outputs
    const readJson = async (p) => JSON.parse(await readFile(p, 'utf-8'));
    const readJsonSafe = async (p) => { try { return await readJson(p); } catch { return null; } };
    const readNdjson = async (p) => {
      try {
        const text = await readFile(p, 'utf-8');
        return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
      } catch { return []; }
    };

    const passingNetworkIndex = await readJson(join(passingOut, 'network', 'index.json'));
    const failingNetworkIndex = await readJson(join(failingOut, 'network', 'index.json'));
    const passingSignals = await readJsonSafe(join(passingOut, 'network', 'signals.json'));
    const failingSignals = await readJsonSafe(join(failingOut, 'network', 'signals.json'));
    const passingOutline = await readJson(join(passingOut, 'steps-outline.json'));
    const failingOutline = await readJson(join(failingOut, 'steps-outline.json'));
    const passingConsole = await readNdjson(join(passingOut, 'console.json'));
    const failingConsole = await readNdjson(join(failingOut, 'console.json'));

    // 4. Diff (use resolved dirs for resources/ access)
    const networkDiff = diffNetwork(passingNetworkIndex, failingNetworkIndex);
    const flagsDiff = await diffFlags(
      passingSignals, failingSignals,
      join(resolvedPassingDir, 'resources'), join(resolvedFailingDir, 'resources')
    );
    const stepsDiff = diffSteps(passingOutline, failingOutline);
    const consoleDiff = diffConsole(passingConsole, failingConsole);

    // 5. Copy referenced resource files into the output so paths survive temp dir cleanup.
    // Only copy files actually referenced by changedResponses (not the entire resources/ dir).
    const outPassingRes = join(outputDir, 'passing', 'resources');
    const outFailingRes = join(outputDir, 'failing', 'resources');
    const refsToCollect = new Set();
    for (const cr of networkDiff.changedResponses) {
      if (cr.passingSha1) refsToCollect.add({ src: join(resolvedPassingDir, 'resources', cr.passingSha1), dest: join(outPassingRes, cr.passingSha1) });
      if (cr.failingSha1) refsToCollect.add({ src: join(resolvedFailingDir, 'resources', cr.failingSha1), dest: join(outFailingRes, cr.failingSha1) });
    }
    if (refsToCollect.size > 0) {
      await mkdir(outPassingRes, { recursive: true });
      await mkdir(outFailingRes, { recursive: true });
      for (const { src, dest } of refsToCollect) {
        try { await copyFile(src, dest); } catch { /* file may not exist */ }
      }
    }

    // 6. Build and write comparison output
    // Resources are now at <outputDir>/passing/resources/ and <outputDir>/failing/resources/
    const comparison = buildComparisonJson(networkDiff, flagsDiff, stepsDiff, consoleDiff, {
      outputDir,
      passingResourcesDir: join(outputDir, 'passing', 'resources'),
      failingResourcesDir: join(outputDir, 'failing', 'resources'),
    });
    const markdown = buildComparisonMarkdown(comparison);

    await writeFile(join(outputDir, 'comparison.json'), JSON.stringify(comparison, null, 2));
    await writeFile(join(outputDir, 'comparison.md'), markdown);

    return { outputDir, warnings };
  } finally {
    // Clean up temp dirs from ZIP extraction
    if (resolved.failing?.tempDir) { try { await rm(resolved.failing.tempDir, { recursive: true }); } catch { /* best effort */ } }
    if (resolved.passing?.tempDir) { try { await rm(resolved.passing.tempDir, { recursive: true }); } catch { /* best effort */ } }
  }
}
