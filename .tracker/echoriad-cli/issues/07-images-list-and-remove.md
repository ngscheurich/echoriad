# images list and remove commands

Status: ready-for-agent

Blocked by: 02

`echoriad images` and `echoriad images remove <ref>` manage Echoriad-built guest images, per the spec (Commands: `echoriad images`, `echoriad images remove`) and the supersession section on store-layout removal.

`images` lists refs whose name starts with `echoriad-build-` (remainder is the full hex fingerprint): abbreviated fingerprint, build id, arch, last-updated timestamp, and an `authorized` marker for the current consumer's matching association. `--json` includes the full fingerprint. No "used by project" column — project is not in the association data model.

`images remove` manipulates the store layout directly, defended: a layout probe validates the expected `refs/<name>/<tag>/<arch>` scheme and refuses the command on mismatch; a hard `echoriad-build-` prefix check (not a filter) rejects anything else; ref links are deleted for the named tag; object dirs are deleted only after rescanning all refs (any arch) for stragglers. Arguments: canonical `name:tag`, or a fingerprint abbreviation that matches exactly one ref. One ref per invocation, no bulk flag. Guest images created outside Echoriad are never touched.
