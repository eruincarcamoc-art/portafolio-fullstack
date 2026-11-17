# cronwise

**Cron expressions done right.** Precise parse errors, schedules that stay correct across **daylight-saving changes**, plain-language explanations in **English and Spanish**, and a linter for expressions that are valid but wrong. Library + CLI, **zero dependencies**, ESM and CommonJS, fully typed.

```bash
$ cronwise explain "*/15 9-17 * * 1-5"
Every 15 minutes, between 09:00 and 17:59, on Monday through Friday

$ cronwise next "30 2 * * *" --tz America/New_York --from 2026-03-07T12:00 -n 3
30 2 * * *  — At 02:30, every day (America/New_York)
1. 2026-03-08 03:00:00 -04:00 (Sun)      ← 02:30 does not exist on this night; see "Semantics"
2. 2026-03-09 02:30:00 -04:00 (Mon)
3. 2026-03-10 02:30:00 -04:00 (Tue)

$ cronwise validate "*/5 61 * * *"
error: hour: value 61 is out of range (0-23)
  */5 61 * * *
      ^^
```

## Why

Cron looks trivial until it ships. The bugs that hurt are the quiet ones: a job that silently does not run on the
night the clocks change, `0 0 13 * 5` that runs on *every Friday* (not only Friday the 13th), `0 0 30 2 *` that never
runs, a typo that is accepted and means something else. cronwise makes those cases **explicit, documented and tested**.

## Install

```bash
npm install cronwise          # library
npx cronwise --help           # CLI
```

Node ≥ 18. No dependencies. Works wherever `Intl.DateTimeFormat` supports IANA time zones (Node, Deno, Bun, modern browsers).

## Library

```ts
import { parse, explain, validate, lint, CronParseError } from 'cronwise';

const schedule = parse('0 9 * * MON-FRI', { tz: 'Europe/Madrid' });

schedule.next(new Date());                       // Date | null  (null = never runs)
schedule.nextRuns(5);                            // next 5 runs from now
schedule.between(from, to, { limit: 1000 });     // runs in (from, to]
schedule.matches(new Date());                    // is this instant inside a scheduled run?
for (const d of schedule.iterate()) { /* lazy, infinite */ }
schedule.explain({ locale: 'es' });              // "A las 09:00, de lunes a viernes"

explain('@daily');                               // "At 00:00, every day"
lint('0 0 13 * 5');                              // [{ code: 'dom-dow-or', severity: 'warning', message: ... }]

// validate() never throws: ideal for forms and APIs
const r = validate('61 * * * *');
if (!r.valid) console.log(r.error.formatted, r.error.start, r.error.end, r.error.hint);

try { parse('0 22-2 * * *'); }
catch (e) {
  if (e instanceof CronParseError) console.log(e.format());
  // hour: range start 22 is greater than range end 2
  //   0 22-2 * * *
  //     ^^^^
  //   hint: ranges cannot wrap around; write it as a list: 22-23,0-2
}
```

### `parse(expression, options?)`

| Option | Default | Meaning |
|---|---|---|
| `tz` | `'UTC'` | IANA time zone (`'America/New_York'`). Unknown zones throw `TimezoneError`. |
| `seconds` | `false` | The expression has 6 fields and the **first** is seconds. |
| `dstGap` | `'shift'` | What to do with a local time that does not exist (see below): `'shift'` or `'skip'`. |

### Syntax

| Field | Allowed values | Special |
|---|---|---|
| second *(optional, first)* | 0-59 | `* , - /` |
| minute | 0-59 | `* , - /` |
| hour | 0-23 | `* , - /` |
| day of month | 1-31 | `* , - / ?` `L` `LW` `nW` |
| month | 1-12 or `JAN`-`DEC` | `* , - /` |
| day of week | 0-7 or `SUN`-`SAT` (0 and 7 are Sunday) | `* , - / ?` `nL` `n#k` |

Macros: `@yearly` `@annually` `@monthly` `@weekly` `@daily` `@midnight` `@hourly`.
Steps: `*/15`, `10-30/5`, and `5/15` (= `5-59/15`). Names are case-insensitive.

Quartz-style extensions (always available, flagged by `lint` as non-portable):
`L` last day of the month · `LW` last weekday · `15W` weekday nearest the 15th, never leaving the month ·
`FRI#3` third Friday · `5L`/`FRIL` last Friday.

Not supported (and rejected with a clear message, not silently misread): wrap-around ranges (`FRI-MON`; write
`FRI-SAT,SUN-MON`), a year field, `@reboot`, `H` hash symbols, sub-second resolution.

## Semantics (the part most schedulers leave implicit)

### Day of month vs. day of week
If **both** are restricted, the job runs when **either** matches (classic cron). If either is `*` (including `*/n`),
both must match. `0 0 13 * 5` therefore runs on every 13th **and** every Friday; `lint` warns about it.

### Daylight-saving time

Local wall-clock times can be **missing** (spring forward) or **repeated** (fall back). cronwise follows Vixie cron /
cronie and documents the rest:

