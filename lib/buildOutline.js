/**
 * Build steps-outline.json — condensed step tree for understanding the test flow.
 * ~20KB instead of ~200KB. Shows phases, key actions, and errors.
 */

/**
 * @param {Array} cleanSteps - final step array with all refs
 * @returns {object} steps-outline.json content
 */
export function buildStepsOutline(cleanSteps) {
  // Detect phases
  const phases = [];
  let currentPhase = null;

  // Group steps by top-level structure
  const topLevel = cleanSteps.filter(s => !s.parentId);

  for (const step of topLevel) {
    const phase = detectPhase(step);
    if (phase !== currentPhase) {
      phases.push({
        name: phase,
        steps: [],
        stepCount: 0,
        errorCount: 0,
        startedAt: step.startedAt,
      });
      currentPhase = phase;
    }
    const p = phases[phases.length - 1];
    p.stepCount++;

    // Count all descendants
    const descendants = getDescendants(step.id, cleanSteps);
    p.stepCount += descendants.length;
    p.errorCount += descendants.filter(d => d.error).length;
    if (step.error) p.errorCount++;
    p.endedAt = step.endedAt;
  }

  // Build condensed action list (only user-visible steps)
  const actions = cleanSteps
    .filter(s => isUserAction(s))
    .map(s => {
      const entry = {
        id: s.id,
        title: s.title,
        startedAt: s.startedAt,
        duration_ms: s.duration_ms,
      };
      if (s.error) entry.error = s.error.message?.slice(0, 100);
      if (s.screenshot) entry.screenshot = s.screenshot;
      if (s.networkCallsFile) entry.networkCallsFile = s.networkCallsFile;
      return entry;
    });

  // Omission stats
  const omitted = cleanSteps.length - actions.length;

  return {
    schemaVersion: 1,
    totalSteps: cleanSteps.length,
    actionSteps: actions.length,
    omittedSteps: omitted,
    phases,
    actions,
  };
}

function detectPhase(step) {
  if (step.type === 'hook') {
    if (step.title?.includes('Before')) return 'before-hooks';
    if (step.title?.includes('After')) return 'after-hooks';
    return 'hooks';
  }
  if (step.type === 'fixture') return 'fixtures';
  if (step.type === 'test.step') return 'test-body';
  return 'test-body';
}

function isUserAction(step) {
  // Include pw:api and test.step that represent user-visible actions
  if (step.type === 'pw:api') {
    // Skip internal browser API calls
    const title = step.title?.toLowerCase() || '';
    if (title.includes('route') || title.includes('evaluate') || title.includes('wait for load')) {
      return false;
    }
    return true;
  }
  if (step.type === 'test.step') return true;
  return false;
}

function getDescendants(parentId, steps) {
  const children = steps.filter(s => s.parentId === parentId);
  const all = [...children];
  for (const child of children) {
    all.push(...getDescendants(child.id, steps));
  }
  return all;
}
