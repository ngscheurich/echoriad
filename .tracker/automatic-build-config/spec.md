# Automatic Gondolin build configs

Echoriad can build and select a Gondolin guest image from a Gondolin build config. Gondolin owns image composition and its build-config schema. Echoriad owns source selection, approval, fingerprinting, cache reuse, build process lifecycle, and VM startup.

## Goals

- Let system and project configuration select a Gondolin build config.
- Build the selected guest image before VM creation.
- Rebuild when semantic configuration or referenced local inputs change.
- Reuse an existing build globally without transferring authorization between unrelated consumers.
- Require human approval before host-side build activity or a new consumer's use of a globally cached build.
- Keep build output and host details out of model context.

## Non-goals

- Echoriad does not define package lists or any other image-composition schema.
- The first release does not force refreshes for changed external inputs.
- The first release does not remove Gondolin image objects.
- The first release does not snapshot local inputs before building.
- The first release does not coordinate concurrent builds or metadata writers.
- The first release does not filter the environment inherited by the Gondolin process.
- The first release does not gate host input inspection before fingerprinting.

## Configuration

Both `.echoriad.json` and the system configuration accept a `buildConfig` string containing a Gondolin build-config path.

`buildConfig` and `image` occupy one logical selection slot. A configuration file that defines both is invalid. A project selector overrides both system selectors. When no project selector exists, Echoriad uses the system selector. When neither file selects an image source, Echoriad preserves the existing `ECHORIAD_IMAGE` fallback and Gondolin default.

A project `buildConfig` path resolves relative to the project root. A system `buildConfig` path resolves relative to the system configuration directory. Absolute paths remain absolute. Missing files, directories in place of files, invalid JSON, and build configs rejected by Gondolin stop startup with an actionable error.

Other scalar configuration fields retain their existing independent precedence.

## Build fingerprint

Echoriad parses the build config with the installed Gondolin package. It fingerprints a canonical serialization of the parsed config. Object keys are recursively sorted, array order is preserved, and JSON formatting does not affect the result.

The fingerprint includes the contents and build-relevant metadata of every referenced local input recognized by the installed Gondolin schema. For Gondolin 0.12.0, these include custom init scripts, every `postBuild.copy` source, custom sandbox helper binaries, and any supported distribution expression path. Relative input paths resolve against the build config's directory. Directory traversal is deterministic and includes entry names, node types, relevant modes, regular-file contents, and symbolic-link targets according to Gondolin's build semantics. Device nodes, sockets, FIFOs, and other unsupported filesystem nodes are rejected.

The fingerprint also includes the installed Gondolin package version and an Echoriad fingerprint-schema version. File timestamps do not affect it.

External state does not affect the fingerprint. This includes package repository contents, mutable OCI tags, mutable container tags, remote downloads, and host tool behavior. Users must use the deferred forced-rebuild command when that command becomes available. Until then, creating a meaningful local build-config change is the supported way to produce a new fingerprint.

Echoriad reads and hashes declared local inputs before approval. It may therefore traverse large or external host paths before showing the prompt. It does not disclose file contents or hashes to the guest or model.

## Global build cache

A successful build is imported into Gondolin's content-addressed image store. Echoriad creates an internal Gondolin image reference derived from the fingerprint. A valid reference and image object allow any consumer with matching inputs to avoid repeating the build.

The first release retains global fingerprint references indefinitely. It does not manipulate Gondolin's private store layout. Cache inspection, forced rebuild, and cleanup belong to deferred command work.

A missing or invalid Gondolin image object makes the cache entry unusable. Echoriad requests approval again before rebuilding. It never falls back to an image produced for an older fingerprint.

## Consumers and authorization

Authorization is an association between a consumer, build-config identity, fingerprint, and Gondolin build ID.

A Git project's consumer identity is the canonical common Git directory. Linked worktrees therefore share authorization. A non-Git project's consumer identity is its canonical project root. Separate clones remain separate consumers.

