/**
 * Build comparison output from two normalized trace outputs.
 * Produces structured diffs (comparison.json) and a human-readable narrative (comparison.md).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Deep equality check that ignores object key order.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * Normalize a step title for comparison by stripping dynamic parts.
 */
function normalizeTitle(title) {
  if (!title) return '';
  return title
    .replace(/https?:\/\/[^\s/]+/g, '') // strip hostnames
    .replace(/\?[^\s]*/g, '')           // strip query params
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/[0-9a-f]{24,}/gi, '<ID>')
    .trim();
}

/**
 * Extract and normalize a URL pathname for grouping.
 * Strips query params, replaces MongoDB ObjectIds (24-char hex) and
 * base64 context blobs (LD eval URLs) with placeholders so the same
 * logical endpoint matches across different seed companies.
 */
function normalizeUrlPath(url) {
  let pathname;
  try { pathname = new URL(url).pathname; } catch { pathname = url; }
  return pathname
    .replace(/\/contexts\/[A-Za-z0-9+/=_-]{20,}$/, '/contexts/<context>')
    .replace(/[0-9a-f]{24}/gi, '<id>');
}

// ---------------------------------------------------------------------------
// diffNetwork
// ---------------------------------------------------------------------------

/**
 * Compare network calls between passing and failing traces.
 * Groups by method + URL pathname, compares status codes and response SHA1s.
 *
 * @param {Array} passingIndex - network/index.json from passing trace
 * @param {Array} failingIndex - network/index.json from failing trace
 */
