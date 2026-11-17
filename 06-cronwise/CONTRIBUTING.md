# Contributing

Thanks for helping! The library is small on purpose. Most of the value is in being **correct**, so tests come first.

## Setup

```bash
npm install
npm test            # unit tests + brute-force oracle (about 30 s)
npm run typecheck
npm run build && node scripts/smoke.mjs   # test the artifacts users will receive
npm run cli -- next "*/15 9-17 * * 1-5" --tz Europe/Madrid
```

Requires Node 20+ for development (the published package supports Node 18+).

## How the tests are organised

| File | What it protects |
|---|---|
| `test/parse.test.ts` | Syntax, error positions and hints |
| `test/schedule.test.ts` | Concrete, hand-checked examples (leap days, `L`/`W`/`#`, DST in several zones) |
| `test/oracle.test.ts` | **Brute-force oracle**: walks every real minute with independent code and compares with `between()`/`matches()` for hundreds of random expressions, in UTC and across real DST transitions of 6 zones |
| `test/explain-lint-cli.test.ts` | Plain-language output (EN/ES), lint rules, CLI behaviour and exit codes |
| `test/dist.test.ts` | The built ESM/CJS/CLI/type declarations |

If you change scheduling logic, the oracle must still pass. If you change semantics on purpose, update the oracle's
reference implementation **and** the "Semantics" section of the README, and add a CHANGELOG entry (breaking).

## Pull requests

- One logical change per PR, with tests. Bug fixes should start with a failing test.
- Keep the library dependency-free.
- New explanation languages: add a `Words` table in `src/explain.ts` and a table of cases in the tests.
- Update `CHANGELOG.md` under *Unreleased*.
