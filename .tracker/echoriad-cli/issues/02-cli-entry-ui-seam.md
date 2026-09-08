# CLI entry, Clack dependency, and the ui seam

Status: ready-for-agent

Blocked by: 01

The CLI needs its entrypoint, its prompt library, and the single output seam that all other commands route through.

- Add the `"bin"` entry `echoriad` → `./echoriad.ts` (thin root entry re-exporting `src/cli/`). Add `@clack/prompts` (not the bare `clack` package — that is an unrelated old Slack client on npm).
- Build `src/cli/ui.ts` as the only place human-facing output is produced (accessibility.md's one-seam rule). It resolves plain mode with precedence `--plain` > `ECHORIAD_PLAIN` > system-config `plain` field > off; `ECHORIAD_PLAIN` follows NO_COLOR-spec semantics (present and non-empty, regardless of value). Add the `plain` boolean to the system config schema with validation.
- Error convention: `error: <message>` to stderr, exit 1, reusing `ConfigError`/`GuestImageError` messages verbatim. Cancel convention: `cancelled: <command>`, exit 1, distinct from a denial.
- Non-TTY gate: prompt-requiring paths fail closed with a pointer to the flag or interactive alternative before clack is ever reached; display-only commands print plain text.
- No color, no prompt timeouts. Verdict and severity words carry meaning on their own.
- Command parsing: plain hand-rolled argv handling is fine unless a command's needs outgrow it; no argument-parser dependency without a stated reason.

Unit-test plain resolution, error/cancel formatting, and the non-TTY gate without a TTY.
