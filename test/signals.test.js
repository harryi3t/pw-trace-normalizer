import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseNetwork, toNetworkIndexEntry, toNetworkPayload } from '../lib/parseNetwork.js';
import { buildSummary } from '../lib/buildSummary.js';

/**
 * Create a synthetic .network NDJSON line (resource-snapshot entry).
 */
function networkEntry({
  url = 'https://example.com',
  method = 'GET',
  status = 200,
  responseHeaders = [],
  responseSha1 = null,
  startedDateTime = '2025-01-01T00:00:00.000Z',
  time = 50,
} = {}) {
  return JSON.stringify({
    type: 'resource-snapshot',
    snapshot: {
      startedDateTime,
      time,
      pageref: 'page@1',
      request: {
        method,
        url,
        headers: [],
        queryString: [],
      },
      response: {
        status,
        statusText: status >= 400 ? 'Error' : 'OK',
        headers: responseHeaders,
        content: {
          mimeType: 'application/json',
          size: 256,
          _sha1: responseSha1,
        },
      },
    },
  });
}

/**
 * Write a .network file with the given NDJSON entries into tmpDir.
 */
async function writeNetworkFixture(tmpDir, lines) {
  await writeFile(join(tmpDir, '0001.network'), lines.join('\n'));
}

/**
 * Build minimal stubs matching what buildSummary expects.
 */
function makeTraceStub(overrides = {}) {
  return {
    test: { title: 'test > clicks button', status: 'failed', file: 'test.spec.ts' },
    errors: [{ message: 'Timeout 30000ms exceeded.' }],
    console: [],
    ...overrides,
  };
}

function makeStacksStub() {
  return { stacksByCallId: new Map(), warnings: [] };
}

function makeSteps(error = true) {
  return [
    {
      id: 'step@1',
      callId: 'call@1',
      title: 'locator.click',
      type: 'pw:api',
      startedAt: '2025-01-01T00:00:00.000Z',
      duration_ms: 30000,
      parentId: null,
      children: [],
      error: error ? { message: 'Timeout 30000ms exceeded.' } : undefined,
      status: error ? 'failed' : 'passed',
    },
  ];
}

// ─── parseNetwork signal extraction ────────────────────────────────────

