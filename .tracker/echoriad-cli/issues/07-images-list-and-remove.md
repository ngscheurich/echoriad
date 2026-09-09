# images list and remove commands

Status: resolved

Blocked by: 02

`echoriad images` and `echoriad images remove <ref>` manage Echoriad-built guest images, per the spec (Commands: `echoriad images`, `echoriad images remove`) and the supersession section on store-layout removal.

`images` lists refs whose name starts with `echoriad-build-` (remainder is the full hex fingerprint): abbreviated fingerprint, build id, arch, last-updated timestamp, and an `authorized` marker for the current consumer's matching association. `--json` includes the full fingerprint. No "used by project" column — project is not in the association data model.

`images remove` manipulates the store layout directly, defended: a layout probe validates the expected `refs/<name>/<tag>/<arch>` scheme and refuses the command on mismatch; a hard `echoriad-build-` prefix check (not a filter) rejects anything else; ref links are deleted for the named tag; object dirs are deleted only after rescanning all refs (any arch) for stragglers. Arguments: canonical `name:tag`, or a fingerprint abbreviation that matches exactly one ref. One ref per invocation, no bulk flag. Guest images created outside Ecoriad are never touched.

## Comments

### Implementation notes

`src/cli/images.ts` implements both commands behind an `ImagesDeps` seam
(ref listing, store directory, authorizations, consumer identity) that
`main` injects, so the tests drive everything through the CLI boundary.

`images` filters Gondolin's public `listImageRefs` to names of the form
`echoriad-build-<lowercase hex>` (the parenthetical's "full hex
fingerprint" is enforced as charset, not length, so a fingerprint scheme
change only touches `imageRefForFingerprint`). The `authorized` marker
matches the consumer's association on fingerprint *and* build id, so a
same-fingerprint rebuild (stale association build id) reads as `not
authorized` — the same reading the spec gives `status`'s "needs approval"
verdict. Human rows say `authorized` / `not authorized` in words (never a
dash glyph) per accessibility.md; `--json` carries all fields including
the full fingerprint.

`images remove` resolves its single argument (canonical `name:tag`, or a
fingerprint abbreviation scanned from the refs tree that must match
exactly one ref), then refuses on any layout mismatch before deleting:
the tag directory must contain only aarch64/x86_64 symlinks pointing at
build-id-keyed directories inside the objects root. Ref links are
deleted for the named tag only (empty name directories are pruned up to
the refs root), and object directories are deleted only after rescanning
every ref under the tree — including user-created refs — for remaining
targets. A ref scan that cannot read an entry keeps all objects with a
line saying so, rather than risking a wrong deletion.

Coverage: 21 tests in `test/images.test.ts` through the CLI boundary
(29 in total across the three new/updated suites) plus one integration
test in `test/images-store.test.ts` that drives the default wiring
against a real Gondolin-written store via `importImageFromDirectory`
and `setImageRef`, including removal of a real object. The consumer
half of build identity moved to `deriveConsumerIdentity` in
`src/identity.ts`, and the `echoriad-build-` prefix constant lives in
`src/guest-image.ts` next to `imageRefForFingerprint`.
