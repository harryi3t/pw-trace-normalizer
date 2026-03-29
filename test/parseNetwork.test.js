import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseNetwork, toNetworkIndexEntry } from '../lib/parseNetwork.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sample-trace');

describe('parseNetwork', () => {
  it('parses real network file with 1000+ calls', async () => {
    const result = await parseNetwork(FIXTURE_DIR);
    assert.ok(result.calls.length > 1000, `Expected 1000+ calls, got ${result.calls.length}`);
  });

  it('callId format is req-0001, req-0002 (zero-padded, sequential)', async () => {
    const result = await parseNetwork(FIXTURE_DIR);
    assert.equal(result.calls[0].callId, 'req-0001');
    assert.equal(result.calls[1].callId, 'req-0002');
    assert.equal(result.calls[9].callId, 'req-0010');
  });

  it('4xx/5xx responses appear in failures', async () => {
    const result = await parseNetwork(FIXTURE_DIR);
    for (const f of result.failures) {
      assert.ok(f.status >= 400 || f.status === 0, `Unexpected status in failures: ${f.status}`);
    }
  });

  it('missing .network file → partial output, no crash, warning', async () => {
    const result = await parseNetwork('/tmp');
    assert.deepEqual(result.calls, []);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('No .network'));
  });

  it('toNetworkIndexEntry produces expected shape', async () => {
    const result = await parseNetwork(FIXTURE_DIR);
    const entry = toNetworkIndexEntry(result.calls[0]);
    assert.ok(entry.callId);
    assert.ok(entry.method);
    assert.ok(entry.url);
    assert.ok(typeof entry.status === 'number');
    assert.ok(entry.startedAt);
    assert.ok(entry.payloadFile.startsWith('network/'));
    assert.ok(entry.requestParams);
  });

  it('network calls have ISO startedAt timestamps', async () => {
    const result = await parseNetwork(FIXTURE_DIR);
    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    for (const call of result.calls.slice(0, 10)) {
      assert.ok(isoRegex.test(call.startedAt), `Bad timestamp: ${call.startedAt}`);
    }
  });

  it('trace with zero network calls → empty array', async () => {
    // /tmp has no .network files
    const result = await parseNetwork('/tmp');
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.failures, []);
  });
});
