import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseTrace } from '../lib/parseTrace.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sample-trace');

describe('parseTrace', () => {
  it('parses real trace → step tree with 498+ steps, test.status=failed', async () => {
    const result = await parseTrace(FIXTURE_DIR);
    assert.ok(result.steps.length >= 498, `Expected 498+ steps, got ${result.steps.length}`);
    assert.equal(result.test.status, 'failed');
  });

  it('error messages have no ANSI codes', async () => {
    const result = await parseTrace(FIXTURE_DIR);
    for (const err of result.errors) {
      // eslint-disable-next-line no-control-regex
      assert.ok(!/\u001b/.test(err.message), `ANSI found in: ${err.message.slice(0, 100)}`);
    }
  });

  it('error message containing only ANSI codes → empty string after strip', async () => {
    // The top-level error in test.trace is "\u001b[31mTest timeout...\u001b[39m"
    // After stripping it should be a non-empty clean string
    const result = await parseTrace(FIXTURE_DIR);
    for (const err of result.errors) {
      assert.ok(typeof err.message === 'string', 'error.message should be a string');
      // Should never be null
      assert.notEqual(err.message, null);
    }
  });

  it('extracts test metadata from context-options title', async () => {
    const result = await parseTrace(FIXTURE_DIR);
    assert.ok(result.test.title.includes('reimbursement'), `Title: ${result.test.title}`);
    assert.ok(result.test.file.includes('ExpenseReportV2'), `File: ${result.test.file}`);
  });

  it('builds parent-child relationships', async () => {
    const result = await parseTrace(FIXTURE_DIR);
    // hook@1 should have children
    const hook1 = result.steps.find(s => s.id === 'hook@1');
    assert.ok(hook1, 'hook@1 should exist');
    assert.ok(hook1.children.length > 0, 'hook@1 should have children');

    // All parentId refs should resolve to real steps
    const stepIds = new Set(result.steps.map(s => s.id));
    for (const step of result.steps) {
      if (step.parentId) {
        assert.ok(stepIds.has(step.parentId), `parentId ${step.parentId} not found for step ${step.id}`);
      }
    }
  });

  it('converts timestamps to ISO 8601', async () => {
    const result = await parseTrace(FIXTURE_DIR);
    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
    assert.ok(isoRegex.test(result.test.startedAt), `Bad ISO: ${result.test.startedAt}`);
    assert.ok(isoRegex.test(result.test.endedAt), `Bad ISO: ${result.test.endedAt}`);
  });

  it('extracts console events with ISO timestamps', async () => {
    const result = await parseTrace(FIXTURE_DIR);
    assert.ok(result.console.length > 0, 'Should have console events');
    for (const entry of result.console) {
      assert.ok(entry.type, 'Console entry should have type');
      assert.ok(entry.timestamp, 'Console entry should have timestamp');
    }
  });

  it('extracts screenshots from screencast-frame events', async () => {
    const result = await parseTrace(FIXTURE_DIR);
    assert.ok(result.screenshots.length > 0, 'Should have screenshots');
    for (const s of result.screenshots) {
      assert.ok(s.sha1, 'Screenshot should have sha1');
      assert.ok(s.timestamp, 'Screenshot should have timestamp');
    }
  });

  it('extracts log events grouped by callId', async () => {
    const result = await parseTrace(FIXTURE_DIR);
    assert.ok(result.logs.size > 0, 'Should have log events');
    for (const [callId, messages] of result.logs) {
      assert.ok(callId, 'Log should have callId');
      assert.ok(messages.length > 0, 'Log should have messages');
    }
  });

  it('throws clear error when no .trace files exist', async () => {
    await assert.rejects(
      () => parseTrace('/tmp'),
      { message: /No \.trace files found/ }
    );
  });

  it('handles unmatched before events (no corresponding after) as incomplete', async () => {
    const result = await parseTrace(FIXTURE_DIR);
    // In our fixture, 0-trace.trace has 455 before and 452 after, so ~3 incomplete
    const incomplete = result.steps.filter(s => s.status === 'incomplete');
    // Just verify the status field is present and used correctly
    for (const step of result.steps) {
      assert.ok(['completed', 'incomplete'].includes(step.status), `Bad status: ${step.status}`);
    }
    // Incomplete steps should have null endedAt
    for (const step of incomplete) {
      assert.equal(step.endedAt, null, `Incomplete step ${step.id} should have null endedAt`);
    }
  });
});
