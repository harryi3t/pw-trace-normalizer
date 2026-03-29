#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { transformTrace, compareTraces } from './index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    compare: { type: 'boolean', default: false },
    'no-overwrite': { type: 'boolean', default: false },
    'include-secrets': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`Usage:
  pw-trace-transform <trace-folder-or-zip> [--output <dir>]
  pw-trace-transform --compare <passing> <failing> [--output <dir>]

Options:
  --output, -o       Output directory (default: <input>-output)
  --compare          Compare two traces (passing vs failing)
  --no-overwrite     Error if output directory exists
  --include-secrets  Include sensitive headers (Cookie, Authorization, etc.)
  --help, -h         Show this help
`);
  process.exit(values.help ? 0 : 1);
}

async function main() {
  try {
    if (values.compare) {
      if (positionals.length < 2) {
        console.error('Error: --compare requires two trace folders (passing and failing)');
        process.exit(1);
      }
      await compareTraces(positionals[0], positionals[1], values.output, {
        noOverwrite: values['no-overwrite'],
      });
    } else {
      const { outputDir, warnings } = await transformTrace(positionals[0], values.output, {
        noOverwrite: values['no-overwrite'],
        includeSecrets: values['include-secrets'],
      });
      if (warnings.length > 0) {
        for (const w of warnings) {
          console.error(`[warn] ${w}`);
        }
      }
      console.log(`Output written to: ${outputDir}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
