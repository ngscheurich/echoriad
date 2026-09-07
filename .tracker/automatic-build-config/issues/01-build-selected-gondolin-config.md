# Build a selected Gondolin config

Status: resolved

Implement the first end-to-end automatic build path from `.tracker/automatic-build-config/spec.md`.

Add the `buildConfig` field to project and system configuration. Enforce mutual exclusion with `image`, preserve the existing selector precedence and `ECHORIAD_IMAGE` fallback, and resolve relative paths against the declaring configuration's directory.

Parse the selected file with the installed Gondolin package. Compute the complete semantic fingerprint defined by the spec, including recognized local inputs, Gondolin version, and fingerprint-schema version. Reject unsupported filesystem nodes and invalid inputs with actionable errors.

Before an uncached build, show the specified human-facing approval prompt. Fail closed when approval is denied or unavailable. Resolve the bundled Gondolin CLI from the package dependency, launch it with a unique output directory and internal fingerprint-derived image reference, and start the VM from the successfully imported image.

This slice may prompt on every startup until issue 02 adds cache authorization. It must not build before approval or place prompt and build details in model context.

Add focused automated coverage for configuration precedence, path resolution, mutual exclusion, canonical fingerprint stability, local-input invalidation, special-node rejection, approval denial, noninteractive failure, command construction, build failure, and successful VM image selection. Tests may isolate process and UI boundaries rather than launch QEMU.

## Comments

Implemented in commit c26f206. Configuration parsing and selection moved to
`src/config.ts` (`buildConfig` field, mutual exclusion with `image`, project >
system > `ECHORIAD_IMAGE` precedence, path resolution against the declaring
directory). Fingerprinting lives in `src/fingerprint.ts` (canonical JSON with
recursively sorted keys, Gondolin-0.12.0-recognized local inputs, Gondolin
package version, schema version 1; FIFOs/sockets/devices rejected). Build
orchestration lives in `src/guest-image.ts` (approval summary, fail-closed
noninteractive and denial handling, CLI resolved from the package dependency,
unique temp output dir, fingerprint-derived `echoriad-build-<fp>:latest` ref,
VM starts from the imported build id). 38 tests under `test/` run with
`npm test` (node:test); no QEMU required.

Notes: this slice prompts on every startup with a build config selected and
reuses a valid image object behind the fingerprint ref without persisted
authorization, as the issue allows; issue 02 replaces that with consumer-
scoped authorization. A transient VM-creation failure after a successful
image resolution does not re-prompt (the resolved image is memoized for the
session). In-pi smoke testing was not possible from this VM (the extension
runs on the host); wiring was verified by module tests plus a module-load
check of the modified index.ts.
