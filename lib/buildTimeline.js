/**
 * Build failure-timeline.json — time-windowed context around each error step.
 * Gives the agent everything near the failure without reading the full index.
 */

/**
 * @param {Array} cleanSteps - final step array
 * @param {Array} networkCalls - from parseNetwork().calls
 * @param {Array} consoleEntries - from parseTrace().console
 * @returns {object} failure-timeline.json content
 */
export function buildFailureTimeline(cleanSteps, networkCalls, consoleEntries) {
  const errorSteps = cleanSteps.filter(s => s.error);

  if (errorSteps.length === 0) {
    return { schemaVersion: 1, failures: [], note: 'No error steps found.' };
  }

  // Sort steps chronologically
  const sorted = [...cleanSteps].sort((a, b) =>
    (a.startedAt || '').localeCompare(b.startedAt || '')
  );

  const failures = errorSteps.map(errorStep => {
    const idx = sorted.findIndex(s => s.id === errorStep.id);

    // Window: 20 steps before, 10 after
    const windowStart = Math.max(0, idx - 20);
    const windowEnd = Math.min(sorted.length, idx + 11);
    const stepsWindow = sorted.slice(windowStart, windowEnd).map(s => ({
      id: s.id,
      title: s.title,
      type: s.type,
      startedAt: s.startedAt,
      duration_ms: s.duration_ms,
      error: s.error ? true : undefined,
      isErrorStep: s.id === errorStep.id ? true : undefined,
    }));

    // Time window: 10s before error start, 10s after error end
    const errorStartMs = errorStep.startedAt ? new Date(errorStep.startedAt).getTime() : null;
    const errorEndMs = errorStep.endedAt ? new Date(errorStep.endedAt).getTime() : null;
    const timeWindowStartMs = errorStartMs ? errorStartMs - 10000 : null;
    const timeWindowEndMs = (errorEndMs || errorStartMs) ? (errorEndMs || errorStartMs) + 10000 : null;

    // Network calls in the time window (failures first, cap at 30 total)
    let networkWindow = [];
    if (timeWindowStartMs && timeWindowEndMs) {
      const inWindow = networkCalls.filter(c => {
        if (!c.startedAt) return false;
        const ms = new Date(c.startedAt).getTime();
        return ms >= timeWindowStartMs && ms <= timeWindowEndMs;
      });
      const toEntry = c => ({
        callId: c.callId,
        method: c.method,
        url: c.url.length > 120 ? c.url.slice(0, 120) + '...' : c.url,
        status: c.status,
        startedAt: c.startedAt,
        duration_ms: c.duration_ms,
        isFailed: c.status >= 400 || c.status === 0,
      });
      // Prioritize failures, then cap at 30
      const failures = inWindow.filter(c => c.status >= 400 || c.status === 0).map(toEntry);
      const others = inWindow.filter(c => c.status < 400 && c.status !== 0).slice(0, 30 - failures.length).map(toEntry);
      networkWindow = [...failures, ...others];
      if (inWindow.length > networkWindow.length) {
        networkWindow.push({ _omitted: inWindow.length - networkWindow.length, note: 'non-failure calls omitted' });
      }
    }

    // Console entries in the time window
    let consoleWindow = [];
    if (timeWindowStartMs && timeWindowEndMs) {
      consoleWindow = consoleEntries
        .filter(e => {
          if (!e.timestamp) return false;
          const ms = new Date(e.timestamp).getTime();
          return ms >= timeWindowStartMs && ms <= timeWindowEndMs;
        })
        .map(e => ({
          type: e.type,
          text: e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text,
          timestamp: e.timestamp,
        }));
    }

    // Walk parent chain
    const parentChain = [];
    let currentId = errorStep.parentId;
    const stepMap = new Map(cleanSteps.map(s => [s.id, s]));
    while (currentId && parentChain.length < 10) {
      const parent = stepMap.get(currentId);
      if (!parent) break;
      parentChain.push({ id: parent.id, title: parent.title, type: parent.type });
      currentId = parent.parentId;
    }

    return {
      errorStep: {
        id: errorStep.id,
        title: errorStep.title,
        type: errorStep.type,
        startedAt: errorStep.startedAt,
        endedAt: errorStep.endedAt,
        duration_ms: errorStep.duration_ms,
        error: errorStep.error ? {
          message: errorStep.error.message?.length > 500
            ? errorStep.error.message.slice(0, 500) + '... (truncated, see index.json for full)'
            : errorStep.error.message,
          name: errorStep.error.name,
        } : null,
        screenshot: errorStep.screenshot,
        domSnapshot: errorStep.domSnapshot,
        stackFile: errorStep.stackFile,
        networkCallsFile: errorStep.networkCallsFile,
      },
      parentChain,
      stepsWindow,
      networkWindow,
      consoleWindow,
    };
  });

  return { schemaVersion: 1, failures };
}
