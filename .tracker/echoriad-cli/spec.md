# Echoriad CLI

A host-side `echoriad` command-line interface over the guest-image pipeline that already backs the pi extension. The CLI shares the extension's consumer identity, build fingerprinting, authorization store, and approval flow, so approval in one surface enables silent reuse in the other. This feature realizes the deferred command work of `automatic-build-config` (issue 10: build and cache commands; spec: the deferred forced-rebuild command).

## Goals

- Launch an interactive shell in the guest configured for the project at cwd.
- Build, list, and remove Echoriad-built guest images from the terminal.
- Report project image status and the effective resolved configuration.
- Approve and revoke build authorizations without launching a VM or pi.
- Keep every UX rule from `docs/style/accessibility.md`: meaning in words, one output seam, degrade by destination.

## Non-goals

- No daemon and no VM persistence beyond one `bash` invocation.
- No management of guest images the user created outside Echoriad.
- No bulk image removal; one ref per `images remove` invocation.
- No `--project` flag; cwd is the project root.
- No noninteractive approval of the pi extension's build path; fail-closed behavior there is unchanged.
- No `--plain` counter-flag; `--plain` and `ECHORIAD_PLAIN` only force plain output.

## Relationship to the automatic-build-config spec

That spec states "It does not manipulate Gondolin's private store layout" and issue .tracker/automatic-build-config/issues/10-add-build-cache-commands.md asks cleanup to use public Gondolin APIs. Gondolin 0.12.0 exposes no removal API, so this feature supersedes that constraint — recorded in `docs/adrs/0002-remove-echoriad-images-through-the-private-store-layout.md` — with a defended direct approach: `images remove` validates the expected store layout before acting, never touches refs outside the `echoriad-build-` prefix, and deletes an object only after rescanning all refs for stragglers. A probe failure refuses the command instead of guessing. If Gondolin later ships a removal API, `images remove` should move onto it.

## Packaging and layout

Single package; no workspace tooling. The repository splits into three zones:

- `src/` — shared core, flat, one module per concern: `config.ts`, `authorization.ts`, `fingerprint.ts`, `guest-image.ts`, plus new extractions from `index.ts` for VM/sandbox spec construction and consumer/build identity. The CLI needs both; they are shared logic, not pi-specific.
- `src/pi/` — the tool router, extracted from `index.ts`.
- `src/cli/` — the CLI: one module per command plus `ui.ts`.

Root entrypoints stay thin: `index.ts` re-exports `src/pi/` (the pi manifest path must keep working) and `echoriad.ts` is the CLI bin (a `"bin"` entry named `echoriad`). AGENTS.md's repository-layout section is updated to match.

## Commands

Selection resolution (`resolveImageSelection`) and scalar coalescing (`project.x ?? system.x`) are shared with the extension. cwd is the project root for all commands that read project state.

### `echoriad bash`

Fresh VM per invocation; exit tears it down. Programmatic path, mirroring Gondolin's own bin: build `VMOptions` from the shared spec module (image from `prepareGuestImage`, cpus/memory/mounts/network/secrets from the resolved config), `VM.create`, `vm.shell({ attach: false })`, and a reimplemented TTY attach (~50 lines: raw mode, resize, Ctrl-] escape — gondolin's `attachTty` is not exported). The guest shell's exit code passes through.

### `echoriad build`

Same fingerprint pipeline as the extension. If a cached image exists and the association authorizes it: print `up to date` and exit 0. Otherwise render the standard approval summary (clack `confirm`) and build, streaming Gondolin output as discrete lines (`taskLog` or plain lines). `--force` rebuilds the current fingerprint; the stale-build-id path in `prepareImage` already tolerates same-fingerprint rebuilds.

When the project selects an existing `image` (selector, env, or default), `build` exits nonzero with a message saying it applies to build-config selections only.

### `echoriad images`

