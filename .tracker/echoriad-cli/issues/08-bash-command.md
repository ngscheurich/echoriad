# bash command

Status: resolved

Blocked by: 01, 02

`echoriad bash` launches an interactive shell in a fresh VM configured for the project at cwd, per the spec (Commands: `echoriad bash`).

Fresh VM per invocation; exit tears it down; the guest shell's exit code passes through. Programmatic path mirroring Gondolin's own bin: build `VMOptions` from the shared spec module (image from `prepareGuestImage`, cpus/memory/mounts/network/secrets from the resolved config), `VM.create`, `vm.shell({ attach: false })`, then a reimplemented TTY attach (~50 lines: raw mode, resize, Ctrl-] escape — gondolin's `attachTty` is not exported).

Guest-image approval goes through the same interactive flow as `build` when the project needs it; a non-TTY invocation fails closed. Do not spawn `gondolin bash`: its flag surface has no `--cpus`/`--memory`, so it would silently drop the project's scalar config.

## Comments

Implemented on branch `08-bash-command`. `src/cli/bash.ts` owns the
command and the reimplemented TTY attach (raw mode, resize forwarding,
Ctrl-] detach with exit 130, output pipes with backpressure); `main` now
awaits handlers and returns their exit code so the guest shell's code
passes through. `src/cli/image.ts` resolves the selected image for CLI
commands over the shared pipeline; its clack `confirm` approval prompt
renders the standard summary, cancellation reports `cancelled:
echoriad bash`, and `build` (issue 05) can reuse the same module. The
image path-vs-selector resolution moved into `resolveImageTarget` in
`src/config.ts` so the pi extension and the CLI cannot drift. A
non-TTY invocation fails closed before any project state is read.
