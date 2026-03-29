import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Parse .stacks NDJSON files and return stack data correlated by callId.
 *
 * Stacks file format:
 * Single JSON object with:
 *   { files: [filepath, ...], stacks: [[callId, [[fileIdx, line, col, fnName], ...]], ...] }
 *
 * @param {string} traceDir - path to the unzipped trace folder
 * @returns {{ stacksByCallId: Map<number, Array<{file, line, col, fn}>>, warnings: string[] }}
 */
export async function parseStacks(traceDir) {
  const dirFiles = await readdir(traceDir);
  const stackFiles = dirFiles.filter(f => f.endsWith('.stacks')).sort();
  const warnings = [];

  if (stackFiles.length === 0) {
    warnings.push('No .stacks files found; stack output will be empty');
    return { stacksByCallId: new Map(), warnings };
  }

  const stacksByCallId = new Map();

  for (const sf of stackFiles) {
    let content;
    try {
      content = await readFile(join(traceDir, sf), 'utf-8');
    } catch (err) {
      warnings.push(`Failed to read ${sf}: ${err.message}`);
      continue;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      warnings.push(`${sf} is empty`);
      continue;
    }

    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      warnings.push(`Failed to parse ${sf} as JSON`);
      continue;
    }

    const fileIndex = data.files || [];
    const stacks = data.stacks || [];

    for (const [callId, frames] of stacks) {
      const resolved = frames.map(([fileIdx, line, col, fn]) => ({
        file: fileIndex[fileIdx] || `<unknown file ${fileIdx}>`,
        line,
        col,
        fn: fn || '',
      }));
      stacksByCallId.set(callId, resolved);
    }
  }

  return { stacksByCallId, warnings };
}
