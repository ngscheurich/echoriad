# bash command

Status: ready-for-agent

Blocked by: 01, 02

`echoriad bash` launches an interactive shell in a fresh VM configured for the project at cwd, per the spec (Commands: `echoriad bash`).

Fresh VM per invocation; exit tears it down; the guest shell's exit code passes through. Programmatic path mirroring Gondolin's own bin: build `VMOptions` from the shared spec module (image from `prepareGuestImage`, cpus/memory/mounts/network/secrets from the resolved config), `VM.create`, `vm.shell({ attach: false })`, then a reimplemented TTY attach (~50 lines: raw mode, resize, Ctrl-] escape — gondolin's `attachTty` is not exported).

Guest-image approval goes through the same interactive flow as `build` when the project needs it; a non-TTY invocation fails closed. Do not spawn `gondolin bash`: its flag surface has no `--cpus`/`--memory`, so it would silently drop the project's scalar config.
