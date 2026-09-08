# Remove Echoriad-built images through Gondolin's private store layout

The `echoriad images remove` command deletes Gondolin's image refs and objects directly from the on-disk store instead of waiting for a public removal API, because Gondolin 0.12.0 ships none and the command's value does not justify blocking on upstream work. This deliberately supersedes the automatic-build-config spec's "does not manipulate Gondolin's private store layout" constraint and the "public APIs only" rule in issue .tracker/automatic-build-config/issues/10-add-build-cache-commands.md.

## Considered options

- **Defer removal until Gondolin ships one** (the original constraint): rejected — cached objects accumulate indefinitely and users have no way to reclaim disk, and no upstream roadmap item existed to wait for.
- **Defended direct layout manipulation** (chosen): the command probes the expected store layout (`refs/<name>/<tag>/<arch>` symlinks, build-id-keyed object directories) and refuses to run when the probe fails; only refs whose name starts with the `echoriad-build-` prefix may be removed, ever; and an object directory is deleted only after rescanning all refs for remaining targets.

## Consequences

The command couples Echoriad to Gondolin's internal format, so a Gondolin release that changes the store layout makes `images remove` refuse to run until Echoriad's probe is updated — the failure mode is refusal, not wrong deletions. Removal remains irreversible by nature. When Gondolin grows a removal API, the command should move onto it and this ADR becomes obsolete.