Lists Echoriad-built images only: refs whose name starts with `echoriad-build-` (rest of the name is the full hex fingerprint). Columns: abbreviated fingerprint, build id, arch, last-updated timestamp, and an `authorized` marker for the current consumer's matching association. `--json` carries all fields including the full fingerprint — JSON is a primary assistive surface and must be complete (accessibility.md). No "used by project" column: associations record consumer, config identity, fingerprint, and build id — project is not in the data model.

### `echoriad images remove <name:tag | fingerprint-abbrev>`

Direct store manipulation, defended (see the supersession section): layout probe, `echoriad-build-` prefix hard check, ref links deleted for the named tag, object dirs deleted only when no remaining ref (any arch) targets them. Fingerprint-abbrev arguments must match exactly one ref. Never touches images the user created outside Echoriad.

### `echoriad status`

Scoped to the project root at cwd. Reports: which source was selected (project / system / env / default, and the resolved build-config path or selector), the abbreviated fingerprint, and one verdict:

- `up to date` — image exists in Gondolin's store and the consumer's association matches.
- `needs build` — no image for the fingerprint.
- `needs approval` — image exists but the association is missing or its build id is stale.
- `no image selected` — the project selects an existing image; nothing to build.

Exit 0 unless the configuration is invalid (then the standard error form). `--json` carries the full state including the full fingerprint.

### `echoriad config`

Origin-annotated resolved view: every field shows its origin (project / system / env / built-in default), plus the resolved image selection with its kind and canonical path. `--json` for scripting. Invalid config file: error and nonzero exit — never a silently degraded "resolved" view.

### `echoriad approve` / `echoriad revoke`

`approve`: resolve the selection at cwd, compute the fingerprint, render the same approval summary as the extension, prompt via clack `confirm`, record the association on approval. `--yes` skips the prompt — the human invoking it is the trust decision — but the summary still prints so script logs record what was approved. Non-buildConfig selections exit nonzero (same rule as `build`).

`revoke`: interactive clack `multiselect` over the *current consumer's* associations for the project (a project may accumulate several fingerprints); `--all` selects everything; `--yes` skips the confirm. Revocation never deletes the cached image; `images remove` owns that. Revoking other consumers' associations is out of scope.

## Cross-cutting behavior

**Output seam.** All human-facing output routes through `src/cli/ui.ts` — the single degradation point per accessibility.md. Verdict words carry meaning on their own; no color in the first release; `error:` and `cancelled:` severity words are the only state encoding.

**Plain mode.** `--plain` flag, `ECHORIAD_PLAIN` env var (NO_COLOR-spec semantics: present and non-empty regardless of value), and a `plain` boolean in the system config; precedence flag > env > config, default off. Plain mode skips clack `intro`/`outro` framing and any spinner; what remains is exactly what non-TTY output looks like, so both paths share the seam.

**Clack.** Dependency is `@clack/prompts` (npm's bare `clack` package is an unrelated old Slack client). `intro`/`outro` frame interactive commands only; `confirm` backs approval; `multiselect` backs revoke; `log.*` carries status lines; spinner is allowed as decoration behind non-plain only, never as the message carrier; build progress is discrete streamed lines.

**Non-TTY.** Commands requiring a decision fail closed with a pointer to the flag or interactive alternative (`approve --yes`, `revoke --all --yes`, or run interactively to approve a build). Display-only commands (`status`, `config`, `images`) print plain text as `--plain` would. Clack is never reached without a TTY.

**Errors and exit codes.** Errors print to stderr as `error: <message>`, reusing the existing `Echoriad: ...` messages from `ConfigError` and `GuestImageError` verbatim; exit 1. Ctrl+C mid-prompt means aborted, distinct from a no: print `cancelled: <command>`, exit 1.

**No prompt timeouts.** Per accessibility.md, interactive prompts never time out.

## Testing

Follow the existing patterns: `node:test` suites in `test/`, dependency-injection seams for Gondolin calls, filesystem state under temp directories. UI seam logic (plain resolution, verdict strings, JSON completeness) is unit-tested without a TTY.
