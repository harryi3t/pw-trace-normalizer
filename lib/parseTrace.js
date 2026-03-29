import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str) {
  if (!str) return str;
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Parse all .trace files in a directory and return structured trace data.
 *
 * @param {string} traceDir - path to the unzipped trace folder
 * @returns {{ steps, errors, test, console, logs, screenshots, frameSnapshots, warnings, wallTime, baseMonotonicTime }}
 */
export async function parseTrace(traceDir) {
  const files = await readdir(traceDir);
  const traceFiles = files.filter(f => f.endsWith('.trace')).sort();

  if (traceFiles.length === 0) {
    throw new Error(`No .trace files found in ${traceDir}`);
  }

  // Collect all events from all trace files
  const allEvents = [];
  for (const tf of traceFiles) {
    const rl = createInterface({
      input: createReadStream(join(traceDir, tf), 'utf-8'),
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        allEvents.push(JSON.parse(line));
      } catch {
        // Malformed NDJSON line — skip
      }
    }
  }

  // Extract context-options (should be first event of first trace file)
  let contextOptions = null;
  let wallTime = null;
  let baseMonotonicTime = null;
  const warnings = [];

  for (const evt of allEvents) {
    if (evt.type === 'context-options') {
      contextOptions = evt;
      wallTime = evt.wallTime;
      baseMonotonicTime = evt.monotonicTime;
      break;
    }
  }

  if (!contextOptions) {
    wallTime = Date.now();
    baseMonotonicTime = allEvents.find(e => e.startTime != null)?.startTime ?? 0;
    warnings.push('Missing context-options event; using Date.now() as wallTime fallback');
  }

  /**
   * Convert monotonicTime to ISO 8601 string.
   */
  function toISO(monotonicTime) {
    if (monotonicTime == null) return null;
    const absoluteMs = wallTime + (monotonicTime - baseMonotonicTime);
    return new Date(absoluteMs).toISOString();
  }

  // Separate event types
  const beforeEvents = new Map(); // callId -> event
  const afterEvents = new Map();  // callId -> event
  const consoleEvents = [];
  const logEvents = [];           // callId -> messages[]
  const logMap = new Map();
  const screenshotFrames = [];
  const frameSnapshots = [];
  const errorEvents = [];
  let skippedLines = 0;

  for (const evt of allEvents) {
    switch (evt.type) {
      case 'before':
        beforeEvents.set(evt.callId, evt);
        break;
      case 'after':
        afterEvents.set(evt.callId, evt);
        break;
      case 'console':
        consoleEvents.push(evt);
        break;
      case 'log':
        if (!logMap.has(evt.callId)) logMap.set(evt.callId, []);
        logMap.get(evt.callId).push(evt);
        break;
      case 'screencast-frame':
        screenshotFrames.push(evt);
        break;
      case 'frame-snapshot':
        frameSnapshots.push(evt);
        break;
      case 'error':
        errorEvents.push(evt);
        break;
      case 'context-options':
      case 'event':
      case 'input':
        // Known types we don't need to process further
        break;
      default:
        skippedLines++;
        break;
    }
  }

  if (skippedLines > 0) {
    warnings.push(`Skipped ${skippedLines} unrecognized event lines`);
  }

  // Build step tree
  const steps = [];
  const stepMap = new Map(); // callId -> step object

  for (const [callId, before] of beforeEvents) {
    const after = afterEvents.get(callId);
    const startTime = before.startTime;
    const endTime = after?.endTime ?? null;
    const durationMs = (startTime != null && endTime != null) ? Math.round(endTime - startTime) : null;

    const step = {
      id: before.stepId || callId,
      callId,
      title: before.title || `${before.class}.${before.method}`,
      type: before.method || 'unknown',
      startedAt: toISO(startTime),
      endedAt: toISO(endTime),
      duration_ms: durationMs,
      startTime,    // raw monotonicTime, used for screenshot correlation
      endTime,      // raw monotonicTime
      parentId: before.parentId || null,
      children: [],
      error: null,
      status: after ? 'completed' : 'incomplete',
      screenshot: null,
      domSnapshot: null,
      networkCallsFile: null,
      stackFile: null,
    };

    // Check for error on after event
    if (after?.error) {
      const rawMsg = after.error.message || after.error.name || '';
      step.error = {
        message: stripAnsi(rawMsg),
        name: after.error.name || '',
      };
    }

    stepMap.set(callId, step);
    steps.push(step);
  }

  // Build parent-child relationships
  for (const step of steps) {
    if (step.parentId && stepMap.has(step.parentId)) {
      stepMap.get(step.parentId).children.push(step.id);
    }
  }

  // Collect top-level errors from error events + step errors
  const errors = [];

  // Error events (top-level test errors)
  for (const evt of errorEvents) {
    errors.push({
      message: stripAnsi(evt.message || ''),
      stack: evt.stack || [],
    });
  }

  // Step-level errors
  for (const step of steps) {
    if (step.error) {
      errors.push({
        stepId: step.id,
        message: step.error.message,
        step: step.title,
        startedAt: step.startedAt,
      });
    }
  }

  // Extract test metadata from context-options
  const titleStr = contextOptions?.title || '';
  // Parse title: "file.ts:line › Suite › Test name"
  const titleParts = titleStr.split(' › ');
  const testFile = titleParts[0] || '';
  const testTitle = titleParts.length > 1 ? titleParts[titleParts.length - 1] : titleStr;

  // Determine test status
  const hasErrors = errors.length > 0;
  const allIncomplete = steps.length > 0 && steps.every(s => s.status === 'incomplete');
  const testStatus = hasErrors ? 'failed' : allIncomplete ? 'incomplete' : 'passed';

  // Calculate duration
  const allStartTimes = steps.map(s => s.startTime).filter(t => t != null);
  const allEndTimes = steps.map(s => s.endTime).filter(t => t != null);
  const minStart = allStartTimes.length ? allStartTimes.reduce((a, b) => a < b ? a : b) : null;
  const maxEnd = allEndTimes.length ? allEndTimes.reduce((a, b) => a > b ? a : b) : null;
  const totalDurationS = (minStart != null && maxEnd != null) ? Math.round((maxEnd - minStart) / 10) / 100 : null;

  const test = {
    title: testTitle,
    status: testStatus,
    duration_s: totalDurationS,
    startedAt: toISO(minStart),
    endedAt: toISO(maxEnd),
    file: testFile,
  };

  // Format console events
  const consoleEntries = consoleEvents.map(evt => ({
    type: evt.messageType || 'log',
    text: evt.text || '',
    timestamp: toISO(evt.time),
    source: evt.location
      ? `${evt.location.url || 'browser'}:${evt.location.lineNumber ?? ''}`
      : 'browser',
  }));

  // Format log events per callId
  const logs = new Map();
  for (const [callId, messages] of logMap) {
    logs.set(callId, messages.map(m => ({
      time: toISO(m.time),
      message: m.message,
    })));
  }

  // Prepare screenshot frames for correlation
  const screenshots = screenshotFrames.map(evt => ({
    sha1: evt.sha1,
    timestamp: evt.timestamp,
    pageId: evt.pageId,
    width: evt.width,
    height: evt.height,
  }));

  // Prepare frame snapshots
  const domSnapshots = frameSnapshots.map(evt => {
    const snap = evt.snapshot || evt;
    return {
      callId: snap.callId,
      snapshotName: snap.snapshotName,
      pageId: snap.pageId,
      frameId: snap.frameId,
      html: snap.html,
      timestamp: snap.timestamp,
      resourceOverrides: snap.resourceOverrides,
      isMainFrame: snap.isMainFrame,
    };
  });

  // Clean up internal fields from steps before returning
  const cleanSteps = steps.map(s => {
    const { startTime: _st, endTime: _et, ...rest } = s;
    return rest;
  });

  return {
    test,
    errors,
    steps: cleanSteps,
    stepsRaw: steps, // with raw monotonicTime for screenshot correlation
    console: consoleEntries,
    logs,
    screenshots,
    frameSnapshots: domSnapshots,
    warnings,
    wallTime,
    baseMonotonicTime,
    toISO,
  };
}
