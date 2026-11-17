# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/). **A change in DST or day-matching semantics is a breaking change** and
will bump the major version, because it changes when people's jobs run.

## [Unreleased]

## [0.1.0] - 2026-11-17

Initial release.

### Added
- `parse()` for 5-field expressions and, optionally, a leading seconds field; macros (`@daily`, `@hourly`, ...);
  month and weekday names; `?`; Quartz-style extensions `L`, `LW`, `nW`, `n#k`, `nL`.
- Parse errors (`CronParseError`) with the exact character range of the culprit, the field name, a ready-to-print
  `format()` with a caret, and a `hint` (wrap-around ranges, typos in names, `*/0`, 6-field input...).
- `Schedule#next`, `nextRuns`, `between`, `iterate` and `matches`, time-zone aware with IANA zones.
- Explicit DST semantics: `dstGap: 'shift' | 'skip'` for nonexistent times; fixed local hours run once in a repeated
  hour while wildcard hours run at every real instant.
- `explain()` in English and Spanish, 24 h or 12 h.
- `lint()` for valid-but-risky expressions (never runs, day-of-month/day-of-week OR trap, DST danger zone, ...).
- `validate()` that never throws.
- `cronwise` CLI: `next`, `between`, `explain`, `validate`, `lint`; `--json`; stdin; documented exit codes.
- ESM and CommonJS builds with TypeScript declarations. Zero runtime dependencies.
