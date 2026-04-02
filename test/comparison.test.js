import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  diffNetwork,
  diffFlags,
  diffSteps,
  diffConsole,
  buildComparisonJson,
  buildComparisonMarkdown,
} from '../lib/buildComparison.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function networkCall({
  callId = 'req-0001',
  method = 'GET',
  url = 'http://localhost:8001/api/v1/test',
  status = 200,
  duration_ms = 100,
  relevance = 'app-api',
  requestId = undefined,
  apiBodyRef = undefined,
} = {}) {
  const call = { callId, method, url, status, duration_ms, relevance, startedAt: '2025-01-01T00:00:00Z', requestParams: {} };
  if (requestId) call.requestId = requestId;
  if (apiBodyRef) call.apiBodyRef = apiBodyRef;
  return call;
}

function consoleEntry({ type = 'error', text = 'some error' } = {}) {
  return { type, text, timestamp: '2025-01-01T00:00:00Z' };
}

function stepAction({ title = 'page.goto /test', duration_ms = 100, error = undefined } = {}) {
  const s = { id: 'step-1', title, startedAt: '2025-01-01T00:00:00Z', duration_ms };
  if (error) s.error = error;
  return s;
}

// ---------------------------------------------------------------------------
// diffNetwork
// ---------------------------------------------------------------------------

describe('diffNetwork', () => {
  it('detects new API failures (200 in passing, 500 in failing)', () => {
    const passing = [networkCall({ status: 200 })];
    const failing = [networkCall({ status: 500, requestId: 'abc-123' })];
    const result = diffNetwork(passing, failing);
    assert.equal(result.newFailures.length, 1);
    assert.equal(result.newFailures[0].passingStatus, 200);
    assert.equal(result.newFailures[0].failingStatus, 500);
    assert.equal(result.newFailures[0].failingRequestId, 'abc-123');
  });

  it('detects missing calls (present in passing, absent in failing)', () => {
    const passing = [networkCall({ url: 'http://localhost:8001/api/v1/data' })];
    const failing = [];
    const result = diffNetwork(passing, failing);
    assert.equal(result.missingCalls.length, 1);
    assert.ok(result.missingCalls[0].note.includes('present in passing'));
  });

  it('detects new calls (present in failing, absent in passing)', () => {
    const passing = [];
    const failing = [networkCall({ url: 'http://localhost:8001/api/v1/new-endpoint' })];
    const result = diffNetwork(passing, failing);
    assert.equal(result.newCalls.length, 1);
    assert.ok(result.newCalls[0].note.includes('present in failing'));
  });

  it('detects changed response bodies (same URL, different apiBodyRef)', () => {
    const passing = [networkCall({ apiBodyRef: 'sha-pass' })];
    const failing = [networkCall({ apiBodyRef: 'sha-fail' })];
    const result = diffNetwork(passing, failing);
    assert.equal(result.changedResponses.length, 1);
    assert.equal(result.changedResponses[0].passingSha1, 'sha-pass');
    assert.equal(result.changedResponses[0].failingSha1, 'sha-fail');
  });

  it('detects no changes when traces are identical', () => {
    const calls = [networkCall(), networkCall({ callId: 'req-0002', url: 'http://localhost:8001/api/v1/other' })];
    const result = diffNetwork(calls, calls);
    assert.equal(result.newFailures.length, 0);
    assert.equal(result.missingCalls.length, 0);
    assert.equal(result.newCalls.length, 0);
    assert.equal(result.changedResponses.length, 0);
    assert.equal(result.slowedDown.length, 0);
  });

  it('skips third-party calls', () => {
    const passing = [networkCall({ relevance: 'third-party', url: 'https://cdn.example.com/font.woff' })];
    const failing = [];
    const result = diffNetwork(passing, failing);
    assert.equal(result.missingCalls.length, 0);
  });

  it('detects significant slowdowns', () => {
    const passing = [networkCall({ duration_ms: 500 })];
    const failing = [networkCall({ duration_ms: 5000 })];
    const result = diffNetwork(passing, failing);
    assert.equal(result.slowedDown.length, 1);
    assert.equal(result.slowedDown[0].passingMs, 500);
    assert.equal(result.slowedDown[0].failingMs, 5000);
  });

  it('does not flag small slowdowns', () => {
    const passing = [networkCall({ duration_ms: 100 })];
    const failing = [networkCall({ duration_ms: 200 })];
    const result = diffNetwork(passing, failing);
    assert.equal(result.slowedDown.length, 0);
  });

  it('handles same URL called multiple times with mixed statuses', () => {
    const passing = [
      networkCall({ callId: 'req-0001', status: 200 }),
      networkCall({ callId: 'req-0002', status: 200 }),
    ];
    const failing = [
      networkCall({ callId: 'req-0001', status: 200 }),
      networkCall({ callId: 'req-0002', status: 500 }),
    ];
    const result = diffNetwork(passing, failing);
    assert.equal(result.newFailures.length, 1);
    assert.equal(result.newFailures[0].failingStatus, 500);
  });
});

