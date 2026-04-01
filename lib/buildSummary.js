/**
 * Build summary.json — a single-file entry point for AI agents.
 * ~5-8KB, contains everything needed to diagnose most failures without reading anything else.
 */

/**
 * @param {object} trace - from parseTrace()
 * @param {object} network - from parseNetwork()
 * @param {object} stacks - from parseStacks()
 * @param {Array} cleanSteps - final step array with screenshot/dom/network/stack refs
 * @param {object} [options]
 * @param {string|null} [options.errorContext] - content of error-context.md
 * @returns {object} summary.json content
 */
export function buildSummary(trace, network, stacks, cleanSteps, options = {}) {
  const errorSteps = cleanSteps.filter(s => s.error);
  const primaryError = errorSteps.length > 0 ? errorSteps[errorSteps.length - 1] : null;

  // Classify failure type from error message
  const failureType = primaryError ? classifyFailure(primaryError.error.message) : null;

  // Condense the call log in the error message (strip repeated retry lines)
  const condensedError = primaryError ? {
    stepId: primaryError.id,
    stepTitle: primaryError.title,
    message: condensCallLog(primaryError.error.message),
    fullMessage: primaryError.error.message,
    startedAt: primaryError.startedAt,
    duration_ms: primaryError.duration_ms,
    parentId: primaryError.parentId,
    screenshot: primaryError.screenshot,
    domSnapshot: primaryError.domSnapshot,
    stackFile: primaryError.stackFile,
    networkCallsFile: primaryError.networkCallsFile,
  } : null;

  // Build user flow (action steps only, condensed)
  const userFlow = buildUserFlow(cleanSteps);

  // Network failure summary — only app-api and feature-flags relevance (filter CDN/analytics noise)
  const relevantFailures = network.failures.filter(f =>
    f.relevance === 'app-api' || f.relevance === 'feature-flags'
  );
  const networkFailures = (relevantFailures.length > 0 ? relevantFailures : network.failures).map(f => ({
    callId: f.callId,
    method: f.method,
    url: truncateUrl(f.url),
    status: f.status,
    relevance: f.relevance,
    startedAt: f.startedAt,
    duration_ms: f.duration_ms,
  }));

  // Group network failures by URL pattern
  const failurePatterns = groupNetworkFailures(network.failures);

  // Console error summary
  const consoleSummary = buildConsoleSummary(trace.console);

  // Root cause hints
  const rootCauseHints = extractRootCauseHints(
    primaryError?.error?.message,
    network.failures,
    trace.console,
    network
  );

  // File pointers for deeper investigation
  const drillDown = {
    fullIndex: 'index.json',
    failureTimeline: 'failure-timeline.json',
    stepsOutline: 'steps-outline.json',
    networkIndex: 'network/index.json',
    networkFailures: 'network/failures.json',
    console: 'console.jsonl',
  };

  if (primaryError?.stackFile) {
    drillDown.errorStack = primaryError.stackFile;
  }
  if (primaryError?.networkCallsFile) {
    drillDown.errorNetworkCalls = primaryError.networkCallsFile;
  }

  // Signal summary (from --api-domains / --flag-url-pattern / --request-id-header)
  const hasSignals = network.failuresWithRequestIds.length > 0
    || network.flagEvals.length > 0
    || network.apiBodyRefs.length > 0;

  if (hasSignals) {
    drillDown.signals = 'network/signals.json';
  }

  const result = {
    schemaVersion: 1,
    test: trace.test,
    failureType,
    primaryError: condensedError,
    allErrors: trace.errors,
    errorStepCount: errorSteps.length,
    totalSteps: cleanSteps.length,
    networkFailures,
    failurePatterns,
    consoleSummary,
    rootCauseHints,
    userFlow,
    drillDown,
  };

  if (hasSignals) {
    result.signals = {
      failuresWithRequestIds: network.failuresWithRequestIds,
      flagEvals: network.flagEvals,
      apiBodyRefs: network.apiBodyRefs,
      hasUnmockedFlags: network.flagEvals.length > 0,
      hasApiFailures: network.failuresWithRequestIds.length > 0,
    };
  }

  if (options.errorContext) {
    result.errorContext = options.errorContext;
  }

  return result;
}

function classifyFailure(message) {
  if (!message) return 'unknown';
  const m = message.toLowerCase();
  if (m.includes('timeout') && m.includes('exceeded')) return 'timeout';
  if (m.includes('intercepts pointer events')) return 'element-blocked';
  if (m.includes('element is not visible')) return 'element-not-visible';
  if (m.includes('element is not attached')) return 'element-detached';
  if (m.includes('navigation')) return 'navigation-error';
  if (m.includes('net::err_')) return 'network-error';
  if (m.includes('strict mode violation')) return 'multiple-elements';
  if (m.includes('waiting for selector')) return 'selector-timeout';
  return 'unknown';
}

