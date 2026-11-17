# Security policy

cronwise has no runtime dependencies and performs no I/O in the library (the CLI only reads stdin and prints).

If you find a vulnerability (for example an expression that makes `parse()` or `next()` hang or consume unbounded
memory), please do **not** open a public issue. Report it privately to the maintainers (use GitHub's
"Report a vulnerability" feature on the repository once it is published) and give us a reasonable time to fix it.

Design notes relevant to untrusted input (e.g. expressions typed by end users):

- `parse()` is linear in the length of the expression and rejects malformed input with `CronParseError`.
- `next()` looks at most 9 years ahead and returns `null` for schedules that never run, so it always terminates.
- `between()` has a `limit` (default 10 000) to bound the work and the result size.