// ---------------------------------------------------------------------------
// diffFlags
// ---------------------------------------------------------------------------

describe('diffFlags', () => {
  it('returns empty when both have no flag evals', async () => {
    const result = await diffFlags(null, null, '/tmp', '/tmp');
    assert.equal(result.valuesChanged.length, 0);
    assert.equal(result.mockingChanged.length, 0);
  });

  it('detects mocking status change', async () => {
    const passing = { flagEvals: [{ mocked: false, bodyRef: 'sha1' }] };
    const failing = { flagEvals: [{ mocked: true, bodyRef: null }] };
    const result = await diffFlags(passing, failing, '/tmp', '/tmp');
    assert.equal(result.mockingChanged.length, 1);
    assert.ok(result.mockingChanged[0].note.includes('unmocked in passing'));
  });

  it('diffs flag values when bodyRefs differ', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'flag-diff-'));
    const passingRes = join(tmpDir, 'passing-resources');
    const failingRes = join(tmpDir, 'failing-resources');
    await mkdir(passingRes, { recursive: true });
    await mkdir(failingRes, { recursive: true });

    await writeFile(join(passingRes, 'flags-pass.json'), JSON.stringify({
      'flag-a': { value: false, version: 1 },
      'flag-b': { value: true, version: 2 },
    }));
    await writeFile(join(failingRes, 'flags-fail.json'), JSON.stringify({
      'flag-a': { value: true, version: 3 },
      'flag-b': { value: true, version: 2 },
    }));

    const passing = { flagEvals: [{ mocked: false, bodyRef: 'flags-pass.json' }] };
    const failing = { flagEvals: [{ mocked: false, bodyRef: 'flags-fail.json' }] };
    const result = await diffFlags(passing, failing, passingRes, failingRes);

    assert.equal(result.valuesChanged.length, 1);
    assert.equal(result.valuesChanged[0].flagName, 'flag-a');
    assert.equal(result.valuesChanged[0].passingValue, false);
    assert.equal(result.valuesChanged[0].failingValue, true);

    await rm(tmpDir, { recursive: true });
  });

  it('handles body read failure gracefully', async () => {
    const passing = { flagEvals: [{ mocked: false, bodyRef: 'nonexistent.json' }] };
    const failing = { flagEvals: [{ mocked: false, bodyRef: 'also-nonexistent.json' }] };
    const result = await diffFlags(passing, failing, '/tmp/no-such-dir', '/tmp/no-such-dir');
    assert.equal(result.valuesChanged.length, 1);
    assert.ok(result.valuesChanged[0].flagName.includes('could not diff'));
  });

  it('returns empty when bodyRefs are the same', async () => {
    const passing = { flagEvals: [{ mocked: false, bodyRef: 'same-sha.json' }] };
    const failing = { flagEvals: [{ mocked: false, bodyRef: 'same-sha.json' }] };
    const result = await diffFlags(passing, failing, '/tmp', '/tmp');
    assert.equal(result.valuesChanged.length, 0);
  });
});

