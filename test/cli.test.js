import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'cli.js');
const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sample-trace');

describe('CLI integration', () => {
  const outputDir = '/tmp/pw-trace-cli-test-output';

  before(() => {
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true });
    }
  });

  after(() => {
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true });
    }
  });

  it('node cli.js <dir> --output exits 0 and creates index.json', () => {
    const result = execSync(`node ${CLI} ${FIXTURE_DIR} --output ${outputDir}`, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    assert.ok(result.includes('Output written to'), result);
    assert.ok(existsSync(join(outputDir, 'index.json')));

    // Verify index.json is valid JSON with expected fields
    const index = JSON.parse(readFileSync(join(outputDir, 'index.json'), 'utf-8'));
    assert.equal(index.test.status, 'failed');
    assert.equal(index.schemaVersion, 1);
    assert.ok(index.steps.length > 0);
  });

  it('--no-overwrite with existing dir exits non-zero', () => {
    // outputDir exists from previous test
    assert.throws(
      () => execSync(`node ${CLI} ${FIXTURE_DIR} --output ${outputDir} --no-overwrite`, {
        encoding: 'utf-8',
        timeout: 30000,
      }),
      (err) => {
        assert.ok(err.stderr.includes('already exists') || err.stdout.includes('already exists'),
          `Expected "already exists" error, got: ${err.stderr}`);
        return true;
      }
    );
  });

  it('--help exits 0', () => {
    const result = execSync(`node ${CLI} --help`, { encoding: 'utf-8' });
    assert.ok(result.includes('Usage'));
  });

  it('network/index.json and network/failures.json exist and are valid JSON', () => {
    // Re-create output if cleaned up
    if (!existsSync(outputDir)) {
      execSync(`node ${CLI} ${FIXTURE_DIR} --output ${outputDir}`, { timeout: 30000 });
    }

    const networkIndex = JSON.parse(readFileSync(join(outputDir, 'network', 'index.json'), 'utf-8'));
    assert.ok(Array.isArray(networkIndex));
    assert.ok(networkIndex.length > 0);

    const failures = JSON.parse(readFileSync(join(outputDir, 'network', 'failures.json'), 'utf-8'));
    assert.ok(Array.isArray(failures));
  });

  it('steps with @ in callId use _ in filenames', () => {
    if (!existsSync(outputDir)) {
      execSync(`node ${CLI} ${FIXTURE_DIR} --output ${outputDir}`, { timeout: 30000 });
    }

    const index = JSON.parse(readFileSync(join(outputDir, 'index.json'), 'utf-8'));
    // Find a step with @ in id
    const stepWithAt = index.steps.find(s => s.id.includes('@'));
    assert.ok(stepWithAt, 'Should have steps with @ in id');

    // If it has a stackFile, the filename should use _
    if (stepWithAt.stackFile) {
      assert.ok(!stepWithAt.stackFile.includes('@'), `Filename should not contain @: ${stepWithAt.stackFile}`);
    }
  });
});

describe('compareTraces', () => {
  it('compareTraces() with non-existent dirs throws (failing trace must exist)', async () => {
    const { compareTraces } = await import('../index.js');
    await assert.rejects(
      () => compareTraces('/tmp/no-such-dir-pass', '/tmp/no-such-dir-fail'),
      (err) => err instanceof Error
    );
  });
});
