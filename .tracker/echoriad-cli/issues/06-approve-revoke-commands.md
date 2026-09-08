# approve and revoke commands

Status: ready-for-agent

Blocked by: 02

`echoriad approve` and `echoriad revoke` manage build authorizations without launching a VM or pi, per the spec (Commands: `echoriad approve` / `echoriad revoke`).

`approve`: resolve the selection at cwd, compute the fingerprint, render the same approval summary as the extension, prompt with clack `confirm`, and record the association on approval. `--yes` skips the prompt — the human invoking it is the trust decision — but the summary still prints so script logs record what was approved. Non-buildConfig selections exit nonzero.

`revoke`: interactive clack `multiselect` over the current consumer's associations for the project (several fingerprints may accumulate); `--all` selects everything; `--yes` skips the confirm. Revocation deletes associations only — never the cached image (`images remove` owns that) and never other consumers' associations.

Command verbs are `approve`/`revoke` to match the glossary's Build approval and AGENTS.md's "revokes" language; "trust" stays off the vocabulary.