// ---------------------------------------------------------------------------
// diffSteps
// ---------------------------------------------------------------------------

describe('diffSteps', () => {
  it('finds divergence point when failing step has error', () => {
    const passing = { actions: [stepAction({ title: 'page.goto /test' }), stepAction({ title: 'click button' })] };
    const failing = { actions: [stepAction({ title: 'page.goto /test' }), stepAction({ title: 'click button', error: 'timeout exceeded' })] };
    const result = diffSteps(passing, failing);
    assert.ok(result.divergencePoint);
    assert.equal(result.divergencePoint.index, 1);
    assert.equal(result.divergencePoint.passingOutcome, 'completed');
    assert.ok(result.divergencePoint.failingOutcome.includes('timeout'));
  });

  it('finds divergence point when titles differ', () => {
    const passing = { actions: [stepAction({ title: 'page.goto /dashboard' })] };
    const failing = { actions: [stepAction({ title: 'page.goto /login' })] };
    const result = diffSteps(passing, failing);
    assert.ok(result.divergencePoint);
    assert.equal(result.divergencePoint.index, 0);
    assert.equal(result.divergencePoint.passingTitle, 'page.goto /dashboard');
    assert.equal(result.divergencePoint.failingTitle, 'page.goto /login');
  });

  it('detects steps only in passing (test did not get that far)', () => {
    const passing = { actions: [stepAction({ title: 'step 1' }), stepAction({ title: 'step 2' }), stepAction({ title: 'step 3' })] };
    const failing = { actions: [stepAction({ title: 'step 1' })] };
    const result = diffSteps(passing, failing);
    assert.deepEqual(result.stepsOnlyInPassing, ['step 2', 'step 3']);
  });

  it('returns no divergence for identical steps', () => {
    const actions = { actions: [stepAction(), stepAction({ title: 'click' })] };
    const result = diffSteps(actions, actions);
    assert.equal(result.divergencePoint, null);
    assert.equal(result.stepsOnlyInPassing.length, 0);
    assert.equal(result.stepsOnlyInFailing.length, 0);
  });

  it('normalizes URLs before comparison', () => {
    const passing = { actions: [stepAction({ title: 'page.goto https://host-a.com/dashboard?id=123' })] };
    const failing = { actions: [stepAction({ title: 'page.goto https://host-b.com/dashboard?id=456' })] };
    const result = diffSteps(passing, failing);
    assert.equal(result.divergencePoint, null, 'Normalized titles should match');
  });

  it('detects significant slowdowns', () => {
    const passing = { actions: [stepAction({ title: 'page.goto /test', duration_ms: 1000 })] };
    const failing = { actions: [stepAction({ title: 'page.goto /test', duration_ms: 25000 })] };
    const result = diffSteps(passing, failing);
    assert.equal(result.significantSlowdowns.length, 1);
  });
});

// ---------------------------------------------------------------------------
// diffConsole
// ---------------------------------------------------------------------------

describe('diffConsole', () => {
  it('finds new errors in failing trace', () => {
    const passing = [consoleEntry({ text: 'old error' })];
    const failing = [consoleEntry({ text: 'old error' }), consoleEntry({ text: 'new error' })];
    const result = diffConsole(passing, failing);
    assert.equal(result.newErrors.length, 1);
    assert.equal(result.newErrors[0].text, 'new error');
    assert.equal(result.newErrors[0].count, 1);
  });

  it('returns empty when all errors existed in passing', () => {
    const entries = [consoleEntry({ text: 'same error' })];
    const result = diffConsole(entries, entries);
    assert.equal(result.newErrors.length, 0);
  });

  it('ignores non-error entries', () => {
    const passing = [];
    const failing = [consoleEntry({ type: 'log', text: 'not an error' })];
    const result = diffConsole(passing, failing);
    assert.equal(result.newErrors.length, 0);
  });

  it('counts multiple occurrences of the same new error', () => {
    const passing = [];
    const failing = [
      consoleEntry({ text: 'TypeError: foo' }),
      consoleEntry({ text: 'TypeError: foo' }),
      consoleEntry({ text: 'TypeError: foo' }),
    ];
    const result = diffConsole(passing, failing);
    assert.equal(result.newErrors.length, 1);
    assert.equal(result.newErrors[0].count, 3);
  });

  it('normalizes UUIDs and timestamps for dedup', () => {
    const passing = [consoleEntry({ text: 'Error for user 550e8400-e29b-41d4-a716-446655440000' })];
    const failing = [consoleEntry({ text: 'Error for user 660f9511-f39c-52e5-b827-557766551111' })];
    const result = diffConsole(passing, failing);
    assert.equal(result.newErrors.length, 0, 'Same error with different UUIDs should match');
  });
});

