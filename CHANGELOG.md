# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-03-30

### Added
- Core trace transformer: parses Playwright trace ZIPs into AI-navigable output directories
- `parseTrace` — streams `test.trace` / `0-trace.trace` NDJSON, builds step tree with before/after events, extracts errors, console logs, and screenshots
- `parseNetwork` — streams `0-trace.network` HAR NDJSON, assigns sequential call IDs (`req-0001`), extracts failures (status ≥ 400), redacts `Cookie` / `Authorization` headers by default
- `parseStacks` — parses `0-trace.stacks` into a `Map<callId, frames>` for stack enrichment
- `serializeDom` — converts Playwright's DOM tree arrays into readable HTML snapshots
- `renameResources` — assigns human-readable names to screenshots (`stepId-before-001.jpeg`) using timestamp window matching with 500ms nearest-step fallback
- `buildSummary` — writes `summary.json` with test metadata, primary error, failure classification, user flow (top 30 actions), network failure patterns, console summary, root cause hints, and drill-down file pointers
- `buildTimeline` — writes `failure-timeline.json` with a ±20/10 step window around each error, correlated network calls, and console entries
- `buildOutline` — writes `steps-outline.json` with phase detection (before-hooks / test-body / after-hooks) and condensed action-only step list
- CLI (`pw-trace-normalizer`) with `--output`, `--no-overwrite`, `--include-secrets`, and `--compare` flags
- Library API: `transformTrace(inputPath, outputDir?, options?)` and `compareTraces(passing, failing, outputDir?, options?)`
- ZIP extraction via `unzip` with `mkdtemp` for safe temp directory handling
- Security: shell injection prevention (`execFileSync`), path traversal sanitization, header redaction

[Unreleased]: https://github.com/harryi3t/pw-trace-normalizer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/harryi3t/pw-trace-normalizer/releases/tag/v0.1.0
