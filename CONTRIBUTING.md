# Contributing

## Documentation

| | |
|---|---|
| [docs/development.md](docs/development.md) | Architecture, tests, how to add a tool |
| [docs/bhopal-vtop.md](docs/bhopal-vtop.md) | How Bhopal's endpoints and markup actually behave |
| [docs/http-connector.md](docs/http-connector.md) | Hosting remotely and its security model |
| [docs/tools.md](docs/tools.md) | The 29 tools and their schemas |
| [docs/errors.md](docs/errors.md) | Error codes and recovery |
| [docs/provenance.md](docs/provenance.md) | What came from where, with line counts |

If you change a tool's arguments, update [docs/tools.md](docs/tools.md) in the
same commit.

## Fixture hygiene — read this before adding a test

**Test fixtures may mirror the real SHAPE of a VTOP response. They must never
carry real VALUES.**

This is the rule that matters most in this repository, and it exists because it
was already broken once: while debugging the leave parsers, a captured response
was pasted into a test verbatim, which carried a real leave id, a real proctor's
name and staff id, real exam dates and real marks into the working tree. Those
had to be removed by hand.

### Why shape matters and values do not

The parsers depend on knowledge that **cannot be guessed** — which VTOP really
uses for a field name, the order of a dropdown's options, the column order of a
result table, whether a header cell is `<th>` or `<td>`, the format of a printed
date. Real responses are the only reliable source for that, so inspecting them
is encouraged.

None of the tests care what the values *are*. They care that a row with
`REQUEST APPROVED` in the status column is parsed into `status`, and that a
`L9000001`-shaped id is recognised as a leave id. Substituting `24.0` for `25.5`
tests exactly as much as the original.

### Rules

1. **Retype the contents.** Copy the structure, invent the values.
2. **Invent identifiers that are obviously synthetic** — `L9000001`,
   staff id `9000001`, an all-zero CSRF token — and add them to `SYNTHETIC` in
   `scripts/privacy-test.ts`. Being listed is deliberate: it makes adding a
   fixture a two-step decision rather than an accident.
3. **Never commit** a registration number, a real leave id, a staff id, a CSRF
   token, or credentials. See `.env.example` for the shape, never the content.
4. **Course codes and semester ids are fine.** `CSD3002` and `BL20262701` name a
   catalogue entry and a term, not a person — a whole cohort shares a semester
   id, and VIT publishes its course list. Source legitimately cites a real
   semester id as provenance for an inferred rule.

### The guard

`npm run test:privacy` runs as part of `npm run test:all` and fails the build if
identifiable data reappears. It matches **patterns**, not a blocklist of strings
that leaked before, so it catches a fresh leak rather than only the old one.

If it fires on something that is genuinely fine, prefer making the value
obviously synthetic over loosening the pattern.

## Development

```bash
npm install
npm run test:all     # typecheck + all suites + build + MCP smoke test
npm run typecheck    # tsc --noEmit
npm run build        # tsup -> dist/
```

Individual suites (`test:calc`, `test:parser`, `test:exam`, `test:leave`,
`test:leave-parse`, `test:privacy`, …) can be run on their own. They are all
offline and need no VTOP account — that is deliberate, so the test suite is safe
to run in CI.

## Ground rules for this codebase

- **Report what VTOP returns, never what you expect it to return.** An
  unpublished mark is `null` with `published: false`; it is never a fabricated
  `0`. When a fetch fails, say so rather than degrading to an empty result that
  reads like real data.
- **No extrapolation tools.** There is deliberately no grade predictor: VIT grades
  relatively against a class average VTOP does not expose, so any prediction
  would be guesswork dressed up as data.
- **Write operations require two steps.** `apply_leave` previews and returns a
  fingerprint token; a second call with that token submits. Tools that write
  must declare `readOnlyHint: false` so clients prompt rather than auto-approve.
  The smoke test asserts this, so a new write path cannot inherit the
  read-only default by accident.