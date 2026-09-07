# Reuse authorized builds

Status: ready-for-agent

Blocked by: 01

Add global fingerprint reuse and consumer-scoped authorization from `.tracker/automatic-build-config/spec.md`.

Resolve internal Gondolin image references by fingerprint before building. Derive consumer identity from the canonical common Git directory for Git projects and from the canonical project root otherwise. Identify repository-local build configs by repository-relative path and external configs by canonical absolute path. Treat system-selected build configs as system-wide consumers.

Store consumer, build-config identity, fingerprint, and Gondolin build ID associations under the Echoriad cache directory. Reuse a valid image silently for an authorized association. Prompt before a new consumer reuses a global image. Prompt and rebuild when the Gondolin object is missing, and never use an older fingerprint as fallback.

Implement restrictive sibling temporary files and atomic rename for metadata replacement. Each writer cleans only its own temporary file. Move malformed active metadata aside, warn the user, and continue with empty authorization state. Accept fail-closed lost updates from concurrent writers as specified.

Add focused automated coverage for linked worktrees, separate clones, non-Git projects, external build configs, system scope, global cache reuse, new-consumer approval, cache deletion, missing Gondolin objects, malformed metadata, interrupted writes, and concurrent lost updates.

## Comments