export function diffNetwork(passingIndex, failingIndex) {
  const groupBy = (calls) => {
    const map = new Map();
    for (const c of calls) {
      if (c.relevance === 'third-party') {
        // skip CDN/analytics noise
      } else {
        const key = `${c.method} ${normalizeUrlPath(c.url)}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(c);
      }
    }
    return map;
  };

  const passingGroups = groupBy(passingIndex);
  const failingGroups = groupBy(failingIndex);
  const allKeys = new Set([...passingGroups.keys(), ...failingGroups.keys()]);

  const newFailures = [];
  const missingCalls = [];
  const newCalls = [];
  const changedResponses = [];
  const slowedDown = [];

  for (const key of allKeys) {
    const pCalls = passingGroups.get(key) || [];
    const fCalls = failingGroups.get(key) || [];
    const [method] = key.split(' ', 1);
    const urlPath = key.slice(method.length + 1);

    if (pCalls.length > 0 && fCalls.length === 0) {
      missingCalls.push({ method, urlPath, note: 'present in passing, absent in failing' });
      // eslint-disable-next-line no-continue
      continue;
    }
    if (pCalls.length === 0 && fCalls.length > 0) {
      newCalls.push({ method, urlPath, note: 'present in failing, absent in passing' });
      // eslint-disable-next-line no-continue
      continue;
    }

    // Compare statuses: check if failing introduced new error statuses
    const pStatuses = new Set(pCalls.map(c => c.status));
    const fStatuses = new Set(fCalls.map(c => c.status));
    for (const s of fStatuses) {
      if ((s >= 400 || s === 0) && !pStatuses.has(s)) {
        const failingCall = fCalls.find(c => c.status === s);
        newFailures.push({
          method, urlPath,
          passingStatus: [...pStatuses].find(ps => ps < 400 && ps > 0) || [...pStatuses][0],
          failingStatus: s,
          failingRequestId: failingCall?.requestId || null,
          failingCallId: failingCall?.callId || null,
        });
      }
    }

    // Compare response bodies (for 200 OK calls with apiBodyRef)
    const pBodyRefs = new Set(pCalls.filter(c => c.apiBodyRef).map(c => c.apiBodyRef));
    const fBodyRefs = new Set(fCalls.filter(c => c.apiBodyRef).map(c => c.apiBodyRef));
    if (pBodyRefs.size > 0 && fBodyRefs.size > 0) {
      const pRef = [...pBodyRefs][0];
      const fRef = [...fBodyRefs][0];
      if (pRef !== fRef) {
        changedResponses.push({
          method, urlPath, status: 200,
          passingSha1: pRef, failingSha1: fRef,
          note: 'same endpoint, different response body',
        });
      }
    }

    // Compare timing (median duration)
    const median = (arr) => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const pMs = median(pCalls.map(c => c.duration_ms).filter(Boolean));
    const fMs = median(fCalls.map(c => c.duration_ms).filter(Boolean));
    if (pMs > 0 && fMs > pMs * 3 && fMs > 3000) {
      slowedDown.push({ method, urlPath, passingMs: pMs, failingMs: fMs });
    }
  }

  return { newFailures, missingCalls, newCalls, changedResponses, slowedDown };
}

// ---------------------------------------------------------------------------
// diffFlags
// ---------------------------------------------------------------------------

/**
 * Compare feature flag eval responses between passing and failing traces.
 * When bodyRef differs, reads both JSON files and diffs key-value pairs.
 *
 * @param {object|null} passingSignals - network/signals.json from passing trace
 * @param {object|null} failingSignals - network/signals.json from failing trace
 * @param {string} passingResourcesDir - path to passing trace's resources/ dir
 * @param {string} failingResourcesDir - path to failing trace's resources/ dir
 */
export async function diffFlags(passingSignals, failingSignals, passingResourcesDir, failingResourcesDir) {
  const pEvals = passingSignals?.flagEvals || [];
  const fEvals = failingSignals?.flagEvals || [];
  const valuesChanged = [];
  const mockingChanged = [];

  if (pEvals.length === 0 && fEvals.length === 0) {
    return { valuesChanged, mockingChanged };
  }

  // Check mocking status changes
  const pHasUnmocked = pEvals.some(e => !e.mocked);
  const fHasUnmocked = fEvals.some(e => !e.mocked);
  if (pEvals.length > 0 && fEvals.length > 0 && pHasUnmocked !== fHasUnmocked) {
    mockingChanged.push({
      passingMocked: !pHasUnmocked,
      failingMocked: !fHasUnmocked,
      note: pHasUnmocked
        ? 'Flags were unmocked in passing but mocked in failing'
        : 'Flags were mocked in passing but unmocked in failing',
    });
  }

  // Compare flag values when both have unmocked evals with different bodyRefs
  const pUnmocked = pEvals.filter(e => !e.mocked && e.bodyRef);
  const fUnmocked = fEvals.filter(e => !e.mocked && e.bodyRef);

  if (pUnmocked.length > 0 && fUnmocked.length > 0) {
    const pRef = pUnmocked[0].bodyRef;
    const fRef = fUnmocked[0].bodyRef;

    if (pRef !== fRef) {
      try {
        const pBody = JSON.parse(await readFile(join(passingResourcesDir, pRef), 'utf-8'));
        const fBody = JSON.parse(await readFile(join(failingResourcesDir, fRef), 'utf-8'));

        // Diff flag values: each key maps to { value, version, ... } or a primitive
        const allFlags = new Set([...Object.keys(pBody), ...Object.keys(fBody)]);
        for (const flag of allFlags) {
          const pVal = pBody[flag]?.value ?? pBody[flag];
          const fVal = fBody[flag]?.value ?? fBody[flag];
          if (!deepEqual(pVal, fVal)) {
            valuesChanged.push({ flagName: flag, passingValue: pVal, failingValue: fVal });
          }
        }
      } catch {
        valuesChanged.push({
          flagName: '(could not diff -- body read failed)',
          passingBodyRef: pRef,
          failingBodyRef: fRef,
        });
      }
    }
  }

  return { valuesChanged, mockingChanged };
}

// ---------------------------------------------------------------------------
// diffSteps
// ---------------------------------------------------------------------------

/**
 * Compare test step sequences to find the divergence point.
 *
 * @param {object} passingOutline - steps-outline.json from passing trace
 * @param {object} failingOutline - steps-outline.json from failing trace
 */
export function diffSteps(passingOutline, failingOutline) {
  const pActions = passingOutline?.actions || [];
  const fActions = failingOutline?.actions || [];

  let divergencePoint = null;
  const stepsOnlyInPassing = [];
  const stepsOnlyInFailing = [];
  const significantSlowdowns = [];

  const maxLen = Math.max(pActions.length, fActions.length);
  for (let i = 0; i < maxLen; i++) {
    const p = pActions[i];
    const f = fActions[i];

    if (!p && f) {
      stepsOnlyInFailing.push(f.title);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (p && !f) {
      stepsOnlyInPassing.push(p.title);
      // eslint-disable-next-line no-continue
      continue;
    }

    const pTitle = normalizeTitle(p.title);
    const fTitle = normalizeTitle(f.title);

    // Check for divergence (first mismatch)
    if (!divergencePoint) {
      if (pTitle !== fTitle) {
        divergencePoint = {
          index: i,
          passingTitle: p.title,
          failingTitle: f.title,
          passingOutcome: p.error ? 'error' : 'completed',
          failingOutcome: f.error ? `error: ${f.error}` : 'completed',
        };
      } else if (f.error && !p.error) {
        divergencePoint = {
          index: i,
          title: p.title,
          passingOutcome: 'completed',
          failingOutcome: `error: ${f.error}`,
        };
      }
    }

    // Check for significant slowdowns
    if (p.duration_ms && f.duration_ms && f.duration_ms > p.duration_ms * 10 && f.duration_ms > 5000) {
      significantSlowdowns.push({
        title: p.title,
        passingMs: p.duration_ms,
        failingMs: f.duration_ms,
      });
    }
  }

  return { divergencePoint, stepsOnlyInPassing, stepsOnlyInFailing, significantSlowdowns };
}

// ---------------------------------------------------------------------------
// diffConsole
// ---------------------------------------------------------------------------

/**
 * Compare console error entries between passing and failing traces.
 * Returns errors that are new in the failing trace.
 *
 * @param {Array} passingConsole - parsed console.json entries from passing trace
 * @param {Array} failingConsole - parsed console.json entries from failing trace
 */
export function diffConsole(passingConsole, failingConsole) {
  const normalize = (text) => text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/[0-9a-f]{32,}/gi, '<HASH>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<TS>');

  const pErrors = new Set();
  for (const e of passingConsole) {
    if (e.type === 'error') pErrors.add(normalize(e.text));
  }

  const newErrorCounts = new Map();
  for (const e of failingConsole) {
    if (e.type !== 'error') {
      // skip non-error entries
    } else {
      const key = normalize(e.text);
      if (!pErrors.has(key)) {
        if (!newErrorCounts.has(key)) newErrorCounts.set(key, { text: e.text, count: 0 });
        newErrorCounts.get(key).count++;
      }
    }
  }

  const newErrors = [...newErrorCounts.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return { newErrors };
}

// ---------------------------------------------------------------------------
// buildComparison / buildComparisonMarkdown
// ---------------------------------------------------------------------------

/**
 * Assemble all diffs into comparison.json content.
 *
 * @param {object} network - from diffNetwork
 * @param {object} flags - from diffFlags
 * @param {object} steps - from diffSteps
 * @param {object} consoleDiff - from diffConsole
 * @param {object} [paths] - directory paths for drill-down
 * @param {string} [paths.outputDir] - absolute path to the comparison output dir
 * @param {string} [paths.passingResourcesDir] - path to passing trace's resources/
 * @param {string} [paths.failingResourcesDir] - path to failing trace's resources/
 */
export function buildComparisonJson(network, flags, steps, consoleDiff, paths = {}) {
  const parts = [];
  if (network.newFailures.length > 0)
    parts.push(`${network.newFailures.length} API(s) started failing`);
  if (flags.valuesChanged.length > 0)
    parts.push(`${flags.valuesChanged.length} feature flag(s) changed value`);
  if (network.changedResponses.length > 0)
    parts.push(`${network.changedResponses.length} API response(s) changed body`);
  if (steps.divergencePoint)
    parts.push(`test diverged at "${steps.divergencePoint.title || steps.divergencePoint.failingTitle}"`);
  if (consoleDiff.newErrors.length > 0)
    parts.push(`${consoleDiff.newErrors.length} new JS error(s)`);
  if (network.slowedDown.length > 0)
    parts.push(`${network.slowedDown.length} API(s) significantly slower`);

  const summary = parts.length > 0
    ? parts.join('. ') + '.'
    : 'No significant differences found between passing and failing traces.';

  return {
    schemaVersion: 1,
    summary,
    network,
    flags,
    steps,
    console: consoleDiff,
    drillDown: {
      outputDir: paths.outputDir || null,
      passingDir: paths.outputDir ? paths.outputDir + '/passing' : 'passing',
      failingDir: paths.outputDir ? paths.outputDir + '/failing' : 'failing',
      passingSummary: 'passing/summary.json',
      failingSummary: 'failing/summary.json',
      passingResources: paths.passingResourcesDir || null,
      failingResources: paths.failingResourcesDir || null,
    },
  };
}

/**
 * Generate human-readable comparison.md from the comparison data.
 */
export function buildComparisonMarkdown(comparison) {
  const lines = ['# Trace Comparison: passing vs failing', ''];
  lines.push('## Summary', '', comparison.summary, '');

  const { network, flags, steps, console: consoleDiff } = comparison;

  // Network
  const hasNetworkChanges = network.newFailures.length > 0 || network.changedResponses.length > 0 ||
    network.missingCalls.length > 0 || network.newCalls.length > 0 || network.slowedDown.length > 0;
  if (hasNetworkChanges) {
    lines.push('## Network Changes', '');
    for (const f of network.newFailures) {
      lines.push(`- **${f.method} ${f.urlPath}**: was ${f.passingStatus}, now ${f.failingStatus}${f.failingRequestId ? ` (request ID: ${f.failingRequestId})` : ''}`);
    }
    for (const c of network.changedResponses) {
      lines.push(`- **${c.method} ${c.urlPath}**: response body changed (passing: ${c.passingSha1?.slice(0, 12)}, failing: ${c.failingSha1?.slice(0, 12)})`);
    }
    for (const c of network.missingCalls) {
      lines.push(`- **${c.method} ${c.urlPath}**: ${c.note}`);
    }
    for (const c of network.newCalls) {
      lines.push(`- **${c.method} ${c.urlPath}**: ${c.note}`);
    }
    for (const s of network.slowedDown) {
      lines.push(`- **${s.method} ${s.urlPath}**: ${s.passingMs}ms -> ${s.failingMs}ms`);
    }
    lines.push('');
  }

  // Flags
  if (flags.valuesChanged.length > 0 || flags.mockingChanged.length > 0) {
    lines.push('## Feature Flag Changes', '');
    for (const f of flags.valuesChanged) {
      if (f.flagName.startsWith('(')) {
        lines.push(`- ${f.flagName}`);
      } else {
        lines.push(`- \`${f.flagName}\`: ${JSON.stringify(f.passingValue)} -> ${JSON.stringify(f.failingValue)}`);
      }
    }
    for (const m of flags.mockingChanged) {
      lines.push(`- ${m.note}`);
    }
    lines.push('');
  }

  // Steps
  const hasStepChanges = steps.divergencePoint || steps.stepsOnlyInPassing.length > 0 || steps.significantSlowdowns.length > 0;
  if (hasStepChanges) {
    lines.push('## Test Flow Divergence', '');
    if (steps.divergencePoint) {
      const dp = steps.divergencePoint;
      const title = dp.title || dp.failingTitle;
      lines.push(`Test diverged at step ${dp.index} "${title}" (passing: ${dp.passingOutcome}, failing: ${dp.failingOutcome}).`);
    }
    if (steps.stepsOnlyInPassing.length > 0) {
      lines.push(`Steps that never executed in failing: ${steps.stepsOnlyInPassing.join(', ')}`);
    }
    for (const s of steps.significantSlowdowns) {
      lines.push(`- **${s.title}**: ${s.passingMs}ms -> ${s.failingMs}ms (${Math.round(s.failingMs / s.passingMs)}x slower)`);
    }
    lines.push('');
  }

  // Console
  if (consoleDiff.newErrors.length > 0) {
    lines.push('## New Console Errors', '');
    for (const e of consoleDiff.newErrors) {
      lines.push(`- ${e.text.slice(0, 200)} (${e.count} occurrence${e.count > 1 ? 's' : ''})`);
    }
    lines.push('');
  }

  // No changes
  if (comparison.summary.includes('No significant differences')) {
    lines.push('## No Changes Detected', '');
    lines.push('All network calls, feature flags, step sequences, and console output are equivalent between the passing and failing traces. The failure may be caused by:');
    lines.push('- Seed data differences between runs');
    lines.push('- Timing/race condition (flaky test)');
    lines.push('- Non-deterministic ordering');
    lines.push('');
    lines.push('Use `failing/summary.json` for single-trace analysis.');
    lines.push('');
  }

  return lines.join('\n');
}
