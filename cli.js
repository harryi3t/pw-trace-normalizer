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
    'error-context': { type: 'string' },
    'api-domains': { type: 'string' },
    'flag-url-pattern': { type: 'string' },
    'request-id-header': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`Usage:
  pw-trace-normalizer <trace-folder-or-zip> [--output <dir>] [signal options]
  pw-trace-normalizer --compare <passing> <failing> [--output <dir>]

Options:
  --output, -o            Output directory (default: <input>-output)
  --compare               Compare two traces (passing vs failing)
  --no-overwrite          Error if output directory exists
  --include-secrets       Include sensitive headers (Cookie, Authorization, etc.)
  --error-context <path>  Path to error-context.md to include in summary
  --help, -h              Show this help

Signal extraction (enables network/signals.json + summary.signals):
  --api-domains <list>        Comma-separated URL substrings identifying app API calls
                              (e.g. "myapp.com/api,localhost")
  --flag-url-pattern <list>   Comma-separated URL substrings that must ALL match to detect
                              feature flag eval requests (e.g. "launchdarkly.com,evalx,sdk-key")
  --request-id-header <name>  Response header name to extract request IDs from on 4xx/5xx
                              (e.g. "x-request-id")
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
      // Build signals config from CLI flags
      const signals = {};
      if (values['api-domains']) {
        signals.apiDomains = values['api-domains'].split(',').map(s => s.trim()).filter(Boolean);
      }
      if (values['flag-url-pattern']) {
        signals.flagUrlPatterns = values['flag-url-pattern'].split(',').map(s => s.trim()).filter(Boolean);
      }
      if (values['request-id-header']) {
        signals.requestIdHeader = values['request-id-header'];
      }

      const { outputDir, warnings } = await transformTrace(positionals[0], values.output, {
        noOverwrite: values['no-overwrite'],
        includeSecrets: values['include-secrets'],
        errorContextPath: values['error-context'],
        signals: Object.keys(signals).length > 0 ? signals : undefined,
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