// ---------------------------------------------------------------------------
// buildComparisonJson / buildComparisonMarkdown
// ---------------------------------------------------------------------------

describe('buildComparisonJson', () => {
  it('generates summary from non-empty diffs', () => {
    const network = { newFailures: [{ method: 'GET', urlPath: '/api' }], missingCalls: [], newCalls: [], changedResponses: [], slowedDown: [] };
    const flags = { valuesChanged: [{ flagName: 'test-flag' }], mockingChanged: [] };
    const steps = { divergencePoint: null, stepsOnlyInPassing: [], stepsOnlyInFailing: [], significantSlowdowns: [] };
    const consoleDiff = { newErrors: [] };
    const result = buildComparisonJson(network, flags, steps, consoleDiff);
    assert.ok(result.summary.includes('1 API(s) started failing'));
    assert.ok(result.summary.includes('1 feature flag(s) changed'));
    assert.equal(result.schemaVersion, 1);
  });

  it('generates no-differences summary when all empty', () => {
    const empty = { newFailures: [], missingCalls: [], newCalls: [], changedResponses: [], slowedDown: [] };
    const result = buildComparisonJson(empty, { valuesChanged: [], mockingChanged: [] }, { divergencePoint: null, stepsOnlyInPassing: [], stepsOnlyInFailing: [], significantSlowdowns: [] }, { newErrors: [] });
    assert.ok(result.summary.includes('No significant differences'));
  });
});

describe('buildComparisonMarkdown', () => {
  it('generates no-changes section when all diffs empty', () => {
    const comparison = buildComparisonJson(
      { newFailures: [], missingCalls: [], newCalls: [], changedResponses: [], slowedDown: [] },
      { valuesChanged: [], mockingChanged: [] },
      { divergencePoint: null, stepsOnlyInPassing: [], stepsOnlyInFailing: [], significantSlowdowns: [] },
      { newErrors: [] }
    );
    const md = buildComparisonMarkdown(comparison);
    assert.ok(md.includes('No Changes Detected'));
    assert.ok(md.includes('failing/summary.json'));
  });

  it('includes all diff sections when present', () => {
    const comparison = buildComparisonJson(
      { newFailures: [{ method: 'GET', urlPath: '/api/test', passingStatus: 200, failingStatus: 500, failingRequestId: 'abc' }], missingCalls: [], newCalls: [], changedResponses: [], slowedDown: [] },
      { valuesChanged: [{ flagName: 'my-flag', passingValue: false, failingValue: true }], mockingChanged: [] },
      { divergencePoint: { index: 5, title: 'click button', passingOutcome: 'completed', failingOutcome: 'error: timeout' }, stepsOnlyInPassing: [], stepsOnlyInFailing: [], significantSlowdowns: [] },
      { newErrors: [{ text: 'TypeError: foo', count: 2 }] }
    );
    const md = buildComparisonMarkdown(comparison);
    assert.ok(md.includes('Network Changes'));
    assert.ok(md.includes('was 200, now 500'));
    assert.ok(md.includes('Feature Flag Changes'));
    assert.ok(md.includes('`my-flag`'));
    assert.ok(md.includes('Test Flow Divergence'));
    assert.ok(md.includes('click button'));
    assert.ok(md.includes('New Console Errors'));
    assert.ok(md.includes('TypeError: foo'));
  });
});
