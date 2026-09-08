# Document automatic builds

Status: resolved

Blocked by: 01, 02, 03, 04

Document the automatic build-config feature in `README.md` after its behavior is implemented.

Cover configuration examples and precedence, Gondolin's ownership of the build schema, interactive approval, noninteractive failure, semantic local-input invalidation, external-input staleness, global image reuse, consumer-scoped authorization, host network and environment access, build-log privacy, unbounded retention, cancellation, duplicate concurrent builds, concurrent metadata updates, preapproval host traversal, and the input-change race.

Link the deferred tracker issues from an appropriate limitations section. Keep the documentation aligned with `.tracker/automatic-build-config/spec.md` and `CONTEXT.md` terminology.

Verify every documented command and configuration example against the implementation.

## Comments

Implemented in commit e3df702. The README gained an "Automatic image builds"
section covering the `buildConfig` selector (precedence, declaring-directory
resolution, mutual exclusion with `image`), Gondolin's ownership of the
build-config schema, fingerprinting and semantic rebuild triggers, external-
input staleness, the global cache and consumer-scoped authorization, the
approval prompt and its displayed details, noninteractive failure, host
network and environment access, build-log privacy, cancellation, and
`/echoriad` reporting. The Configuration section and the `/echoriad` example
were updated to match the implementation (`buildConfig` field row, slot and
precedence rules, build report lines).

A Limitations subsection links all six deferred issues (06-11): input
staging, build coordination (duplicate builds and lost metadata updates),
host input inspection gating, environment filtering, build/cache commands
and unbounded retention, and daemon-side container cancellation. Every
documented command output, path, and configuration example was verified
against `src/config.ts`, `src/fingerprint.ts`, `src/authorization.ts`,
`src/guest-image.ts`, and `index.ts`; both JSON examples parse. Terminology
follows `CONTEXT.md` (build config, guest image, image selector) and the
ownership split in `docs/adrs/0001`.
