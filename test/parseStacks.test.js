import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseStacks } from '../lib/parseStacks.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sample-trace');

describe('parseStacks', () => {
  it('parses real stacks file and resolves file paths', async () => {
    const result = await parseStacks(FIXTURE_DIR);
    assert.ok(result.stacksByCallId.size > 0, 'Should have stack entries');

    // Check a known entry: callId 2119 should resolve to featureFlagMockHelpers.ts
    const stack = result.stacksByCallId.get(2119);
    assert.ok(stack, 'callId 2119 should exist');
    assert.ok(stack[0].file.includes('featureFlagMockHelpers'), `File: ${stack[0].file}`);
    assert.equal(stack[0].fn, 'mockLDFlags');
    assert.ok(typeof stack[0].line === 'number');
    assert.ok(typeof stack[0].col === 'number');
  });

  it('missing .stacks file → warning, empty map', async () => {
    const result = await parseStacks('/tmp');
    assert.equal(result.stacksByCallId.size, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('No .stacks'));
  });

  it('resolves multiple frames per callId', async () => {
    const result = await parseStacks(FIXTURE_DIR);
    // callId 2135 has multiple frames (addCookies -> login)
    const stack = result.stacksByCallId.get(2135);
    assert.ok(stack, 'callId 2135 should exist');
    assert.ok(stack.length >= 2, `Expected 2+ frames, got ${stack.length}`);
  });
});
