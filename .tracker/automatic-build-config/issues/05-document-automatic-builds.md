# Document automatic builds

Status: ready-for-agent

Blocked by: 01, 02, 03, 04

Document the automatic build-config feature in `README.md` after its behavior is implemented.

Cover configuration examples and precedence, Gondolin's ownership of the build schema, interactive approval, noninteractive failure, semantic local-input invalidation, external-input staleness, global image reuse, consumer-scoped authorization, host network and environment access, build-log privacy, unbounded retention, cancellation, duplicate concurrent builds, concurrent metadata updates, preapproval host traversal, and the input-change race.

Link the deferred tracker issues from an appropriate limitations section. Keep the documentation aligned with `.tracker/automatic-build-config/spec.md` and `CONTEXT.md` terminology.

Verify every documented command and configuration example against the implementation.

## Comments
