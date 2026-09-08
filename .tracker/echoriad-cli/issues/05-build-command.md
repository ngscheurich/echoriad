# build command

Status: ready-for-agent

Blocked by: 02

`echoriad build` runs the same fingerprint pipeline as the extension for the project at cwd, per the spec (Commands: `echoriad build`).

Behavior:

- Cached image exists and the consumer's association authorizes it: print `up to date`, exit 0.
- Otherwise render `buildApprovalSummary` verbatim, prompt with clack `confirm` (non-TTY fails closed), then build via `prepareGuestImage`'s flow, streaming Gondolin output as discrete lines (`taskLog` under clack framing, plain lines otherwise — no in-place repaint without a TTY).
- `--force` rebuilds the current fingerprint (the stale-build-id path in `prepareImage` already tolerates same-fingerprint rebuilds).
- The project selects an existing `image` (selector, env, or default): exit nonzero with a message saying build applies to build-config selections only.

Approval records the association on success, exactly as the extension does, so pi and the CLI silently reuse each other's builds.
