# CLI entry, Clack dependency, and the ui seam

Status: resolved

Blocked by: 01

The CLI needs its entrypoint, its prompt library, and the single output seam that all other commands route through.

- Add the `"bin"` entry `echoriad` → `./echoriad.ts` (thin root entry re-exporting `src/cli/`). Add `@clack/prompts` (not the bare `clack` package — that is an unrelated old Slack client on npm).
- Build `src/cli/ui.ts` as the only place human-facing output is produced (accessibility.md's one-seam rule). It resolves plain mode with precedence `--plain` > `ECHORIAD_PLAIN` > system-config `plain` field > off; `ECHORIAD_PLAIN` follows NO_COLOR-spec semantics (present and non-empty, regardless of value). Add the `plain` boolean to the system config schema with validation.
- Error convention: `error: <message>` to stderr, exit 1, reusing `ConfigError`/`GuestImageError` messages verbatim. Cancel convention: `cancelled: <command>`, exit 1, distinct from a denial.
- Non-TTY gate: prompt-requiring paths fail closed with a pointer to the flag or interactive alternative before clack is ever reached; display-only commands print plain text.
- No color, no prompt timeouts. Verdict and severity words carry meaning on their own.
- Command parsing: plain hand-rolled argv handling is fine unless a command's needs outgrow it; no argument-parser dependency without a stated reason.

Unit-test plain resolution, error/cancel formatting, and the non-TTY gate without a TTY.

## Comments

Implemented on top of 01. `src/cli/ui.ts` owns every human-facing line:
`resolvePlainMode` applies the precedence (env follows NO_COLOR — present
and non-empty regardless of value), `createUi` writes through injected
streams so tests capture output without a TTY, `requireInteractive` is
the fail-closed gate prompt-requiring commands call before clack. The
`error: `/`cancelled: ` formats live in ui.ts; `src/cli/index.ts` reuses
them for the one case where output happens before a ui exists (a config
load failure). One addition beyond the letter of the issue: `plain` in a
project `.echoriad.json` is rejected outright, since output style is a
system-wide preference and the lenient parser would otherwise silently
ignore it. `echoriad.ts` calls `main()` rather than only re-exporting —
the bin must execute, so the root entry sets `process.exitCode` from the
returned code. `@clack/prompts` is installed but unimported; commands
(03+) import it. Dispatch handlers register into the COMMANDS table in
src/cli/index.ts as their modules land.