describe('parseNetwork — signal extraction', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pw-signal-test-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('classifies URLs as app-api when matching apiDomains', async () => {
    await writeNetworkFixture(tmpDir, [
      networkEntry({ url: 'https://myapp.com/api/users', status: 200 }),
      networkEntry({ url: 'https://cdn.jsdelivr.net/lib.js', status: 200 }),
    ]);

    const result = await parseNetwork(tmpDir, { apiDomains: ['myapp.com/api'] });
    assert.equal(result.calls[0].relevance, 'app-api');
    assert.equal(result.calls[1].relevance, 'third-party');
  });

  it('classifies URLs as feature-flags when ALL flagUrlPatterns match', async () => {
    await writeNetworkFixture(tmpDir, [
      networkEntry({ url: 'https://sdk.launchdarkly.com/evalx/contexts?sdk-key=abc' }),
      networkEntry({ url: 'https://sdk.launchdarkly.com/diagnostic' }),
    ]);

    const signals = {
      flagUrlPatterns: ['launchdarkly.com', 'evalx', 'sdk-key'],
    };
    const result = await parseNetwork(tmpDir, signals);

    assert.equal(result.calls[0].relevance, 'feature-flags');
    assert.equal(result.calls[1].relevance, 'third-party',
      'URL missing some patterns should NOT be classified as feature-flags');
  });

  it('extracts requestId from 4xx/5xx responses when requestIdHeader is set', async () => {
    await writeNetworkFixture(tmpDir, [
      networkEntry({
        url: 'https://myapp.com/api/submit',
        status: 500,
        responseHeaders: [{ name: 'x-request-id', value: 'abc-123' }],
      }),
      networkEntry({
        url: 'https://myapp.com/api/data',
        status: 200,
        responseHeaders: [{ name: 'x-request-id', value: 'def-456' }],
      }),
    ]);

    const result = await parseNetwork(tmpDir, { requestIdHeader: 'x-request-id' });

    assert.equal(result.calls[0].requestId, 'abc-123');
    assert.equal(result.calls[1].requestId, undefined,
      'Should not extract requestId from 200 responses');
    assert.equal(result.failuresWithRequestIds.length, 1);
    assert.equal(result.failuresWithRequestIds[0].requestId, 'abc-123');
  });

  it('splits semicolon-delimited requestId header values', async () => {
    await writeNetworkFixture(tmpDir, [
      networkEntry({
        url: 'https://myapp.com/api/action',
        status: 502,
        responseHeaders: [{ name: 'x-req-id', value: 'prefix;actual-id-789' }],
      }),
    ]);

    const result = await parseNetwork(tmpDir, { requestIdHeader: 'x-req-id' });
    assert.equal(result.calls[0].requestId, 'actual-id-789');
  });

  it('detects feature flag eval requests and stores bodyRef', async () => {
    const sha1 = 'a1b2c3d4e5f6';
    await writeNetworkFixture(tmpDir, [
      networkEntry({
        url: 'https://sdk.launchdarkly.com/evalx/contexts?sdk-key=test',
        status: 200,
        responseSha1: sha1,
      }),
    ]);

    const result = await parseNetwork(tmpDir, {
      flagUrlPatterns: ['launchdarkly.com', 'evalx', 'sdk-key'],
    });

    assert.equal(result.flagEvals.length, 1);
    assert.equal(result.flagEvals[0].bodyRef, sha1);
    assert.equal(result.calls[0].isFlagEval, true);
  });

  it('extracts apiBodyRefs for 200 app-api calls with sha1', async () => {
    const sha1 = 'deadbeef1234';
    await writeNetworkFixture(tmpDir, [
      networkEntry({
        url: 'https://myapp.com/api/users',
        status: 200,
        responseSha1: sha1,
      }),
      networkEntry({
        url: 'https://myapp.com/api/users',
        status: 404,
        responseSha1: 'notincluded',
      }),
    ]);

    const result = await parseNetwork(tmpDir, { apiDomains: ['myapp.com/api'] });

    assert.equal(result.apiBodyRefs.length, 1, 'Only 200 responses should produce apiBodyRefs');
    assert.equal(result.apiBodyRefs[0].bodyRef, sha1);
  });

  it('sorts failures by relevance: app-api first, third-party last', async () => {
    await writeNetworkFixture(tmpDir, [
      networkEntry({ url: 'https://cdn.example.com/x.js', status: 500 }),
      networkEntry({ url: 'https://myapp.com/api/data', status: 500 }),
      networkEntry({ url: 'https://sdk.launchdarkly.com/evalx/sdk-key', status: 500 }),
    ]);

    const result = await parseNetwork(tmpDir, {
      apiDomains: ['myapp.com/api'],
      flagUrlPatterns: ['launchdarkly.com', 'evalx', 'sdk-key'],
    });

    assert.equal(result.failures.length, 3);
    assert.equal(result.failures[0].relevance, 'app-api');
    assert.equal(result.failures[1].relevance, 'feature-flags');
    assert.equal(result.failures[2].relevance, 'third-party');
  });

  it('returns empty signal arrays when no signals config is provided', async () => {
    await writeNetworkFixture(tmpDir, [
      networkEntry({ url: 'https://myapp.com/api/data', status: 500 }),
    ]);

    const result = await parseNetwork(tmpDir);

    assert.deepEqual(result.failuresWithRequestIds, []);
    assert.deepEqual(result.flagEvals, []);
    assert.deepEqual(result.apiBodyRefs, []);
  });

  it('all calls are third-party when no signals config is given', async () => {
    await writeNetworkFixture(tmpDir, [
      networkEntry({ url: 'https://myapp.com/api/users', status: 200 }),
      networkEntry({ url: 'https://cdn.example.com/lib.js', status: 200 }),
    ]);

    const result = await parseNetwork(tmpDir);
    for (const call of result.calls) {
      assert.equal(call.relevance, 'third-party');
    }
  });

  it('no .network files → returns empty signal arrays alongside empty calls', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'pw-empty-'));
    try {
      const result = await parseNetwork(emptyDir, {
        apiDomains: ['myapp.com'],
        requestIdHeader: 'x-request-id',
      });
      assert.deepEqual(result.calls, []);
      assert.deepEqual(result.failuresWithRequestIds, []);
      assert.deepEqual(result.flagEvals, []);
      assert.deepEqual(result.apiBodyRefs, []);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

// ─── toNetworkIndexEntry / toNetworkPayload — signal fields ────────────

describe('toNetworkIndexEntry — signal fields', () => {
  const basecall = {
    callId: 'req-0001',
    method: 'POST',
    url: 'https://myapp.com/api/submit',
    status: 500,
    startedAt: '2025-01-01T00:00:00.000Z',
    duration_ms: 120,
    frameRef: 'page@1',
    relevance: 'app-api',
    requestParams: { queryString: {}, body: null },
    _request: { method: 'POST', url: 'https://myapp.com/api/submit', headers: [], queryString: [] },
    _response: { status: 500, statusText: 'Error', headers: [] },
    _responseSha1: null,
    _responseMimeType: 'application/json',
    _responseSize: 0,
  };

  it('includes relevance in index entry', () => {
    const entry = toNetworkIndexEntry(basecall);
    assert.equal(entry.relevance, 'app-api');
  });

  it('includes requestId when present', () => {
    const entry = toNetworkIndexEntry({ ...basecall, requestId: 'rid-123' });
    assert.equal(entry.requestId, 'rid-123');
  });

  it('omits requestId when absent', () => {
    const entry = toNetworkIndexEntry(basecall);
    assert.equal(entry.requestId, undefined);
  });

  it('includes isFlagEval when present', () => {
    const entry = toNetworkIndexEntry({ ...basecall, isFlagEval: true });
    assert.equal(entry.isFlagEval, true);
  });

  it('includes apiBodyRef when present', () => {
    const entry = toNetworkIndexEntry({ ...basecall, apiBodyRef: 'sha-abc' });
    assert.equal(entry.apiBodyRef, 'sha-abc');
  });
});

describe('toNetworkPayload — signal fields', () => {
  const basecall = {
    callId: 'req-0001',
    method: 'POST',
    url: 'https://myapp.com/api/submit',
    status: 500,
    startedAt: '2025-01-01T00:00:00.000Z',
    duration_ms: 120,
    frameRef: 'page@1',
    relevance: 'app-api',
    requestParams: { queryString: {}, body: null },
    _request: { method: 'POST', url: 'https://myapp.com/api/submit', headers: [], queryString: [] },
    _response: { status: 500, statusText: 'Error', headers: [] },
    _responseSha1: null,
    _responseMimeType: 'application/json',
    _responseSize: 0,
  };

  it('includes relevance in payload', () => {
    const payload = toNetworkPayload(basecall);
    assert.equal(payload.relevance, 'app-api');
  });

  it('includes requestId in payload when present', () => {
    const payload = toNetworkPayload({ ...basecall, requestId: 'rid-456' });
    assert.equal(payload.requestId, 'rid-456');
  });

  it('includes flagBodyRef in payload for flag evals', () => {
    const payload = toNetworkPayload({ ...basecall, isFlagEval: true, flagBodyRef: 'sha-flag' });
    assert.equal(payload.isFlagEval, true);
    assert.equal(payload.flagBodyRef, 'sha-flag');
  });

  it('includes apiBodyRef in payload when present', () => {
    const payload = toNetworkPayload({ ...basecall, apiBodyRef: 'sha-api' });
    assert.equal(payload.apiBodyRef, 'sha-api');
  });
});

// ─── buildSummary — signal integration ─────────────────────────────────

describe('buildSummary — signals', () => {
  function makeNetwork(overrides = {}) {
    return {
      calls: [],
      failures: [],
      failuresWithRequestIds: [],
      flagEvals: [],
      apiBodyRefs: [],
      warnings: [],
      ...overrides,
    };
  }

  it('includes signals section when signal data is present', () => {
    const network = makeNetwork({
      failuresWithRequestIds: [
        { callId: 'req-0001', url: 'https://myapp.com/api/x', status: 500, requestId: 'rid-1' },
      ],
    });

    const summary = buildSummary(makeTraceStub(), network, makeStacksStub(), makeSteps());
    assert.ok(summary.signals, 'Expected signals section in summary');
    assert.equal(summary.signals.hasApiFailures, true);
    assert.equal(summary.signals.failuresWithRequestIds.length, 1);
    assert.equal(summary.drillDown.signals, 'network/signals.json');
  });

  it('omits signals section when no signal data exists', () => {
    const network = makeNetwork();
    const summary = buildSummary(makeTraceStub(), network, makeStacksStub(), makeSteps());
    assert.equal(summary.signals, undefined);
    assert.equal(summary.drillDown.signals, undefined);
  });

  it('includes flagEvals in signals and marks hasUnmockedFlags', () => {
    const network = makeNetwork({
      flagEvals: [
        { callId: 'req-0005', url: 'https://launchdarkly.com/evalx', status: 200, bodyRef: 'sha-ld' },
      ],
    });

    const summary = buildSummary(makeTraceStub(), network, makeStacksStub(), makeSteps());
    assert.equal(summary.signals.hasUnmockedFlags, true);
    assert.equal(summary.signals.flagEvals.length, 1);
  });

  it('includes apiBodyRefs in signals', () => {
    const network = makeNetwork({
      apiBodyRefs: [
        { callId: 'req-0003', url: 'https://myapp.com/api/data', bodyRef: 'sha-api' },
      ],
    });

    const summary = buildSummary(makeTraceStub(), network, makeStacksStub(), makeSteps());
    assert.equal(summary.signals.apiBodyRefs.length, 1);
  });

  it('adds feature flag root cause hint when flagEvals present', () => {
    const network = makeNetwork({
      flagEvals: [
        { callId: 'req-0010', url: 'https://ld.com/evalx', status: 200, bodyRef: null },
        { callId: 'req-0011', url: 'https://ld.com/evalx', status: 200, bodyRef: null },
      ],
    });

    const summary = buildSummary(makeTraceStub(), network, makeStacksStub(), makeSteps());
    const flagHint = summary.rootCauseHints.find(h => h.includes('feature flag'));
    assert.ok(flagHint, 'Expected a feature flag root cause hint');
    assert.ok(flagHint.includes('2'), 'Hint should mention the count');
  });

  it('filters network failures to app-api/feature-flags when available', () => {
    const network = makeNetwork({
      failures: [
        { callId: 'req-0001', method: 'GET', url: 'https://cdn.com/x', status: 500, relevance: 'third-party', startedAt: '2025-01-01T00:00:00Z', duration_ms: 10 },
        { callId: 'req-0002', method: 'POST', url: 'https://myapp.com/api/y', status: 500, relevance: 'app-api', startedAt: '2025-01-01T00:00:01Z', duration_ms: 20 },
      ],
    });

    const summary = buildSummary(makeTraceStub(), network, makeStacksStub(), makeSteps());
    assert.equal(summary.networkFailures.length, 1,
      'Should only include app-api failures when relevant ones exist');
    assert.equal(summary.networkFailures[0].relevance, 'app-api');
  });

  it('falls back to all failures when no app-api/feature-flags failures exist', () => {
    const network = makeNetwork({
      failures: [
        { callId: 'req-0001', method: 'GET', url: 'https://cdn.com/x', status: 404, relevance: 'third-party', startedAt: '2025-01-01T00:00:00Z', duration_ms: 10 },
      ],
    });

    const summary = buildSummary(makeTraceStub(), network, makeStacksStub(), makeSteps());
    assert.equal(summary.networkFailures.length, 1);
    assert.equal(summary.networkFailures[0].relevance, 'third-party');
  });
});

describe('buildSummary — errorContext', () => {
  function makeNetwork() {
    return {
      calls: [], failures: [], failuresWithRequestIds: [],
      flagEvals: [], apiBodyRefs: [], warnings: [],
    };
  }

  it('includes errorContext when provided in options', () => {
    const ctx = '## Error context\nThe login button is broken after deploy #1234.';
    const summary = buildSummary(
      makeTraceStub(), makeNetwork(), makeStacksStub(), makeSteps(),
      { errorContext: ctx },
    );
    assert.equal(summary.errorContext, ctx);
  });

  it('omits errorContext when not provided', () => {
    const summary = buildSummary(
      makeTraceStub(), makeNetwork(), makeStacksStub(), makeSteps(),
    );
    assert.equal(summary.errorContext, undefined);
  });

  it('omits errorContext when null', () => {
    const summary = buildSummary(
      makeTraceStub(), makeNetwork(), makeStacksStub(), makeSteps(),
      { errorContext: null },
    );
    assert.equal(summary.errorContext, undefined);
  });
});
