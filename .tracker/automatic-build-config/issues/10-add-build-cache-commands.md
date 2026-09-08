# Add build and cache commands

Status: needs-triage

The initial automatic build-config release has no Echoriad command-line interface for image builds or cache management. External inputs such as package repositories and mutable OCI tags do not change the local fingerprint, and Gondolin 0.12.0 exposes no image removal or garbage-collection API.

Add commands to inspect resolved build inputs and cached images, force a rebuild without changing local inputs, and remove obsolete cache associations and images safely. Define cleanup against public Gondolin APIs or coordinate the required API upstream rather than depending on Gondolin's private image-store layout.

Until this work lands, documentation must state that external input changes do not invalidate the cache and that cached Gondolin image objects may accumulate.

## Comments

- 2026-09-08: The `echoriad-cli` feature (`.tracker/echoriad-cli/`) realizes this ticket's command work: `build` (with the forced rebuild this ticket anticipated), `images` (list), and `images remove`. One deviation is recorded in the feature spec: Gondolin 0.12.0 exposes no removal API, so `images remove` manipulates the private store layout directly, defended by a layout probe, a hard `echoriad-build-` prefix check, and ref-rescan before object deletion — superseding this ticket's "public APIs only" constraint until Gondolin ships a removal command.