function condensCallLog(message) {
  if (!message) return message;
  // Strip repeated "waiting for element..." retry blocks
  // Keep first occurrence and count
  const lines = message.split('\n');
  const seen = new Map();
  const condensed = [];
  let retryCount = 0;

  for (const line of lines) {
    const trimmed = line.replace(/^\s+/, '').replace(/\d+ ×/, 'N ×');
    if (seen.has(trimmed)) {
      retryCount++;
      continue;
    }
    seen.set(trimmed, true);
    condensed.push(line);
  }

  if (retryCount > 0) {
    condensed.push(`  ... (${retryCount} repeated retry lines omitted)`);
  }

  // Cap at 1000 chars
  const result = condensed.join('\n');
  if (result.length > 1000) {
    return result.slice(0, 1000) + '\n  ... (truncated)';
  }
  return result;
}

function buildUserFlow(steps) {
  // Filter to user-visible action steps (not hooks/fixtures)
  const actionTypes = new Set(['pw:api', 'test.step']);
  const actions = steps.filter(s =>
    actionTypes.has(s.type) && !s.parentId?.startsWith('hook@') && !s.parentId?.startsWith('fixture@')
  );

  // Take top-level actions only (no parentId, or parent is a hook/step)
  const topLevel = actions.filter(s => !s.parentId || !actions.some(a => a.id === s.parentId));

  // Condense to max 30 steps
  const flow = topLevel.slice(0, 30).map(s => ({
    id: s.id,
    title: s.title,
    startedAt: s.startedAt,
    duration_ms: s.duration_ms,
    error: s.error ? true : undefined,
  }));

  if (topLevel.length > 30) {
    flow.push({ omitted: topLevel.length - 30 });
  }

  return flow;
}

function buildConsoleSummary(consoleEntries) {
  const byType = { error: 0, warning: 0, log: 0, debug: 0 };
  const uniqueErrors = new Map();

  for (const entry of consoleEntries) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;

    if (entry.type === 'error' || entry.type === 'warning') {
      // Normalize for dedup (strip UUIDs, hashes, timestamps)
      const key = entry.text
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
        .replace(/[0-9a-f]{32,}/gi, '<HASH>')
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<TIMESTAMP>');

      if (!uniqueErrors.has(key)) {
        uniqueErrors.set(key, { text: entry.text, count: 0, firstSeen: entry.timestamp, source: entry.source });
      }
      uniqueErrors.get(key).count++;
    }
  }

  return {
    total: consoleEntries.length,
    byType,
    uniqueErrors: [...uniqueErrors.values()].sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

function groupNetworkFailures(failures) {
  const patterns = new Map();
  for (const f of failures) {
    let urlPath;
    try { urlPath = new URL(f.url).pathname; } catch { urlPath = f.url; }
    const key = `${f.status}:${urlPath}`;
    if (!patterns.has(key)) {
      patterns.set(key, { urlPattern: urlPath, status: f.status, count: 0, callIds: [] });
    }
    patterns.get(key).count++;
    patterns.get(key).callIds.push(f.callId);
  }
  return [...patterns.values()];
}

function truncateUrl(url) {
  if (url.length <= 120) return url;
  return url.slice(0, 120) + '...';
}

function extractRootCauseHints(errorMessage, networkFailures, consoleEntries, network) {
  const hints = [];

  if (errorMessage?.includes('intercepts pointer events')) {
    hints.push('UI overlay (snackbar, modal, tooltip) is blocking the target element. Check for error toasts or popups.');
  }

  if (networkFailures.length > 0) {
    const statuses = [...new Set(networkFailures.map(f => f.status))];
    hints.push(`${networkFailures.length} network failures (HTTP ${statuses.join(', ')}). API errors may trigger UI error states that block interaction.`);
  }

  if (errorMessage?.includes('timeout') && errorMessage?.includes('exceeded')) {
    hints.push('Test timed out. Look for slow API responses, infinite loading states, or elements that never become actionable.');
  }

  const consoleErrors = consoleEntries.filter(e => e.type === 'error');
  if (consoleErrors.length > 0) {
    hints.push(`${consoleErrors.length} console errors detected. JavaScript exceptions may prevent UI from reaching expected state.`);
  }

  if (network.flagEvals?.length > 0) {
    hints.push(`${network.flagEvals.length} feature flag eval request(s) detected. Unmocked flags may cause unexpected UI behavior if values changed.`);
  }

  return hints;
}