A build config inside the repository is identified by its repository-relative path. A build config outside the repository is identified by its canonical absolute path. A build config selected by the system configuration has system-wide consumer scope.

Echoriad stores authorization associations as cache metadata under `${XDG_CACHE_HOME:-$HOME/.cache}/echoriad`. Cache deletion revokes the associations and causes later prompts. There is no separate durable approval database.

A matching authorized association permits silent cache reuse. A globally cached fingerprint used by a new consumer requires approval before selection. An uncached fingerprint requires approval before building. Denial stops startup. A noninteractive session that requires approval fails before building or selecting the image and instructs the user to open the project interactively.

Malformed metadata is moved aside with a human-facing warning and treated as empty. Metadata updates use a uniquely named sibling file created exclusively with restrictive permissions. Echoriad writes and closes that file, renames it over the destination, and removes its own temporary file in a `finally` block if it remains. It does not scan for temporary files created by other processes.

Concurrent metadata writers may discard each other's new associations in the first release. This can cause a later approval prompt but cannot grant authorization.

## Approval prompt

The prompt distinguishes building from reuse of a globally cached image. It shows:

- the consumer and project root;
- the canonical build-config path;
- all resolved local input paths, highlighting paths outside the project;
- `postBuild.commands` verbatim;
- OCI and container image references;
- custom init-script and sandbox-helper paths;
- whether Gondolin may use a privileged container;
- that building uses host network access independently of guest network policy;
- that the Gondolin process inherits the host environment;
- that build output may contain host data.

The first release offers Approve and Cancel. Approval applies only to the displayed consumer, build-config identity, and fingerprint.

## Build process

Echoriad resolves the Gondolin CLI from the installed `@earendil-works/gondolin` dependency rather than from `PATH`. It launches the CLI as a child process with the selected build config, a unique temporary output directory, and the internal fingerprint-derived image reference.

The child inherits the host environment and host network access to preserve Gondolin CLI behavior. Guest `network` policy does not govern build traffic. Builds containing `postBuild.commands` receive an explicit environment warning because native Linux chroot commands may see inherited host variables.

Echoriad reports a human-facing building status and streams Gondolin output only to human-facing diagnostics. Build logs, resolved host paths, approval details, and errors are not added to model context or the system prompt.

Build failure stops VM startup and leaves any older cached images untouched. Echoriad writes authorization metadata only after Gondolin has successfully imported the image and Echoriad has resolved that image.

On cancellation or Pi shutdown, Echoriad terminates the Gondolin subprocess group, removes its own temporary output directory, and does not write authorization metadata. An image imported before cancellation may remain in Gondolin's store but receives no automatic authorization.

The first release does not lock builds by fingerprint. Concurrent sessions may perform duplicate builds. Every build uses a unique temporary output directory.

The first release invokes Gondolin against the approved original paths. Another process can change an input between fingerprinting and Gondolin reading it. This time-of-check/time-of-use limitation is documented and deferred for snapshot staging.

## VM startup and reporting

Echoriad creates the VM only after resolving or building the selected image. Existing CPU, memory, network, and mount behavior remains unchanged.

Human-facing status distinguishes image building, cache reuse, completion, and failure. `/echoriad` reports the build-config path, abbreviated fingerprint, Gondolin build ID, and whether startup built or reused the image. Direct `image` selection retains the existing report.

The system prompt continues to report the guest workspace. It does not include approval details, local input paths, or build logs.

## Documentation requirements

The user documentation must cover configuration precedence, the Gondolin-owned schema, approval behavior, cache scope, external-input staleness, host network and environment access, noninteractive failure, unbounded image retention, concurrent duplicate builds, concurrent metadata updates, and the input-change race.

## Deferred work

- `issues/06-stage-approved-build-inputs.md`
- `issues/07-coordinate-concurrent-image-builds.md`
- `issues/08-gate-host-input-inspection.md`
- `issues/09-filter-image-build-environment.md`
- `issues/10-add-build-cache-commands.md`
