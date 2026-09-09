# build command

Status: resolved

Blocked by: 02

`echoriad build` runs the same fingerprint pipeline as the extension for the project at cwd, per the spec (Commands: `echoriad build`).

Behavior:

- Cached image exists and the consumer's association authorizes it: print `up to date`, exit 0.
- Otherwise render `buildApprovalSummary` verbatim, prompt with clack `confirm` (non-TTY fails closed), then build via `prepareGuestImage`'s flow, streaming Gondolin output as discrete lines (`taskLog` under clack framing, plain lines otherwise — no in-place repaint without a TTY).
- `--force` rebuilds the current fingerprint (the stale-build-id path in `prepareImage` already tolerates same-fingerprint rebuilds).
- The project selects an existing `image` (selector, env, or default): exit nonzero with a message saying build applies to build-config selections only.

Approval records the association on success, exactly as the extension does, so pi and the CLI silently reuse each other's builds.

## Comments

Implemented on top of 02. `src/cli/build.ts` resolves the selection at cwd through the shared config module and rejects non-buildConfig selections (image, env, default) with a CliError, so `build` never manages images it did not create. The build itself is `prepareGuestImage`'s flow with the CLI's own `approve` seam: the default prompt renders `buildApprovalSummary` verbatim — clack `note` framing on an interactive terminal, ui lines in plain mode — and backs the decision with clack `confirm`; a cancel is a `CancelledError`, and the shared noninteractive fail-closed path still guards prompt-requiring runs before clack is ever reached. Build output streams as discrete lines with partial-line buffering: clack `taskLog` (display window of 50) under framing, `ui.line` otherwise, so piped output is never repainted in place. An unprompted success is the authorized silent reuse and prints `up to date`; prompted runs print the completion (`guest image build complete` or `reused cached guest image` with the abbreviated fingerprint), and the pipeline records the association on success exactly as the extension does. `--force` is a new `force` option on `prepareGuestImage`: it skips the authorized-reuse early return and the cache adoption, so the current fingerprint rebuilds and the association is re-recorded against the build ID the rebuild resolved to — the stale-build-id path tolerates the same-fingerprint rebuild as the issue notes. One shared-core change the first async command required: `main` now awaits command handlers, and `echoriad.ts` awaits the returned promise so async commands settle before the process exits. Covered by `test/build-command.test.ts`, a force case in `test/guest-image.test.ts`, and dispatch cases in `test/cli.test.ts`.
