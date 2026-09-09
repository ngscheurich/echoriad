# approve and revoke commands

Status: resolved

Blocked by: 02

`echoriad approve` and `echoriad revoke` manage build authorizations without launching a VM or pi, per the spec (Commands: `echoriad approve` / `echoriad revoke`).

`approve`: resolve the selection at cwd, compute the fingerprint, render the same approval summary as the extension, prompt with clack `confirm`, and record the association on approval. `--yes` skips the prompt — the human invoking it is the trust decision — but the summary still prints so script logs record what was approved. Non-buildConfig selections exit nonzero.

`revoke`: interactive clack `multiselect` over the current consumer's associations for the project (several fingerprints may accumulate); `--all` selects everything; `--yes` skips the confirm. Revocation deletes associations only — never the cached image (`images remove` owns that) and never other consumers' associations.

Command verbs are `approve`/`revoke` to match the glossary's Build approval and AGENTS.md's "revokes" language; "trust" stays off the vocabulary.

## Comments

Implemented in `src/cli/approve.ts` and `src/cli/revoke.ts`, registered
through the COMMANDS table in `src/cli/index.ts`. Decisions the issue
left open, recorded here:

- `approve` fails closed when no cached image exists for the
  fingerprint (exit 1, pointing at `echoriad build`). An association
  requires the build ID of an image Gondolin already holds — the
  automatic-build-config spec writes authorization metadata only after
  an image is imported and resolved — and `prepareImage` prompts for a
  build regardless of any prior approval, so pre-authorizing a
  not-yet-built image had no effect to record. The summary therefore
  always renders the "reuse" action.
- `revoke` derives the current consumer from the selected build config
  when one is selected (system-wide scope for a system selection) and
  from the project root otherwise, so approvals accumulated under an
  earlier build-config selection stay revocable after the project
  switches to an `image` selector.
- Declines at a prompt go through the error convention (`error: not
  approved; no build approval recorded`), exit 1; Ctrl-C at a prompt
  goes through the cancel convention via the new `src/cli/prompts.ts`
  clack wrappers. `ui.warn` (`warning: ...` on stderr) carries malformed
  metadata warnings from the authorization store without failing.
- `main` became async and now passes a `CommandContext` (cwd, env,
  system config, prompt and image-resolution seams) to handlers, so
  prompt-backed commands work and the injected `CliDeps` seams reach
  them; existing dispatch tests were updated to await.
- Shared-core extractions keep the CLI on the extension's exact
  fail-closed messages: `deriveConsumerIdentity` (identity.ts),
  `loadBuildConfig`/`parseBuildConfigFile`/`resolveImageBuildId`
  (guest-image.ts, `prepareImage` refactored onto them).
