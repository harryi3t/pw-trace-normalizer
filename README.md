# pw-trace-normalizer

Transform Playwright trace ZIPs into AI-friendly normalized output for fast failure diagnosis.

Raw Playwright traces are large, SHA1-hashed blobs of NDJSON that are hard for AI to navigate. `pw-trace-normalizer` converts them into a structured directory with human-readable files — cutting AI analysis time by **3×** compared to raw traces.

## Install

```bash
npm install -g pw-trace-normalizer
# or use directly with npx (no install needed)
npx pw-trace-normalizer <trace.zip>
```

## Usage

```bash
# Transform a trace ZIP
pw-trace-normalizer trace.zip

# Custom output directory
pw-trace-normalizer trace.zip --output ./my-output

# Include sensitive headers (Cookie, Authorization)
pw-trace-normalizer trace.zip --include-secrets

# Don't overwrite existing output
pw-trace-normalizer trace.zip --no-overwrite
```

## Output structure

```
<output-dir>/
├── summary.json          # Primary error, failure type, user flow, root cause hints
├── failure-timeline.json # ±30s of events around each error, correlated network calls
├── steps-outline.json    # All test steps condensed by phase (hooks / test-body)
├── index.json            # Full step tree with all metadata
├── console.json          # All console messages (log / warn / error)
├── dom/                  # HTML snapshots per step (pw_api_42.html, ...)
├── network/
│   ├── index.json        # All network calls with sequential IDs (req-0001, ...)
│   ├── failures.json     # 4xx / 5xx calls only
│   └── req-NNNN.json     # Full request + response per call
├── screenshots/          # Renamed screenshots (stepId-before-001.jpeg, ...)
├── logs/                 # Raw call logs per step
└── stacks/               # Stack frames per network call
```

## AI analysis

The output is designed for Claude Code (or any AI) to diagnose failures fast. Point it at the output directory:

> "Read summary.json, then failure-timeline.json, and diagnose the root cause of this test failure."

**Typical diagnosis time:** ~2.5 min / 25–35 tool calls vs ~7.5 min / 45–56 tool calls for raw traces.

## Library API

```js
import { transformTrace, compareTraces } from 'pw-trace-normalizer';

// Transform a single trace
const { outputDir, warnings } = await transformTrace('./trace.zip', './output', {
  noOverwrite: false,
  includeSecrets: false,
});

// Compare a passing trace vs a failing trace
await compareTraces('./passing.zip', './failing.zip', './diff-output');
```

## How it works

1. Extracts the trace ZIP to a temp directory
2. Streams all `.trace` NDJSON files to build a step tree
3. Streams `.network` NDJSON to extract and index network calls
4. Parses `.stacks` for stack frame enrichment
5. Converts DOM blob snapshots into readable HTML
6. Renames SHA1 screenshots to human-readable filenames
7. Pre-computes `summary.json`, `failure-timeline.json`, and `steps-outline.json` so AI starts with the answer, not the raw data

## License

MIT
