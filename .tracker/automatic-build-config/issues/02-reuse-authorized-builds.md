# Reuse authorized builds

Status: resolved

Blocked by: 01

Add global fingerprint reuse and consumer-scoped authorization from `.tracker/automatic-build-config/spec.md`.

Resolve internal Gondolin image references by fingerprint before building. Derive consumer identity from the canonical common Git directory for Git projects and from the canonical project root otherwise. Identify repository-local build configs by repository-relative path and external configs by canonical absolute path. Treat system-selected build configs as system-wide consumers.

Store consumer, build-config identity, fingerprint, and Gondolin build ID associations under the Echoriad cache directory. Reuse a valid image silently for an authorized association. Prompt before a new consumer reuses a global image. Prompt and rebuild when the Gondolin object is missing, and never use an older fingerprint as fallback.

Implement restrictive sibling temporary files and atomic rename for metadata replacement. Each writer cleans only its own temporary file. Move malformed active metadata aside, warn the user, and continue with empty authorization state. Accept fail-closed lost updates from concurrent writers as specified.

Add focused automated coverage for linked worktrees, separate clones, non-Git projects, external build configs, system scope, global cache reuse, new-consumer approval, cache deletion, missing Gondolin objects, malformed metadata, interrupted writes, and concurrent lost updates.

## Comments

Implemented in commit 70add45. Consumer and build-config identity live in
`src/authorization.ts` (`deriveBuildIdentity`: canonical common Git directory
for Git projects with `commondir` following so linked worktrees share one
consumer, canonical project root otherwise, system-wide consumer for
system-selected configs; in-repository configs identified by repository-
relative path, external ones by canonical absolute path). Authorization
associations are stored as `{consumer, config, fingerprint, buildId}` entries
in `image-authorizations.json` under `${XDG_CACHE_HOME:-$HOME/.cache}/
echoriad`. `prepareGuestImage` in `src/guest-image.ts` now resolves the
fingerprint-derived image reference before building: an authorized
association with a valid image object reuses silently (also in noninteractive
sessions), a new consumer reusing a global image and an uncached fingerprint
both require approval (the prompt distinguishes the two actions), and a
missing Gondolin object prompts and rebuilds with no older-fingerprint
fallback. Metadata writes go through `writeFileAtomically`: a uniquely named
sibling file created with `wx` and mode 0600, renamed over the destination,
removed in a finally block; each writer cleans only its own temporary file.
Malformed active metadata is moved aside with a human-facing warning
(`ctx.ui.notify(..., "warning")`) and treated as empty. Concurrent writers
can lose each other's associations (last atomic rename wins, fail-closed).
21 new tests in `test/authorization.test.ts` and `test/guest-image.test.ts`
cover linked worktrees, separate clones, non-Git projects, external build
configs, system scope, silent authorized reuse, new-consumer approval, cache
deletion, missing Gondolin objects, malformed metadata, interrupted writes,
and concurrent lost updates; 61 tests total pass with `npm test`.
