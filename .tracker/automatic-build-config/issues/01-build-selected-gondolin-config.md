# Build a selected Gondolin config

Status: ready-for-agent

Implement the first end-to-end automatic build path from `.tracker/automatic-build-config/spec.md`.

Add the `buildConfig` field to project and system configuration. Enforce mutual exclusion with `image`, preserve the existing selector precedence and `ECHORIAD_IMAGE` fallback, and resolve relative paths against the declaring configuration's directory.

Parse the selected file with the installed Gondolin package. Compute the complete semantic fingerprint defined by the spec, including recognized local inputs, Gondolin version, and fingerprint-schema version. Reject unsupported filesystem nodes and invalid inputs with actionable errors.

Before an uncached build, show the specified human-facing approval prompt. Fail closed when approval is denied or unavailable. Resolve the bundled Gondolin CLI from the package dependency, launch it with a unique output directory and internal fingerprint-derived image reference, and start the VM from the successfully imported image.

This slice may prompt on every startup until issue 02 adds cache authorization. It must not build before approval or place prompt and build details in model context.

Add focused automated coverage for configuration precedence, path resolution, mutual exclusion, canonical fingerprint stability, local-input invalidation, special-node rejection, approval denial, noninteractive failure, command construction, build failure, and successful VM image selection. Tests may isolate process and UI boundaries rather than launch QEMU.

## Comments