| Situation | Rule |
|---|---|
| Time **inside the gap** (`30 2 * * *` on the night 02:00 → 03:00) | `dstGap: 'shift'` *(default)*: runs at the first valid instant after the gap (03:00). Several skipped times collapse into **one** run. `'skip'`: that day does not run. |
| **Fixed hour** in a repeated hour (`30 1 * * *`) | Runs **once**, the first time. |
| **Wildcard hour** in a repeated hour (`0 * * * *`, `*/20 * * * *`) | Runs at **every real instant**: the cadence never breaks and nothing repeats or is skipped. |
| Times outside the transition | Unaffected. |

Works for any IANA zone, including a **30-minute DST shift** (`Australia/Lord_Howe`) and zones such as `Asia/Kolkata`
(+05:30) and `Asia/Kathmandu` (+05:45).

### Other details
`next()` is **strictly after** `from`. It looks at most **9 years** ahead (29 February can take 8 years: 2096 → 2104)
and returns `null` if nothing matches. `matches()` compares at the resolution of the schedule: without `seconds`,
`09:30:42` matches `30 9 * * *`.

## Plain-language explanations

```ts
explain('0 0 1,15 * *');                       // At 00:00, on days 1 and 15 of the month
explain('0 0 * * 5#3');                        // At 00:00, on the third Friday of the month
explain('0 0 13 * 5');                         // At 00:00, on day 13 of the month or on Friday   ← the OR is visible
explain('30 15 * * *', { hour12: true });      // At 3:30 PM, every day
explain('0 9 * * 1-5', { locale: 'es' });      // A las 09:00, de lunes a viernes
explain('*/20 * * * * *', { seconds: true });  // Every 20 seconds
```

## Lint

| Code | Severity | Catches |
|---|---|---|
| `never-runs` | error | `0 0 30 2 *`, `0 0 31 4 *` |
| `dom-dow-or` | warning | both day fields set → "either", not "both" |
| `dst-ambiguous-hour` | warning | fixed time between 01:00 and 03:59 in a zone that observes DST |
| `skips-short-months` | warning | `0 0 31 * *` silently skips 5 months (use `L`) |
| `high-frequency` / `every-minute` | warning / info | sub-2-minute cadences |
| `non-portable` | info | `L`, `W`, `#` are not supported by classic cron |

## CLI

```
cronwise <command> "<expression>" [options]

  next       cronwise next "*/15 9-17 * * 1-5" -n 5 --tz America/New_York
  between    cronwise between "0 9 * * 1" --from 2026-03-01 --to 2026-04-01
  explain    cronwise explain "0 0 1,15 * *" --locale es
  validate   cronwise validate "61 * * * *"            # exit 1 + caret
  lint       cronwise lint "0 0 13 * 5"

  --tz <zone>   --seconds   --dst <shift|skip>   -n/--count <n>   --from <time>   --to <time>
  --locale <en|es>   --12h   --json   --no-color   -h/--help   -v/--version
  echo "*/5 * * * *" | cronwise explain -          # read from stdin
```

Times without an offset (`2026-03-08T09:00`) are read **in `--tz`**. Colors follow `NO_COLOR`.
Exit codes: `0` success · `1` invalid expression / lint error / never runs · `2` usage error.
`--json` gives stable, machine-readable output.

## How it is tested

Correctness here is about edge cases that are easy to get wrong, so the test suite is built around them:

- **A brute-force oracle** (`test/oracle.test.ts`). Independent code walks **every real minute** of a window and
  decides whether it is a run; the result must equal `between()` and `matches()` for hundreds of random expressions
  in UTC, and around **every DST transition of 2026** in New York, London, Sydney, Lord Howe, St. John's and Madrid,
  for both `shift` and `skip`.
- **Mutation-checked.** To make sure the oracle can fail, three deliberate bugs were injected (a repeated hour running
  twice, a broken gap shift, an inverted day-of-month/day-of-week rule): the oracle caught all three.
- Hand-checked examples (leap days, the 2100 gap, `15W` at month edges, `5#5`), 54 explanation cases in two languages,
  parser error positions, CLI exit codes, and a test of the **built** ESM/CJS/CLI/type declarations as a user receives them.
- `npm run build && node scripts/smoke.mjs` runs on Node 18, 20 and 22 in CI.

## Performance

Measured on a laptop (`node scripts/bench.mjs`); use it to compare changes, not as a promise.

| Case | Throughput |
|---|---|
| UTC, `*/5 * * * *` | ~570 000 runs/s |
| UTC, `0 9 * * 1-5` | ~420 000 runs/s |
| `America/New_York`, `*/5 * * * *` | ~17 000 runs/s *(cost is `Intl` time-zone lookups)* |
| `parse()` | ~90 000 expressions/s |

## Limitations

- Resolution is 1 minute (1 second with `seconds: true`).
- DST semantics follow Vixie/cronie for gaps and repeated hours; systemd timers and some cloud schedulers behave
  differently. If your scheduler runs jobs differently, use `dstGap: 'skip'` or schedule in UTC.
- Historic zone rules before 1970 and exotic second-level offsets are out of scope.
- It computes and explains schedules; it does not *run* jobs.

## Versioning

[Semver](https://semver.org). Because it changes when jobs run, **any change to DST or day-matching semantics is a
major version**. See [CHANGELOG.md](./CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security: [SECURITY.md](./SECURITY.md). License: MIT.
