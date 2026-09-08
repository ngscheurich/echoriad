# Echoriad

> Alae! Ered en Echoriath, ered e·mbar nín!

Runs [Pi]'s built-in file and shell tools inside a local [Gondolin] micro-VM so that everything the agent reads, writes, edits, lists, finds, greps, and shells into executes in an isolated Linux guest instead of directly on your host.

The host working directory is mounted at `/workspace` in the guest. File changes under `/workspace` write through to the host; any other filesystem changes the agent makes stay isolated inside the VM and are discarded when the VM stops.

## Requirements

- **[Node.js] >= 23.6.0** (required by `@earendil-works/gondolin`)
- **[QEMU]** installed and on your `PATH` (e.g. `brew install qemu` on macOS)

## Installation

```sh
pi install git:github.com/ngscheurich/echoriad
```

## How it works

On `session_start` the extension boots a Gondolin VM (lazily — only when the first tool needs it) and mounts the current host working directory at `/workspace` in the guest via a real-FS provider. Each Pi tool is re-registered so its operations run against the guest:

| Tool                      | Backing                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `read` / `write` / `edit` | guest VFS (writes under `/workspace` reach the host)               |
| `bash`                    | `vm.exec` inside the guest, using `/bin/sh` or `bash` if available |
| `ls` / `find` / `grep`    | guest VFS enumeration and file reads                               |

Paths you give the tools are translated between host and guest automatically. A relative path resolves against `/workspace`. An absolute path inside the host working directory or any configured host mount maps into the corresponding guest mount. Any other path is treated as a guest-absolute path.

On `session_shutdown` the VM is closed. The system prompt is rewritten so the agent sees its working directory as `/workspace` rather than the host path.

## The `echoriad` command

The extension registers a `/echoriad` command that reports VM status:

```
Gondolin VM: <id>
Host workspace: /Users/you/project
Guest workspace: /workspace
Shell: /bin/bash
Image: default
```

When startup selected a [build config](#automatic-image-builds) rather than an existing image, the report also includes the build-config path, the abbreviated fingerprint, the Gondolin build ID, and whether the image was built at startup or reused from cache:

```
Build config: /Users/you/project/build/gondolin.json
Fingerprint: <12 hex chars>
Gondolin build ID: <build id>
Image source: built at startup | reused cached image
```

## Automatic image builds

Instead of selecting an existing guest image, a configuration file can set `buildConfig` to the path of a [Gondolin] build config. Echoriad then builds the guest image from that build config before starting the VM, reusing a cached build when the inputs are unchanged.

**Gondolin owns image composition and the build-config schema.** Echoriad does not define package lists or any other image-composition field; see Gondolin's documentation for what a build config may contain. Echoriad owns source selection, approval, fingerprinting, cache reuse, and the build process lifecycle.

### Selecting a build config

`buildConfig` is a string field accepted in both `.echoriad.json` and the system configuration:

```json
{
  "buildConfig": "build/gondolin.json"
}
```

A relative `buildConfig` path resolves against the directory of the configuration file that declared it — the project root for `.echoriad.json`, the system configuration directory (`$XDG_CONFIG_HOME/echoriad/`) for the system file. Absolute paths stay absolute. A project `buildConfig` overrides both a system `buildConfig` and a system `image`; other scalar fields keep their existing independent precedence.

Defining `buildConfig` and `image` in the same file is an error. Missing files, directories in place of files, invalid JSON, and build configs rejected by Gondolin stop startup with an error naming the offending file.

### Fingerprinting and rebuilds

Echoriad parses the build config with the installed Gondolin package and computes a fingerprint over:

- a canonical serialization of the parsed config (object keys sorted recursively, array order preserved, JSON formatting irrelevant);
- the contents of every referenced local input the Gondolin schema recognizes — for Gondolin 0.12.0, custom init scripts, every `postBuild.copy` source, custom sandbox helper binaries, and any supported distribution expression path;
- the installed Gondolin package version and an Echoriad fingerprint-schema version.

Relative input paths resolve against the build config's directory. File timestamps do not affect the fingerprint. Any semantic change to the build config or a referenced local input produces a new fingerprint and a rebuild on the next startup.

**External inputs are not fingerprinted.** Package repository contents, mutable OCI tags, mutable container tags, remote downloads, and host tool behavior do not change the fingerprint and therefore do not trigger a rebuild. Until a forced-rebuild command exists (see [Limitations](#limitations)), creating a meaningful local change to the build config is the supported way to produce a new fingerprint.

Echoriad reads and hashes declared local inputs **before** showing the approval prompt. A build config that references large or external host paths (a home directory, a network mount) can therefore cause host filesystem traversal before a prompt appears. File contents and hashes are never disclosed to the guest or the model.

### Global cache and consumer-scoped authorization

A successful build is imported into Gondolin's content-addressed image store under an internal image reference derived from the fingerprint. The cache is global, not per-project: any consumer whose inputs produce the same fingerprint can reuse that build without repeating it.

Silent reuse requires a stored authorization association between:

- the **consumer** — for a Git project, the canonical common Git directory, so linked worktrees share authorization while separate clones stay separate; for a non-Git project, the canonical project root; a build config selected by the system configuration has system-wide consumer scope;
- the **build-config identity** — the repository-relative path for a build config inside the repository, or its canonical absolute path otherwise;
- the **fingerprint**; and
- the Gondolin build ID it resolved to.

Associations live in cache metadata at `${XDG_CACHE_HOME:-$HOME/.cache}/echoriad/image-authorizations.json`. Deleting that file revokes all approvals and causes later prompts; there is no separate durable approval database.

Echoriad never falls back to an image produced for an older fingerprint. A missing or invalid Gondolin image object makes the cache entry unusable: Echoriad requests approval again before rebuilding.

### Approval

The first time a consumer meets a given fingerprint — or a new consumer adopts a globally cached build — Echoriad shows an interactive approval prompt before any build or selection. It distinguishes building from cached reuse and shows:

- the consumer and project root;
- the canonical build-config path;
- all resolved local input paths, highlighting paths outside the project;
- `postBuild.commands` verbatim;
- OCI and container image references;
- custom init-script and sandbox-helper paths;
- whether Gondolin may run this build in a privileged container;
- three standing warnings: building uses host network access independently of guest `network` policy; the Gondolin process inherits the host environment; and build output may contain host data.

Approval applies only to the displayed consumer, build-config identity, and fingerprint. Cancel or denial stops VM startup.

A **noninteractive session** that requires approval fails before building or selecting the image and instructs you to open the project interactively once to approve it.

### The build process

Echoriad resolves the Gondolin CLI from the installed `@earendil-works/gondolin` dependency rather than from `PATH`, and launches it as a child process with the selected build config, a unique temporary output directory, and the fingerprint-derived image reference.

The child inherits the host environment and host network access to preserve Gondolin CLI behavior. Guest `network` policy does not govern build traffic. Builds containing `postBuild.commands` receive an explicit environment warning, because native Linux chroot commands can see inherited host variables.

Build output streams to human-facing diagnostics only. Build logs, resolved host paths, approval details, and errors never enter model context or the system prompt; the system prompt continues to report only the guest workspace. A build failure stops VM startup and leaves older cached images untouched. Authorization metadata is written only after Gondolin has imported the image and Echoriad has resolved it.

On cancellation or Pi shutdown, Echoriad terminates the Gondolin subprocess group and removes its temporary output directory. An image imported before cancellation may remain in Gondolin's store, but it receives no authorization and is adopted only through a later approved reuse.

### Limitations

Known limitations of the first release, tracked as deferred issues:

- **Unbounded cache retention, no build or cache commands.** External input changes do not invalidate the cache; cached Gondolin image objects are retained indefinitely and may accumulate. There is no forced-rebuild, cache-inspection, or cleanup command. (`.tracker/automatic-build-config/issues/10-add-build-cache-commands.md`)
- **Duplicate concurrent builds.** Builds are not locked by fingerprint; concurrent sessions may perform duplicate builds. Each build uses a unique temporary output directory. (`.tracker/automatic-build-config/issues/07-coordinate-concurrent-image-builds.md`)
- **Concurrent metadata updates.** Concurrent metadata writers may discard each other's new authorization associations. This can cause a later approval prompt but never grants authorization. (`.tracker/automatic-build-config/issues/07-coordinate-concurrent-image-builds.md`)
- **Input-change race (time-of-check/time-of-use).** Echoriad invokes Gondolin against the approved original paths; another process can change an input between fingerprinting and Gondolin reading it. (`.tracker/automatic-build-config/issues/06-stage-approved-build-inputs.md`)
- **Preapproval host traversal.** Fingerprinting reads and hashes declared local inputs before approval, so a project-controlled build config can cause host filesystem traversal before you see a prompt. (`.tracker/automatic-build-config/issues/08-gate-host-input-inspection.md`)
- **Inherited build environment.** The build subprocess inherits the host environment unfiltered; a documented allowlist is deferred. (`.tracker/automatic-build-config/issues/09-filter-image-build-environment.md`)
- **Container builds are not cancelled daemon-side.** Cancelling a build that runs in a container (builds with `postBuild.commands` on a macOS host via Docker/colima) terminates the Gondolin client, but the daemon-owned container keeps running until its steps finish. Native builds cancel cleanly. (`.tracker/automatic-build-config/issues/11-cancel-container-builds-daemon-side.md`)

## Configuration

Configuration is read from two files, merged with the **project file winning** over the system file on a per-field basis:

1. **System-wide**: `$XDG_CONFIG_HOME/echoriad/config.json` (defaulting to `~/.config/echoriad/config.json` when `XDG_CONFIG_HOME` is unset) — defaults applied to every project.
2. **Per-project**: `.echoriad.json` in the project root.

Both files use the same schema. `buildConfig` and `image` occupy one logical image-selection slot: a configuration file that defines both is invalid. A project selector overrides both system selectors. When no project selector exists, Echoriad uses the system selector; with neither, it falls back to the `ECHORIAD_IMAGE` env var and then Gondolin's default. `cpus` and `memory` fall back per-field from project config to system config. `network` and `mounts` are only meaningful in the per-project file (they are inherently project-relative).

See [Automatic image builds](#automatic-image-builds) for the `buildConfig` behavior.

### System-wide defaults

`$XDG_CONFIG_HOME/echoriad/config.json` (defaulting to `~/.config/echoriad/config.json`) is read first and applies to every project. It's the natural place to pin a default image:

```json
{
  "image": "my-base:latest",
  "cpus": 2,
  "memory": "2G"
}
```

Any field set in a project's `.echoriad.json` overrides the system-wide value, so a project can still opt into a different image while inheriting the rest.

### Example

```json
{
  "image": ".vm/assets",
  "cpus": 4,
  "memory": "2G",
  "network": {
    "enabled": true,
    "allowedHosts": ["api.github.com"],
    "secrets": {
      "GITHUB_TOKEN": {
        "hosts": ["api.github.com"],
        "fromEnv": "GITHUB_TOKEN"
      }
    },
    "tcp": {
      "postgres": "127.0.0.1:5432"
    }
  },
  "mounts": {
    "/root/.pi": {
      "type": "host",
      "path": "~/.pi",
      "readonly": true
    },
    "/tmp/scratch": {
      "type": "memory"
    },
    "/mnt/extra": "extra"
  }
}
```

### Fields

| Field     | Description                                                                                                                                                                                                                                                                                                                                   | Default                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `buildConfig` | Path to a [Gondolin build config](#automatic-image-builds). A relative path is resolved against the config file that supplied it (project root for `.echoriad.json`, the system config directory for the XDG file). Mutually exclusive with `image` in the same file. | none |
| `image`   | Guest image selector (`name:tag` or build id) or a path to a directory containing the guest assets (`vmlinuz-virt`, `initramfs.cpio.lz4`, `rootfs.ext4`). A relative path is resolved against the config file that supplied it (project root for `.echoriad.json`, the system config directory for the XDG file). Overrides `ECHORIAD_IMAGE`. | Gondolin default (`alpine-base:latest`, or `$GONDOLIN_DEFAULT_IMAGE`) |
| `cpus`    | Number of vCPUs                                                                                                                                                                                                                                                                                                                               | `2`                                                                   |
| `memory`  | VM memory, QEMU syntax (e.g. `"1G"`, `"512M"`)                                                                                                                                                                                                                                                                                                | `"1G"`                                                                |
| `network` | Network policy (see below)                                                                                                                                                                                                                                                                                                                    | enabled, allow all HTTP/HTTPS                                         |
| `mounts`  | Additional guest filesystem mounts (see below)                                                                                                                                                                                                                                                                                                | `{}`                                                                  |

### Network

- `network.enabled`: Set to `false` to disable networking entirely.
- `network.allowedHosts`: Governs **HTTP/HTTPS egress only** (omitted = allow all; an explicit list = allowlist; `[]` = deny all).
- `network.secrets`: Maps a host env var to a guest-side placeholder scoped to specific hosts. `fromEnv` defaults to the secret name. The referenced host env var **must** be set, or the extension errors out at VM start.
- `network.tcp`: Maps raw-TCP destinations (e.g. databases) from a guest hostname to an upstream `host:port`. Required for non-HTTP protocols, which are otherwise blocked by Gondolin's protocol sniffer. When `network.tcp` is present the extension enables synthetic per-host DNS automatically.

### Mounts

`mounts` keys map guest-absolute target paths to host directories or in-memory filesystems:

- Plain string shorthand (e.g. `"/mnt/extra": "extra"`): Maps to a read-write host directory relative to the project root.
- `type: "host"` (default when `path` is specified): Maps a host directory into the guest. `path` resolves relative to the project root, expands `~` to the user home directory, and interpolates `$VAR` and `${VAR}` environment variables. Echoriad throws an error at startup if the resolved host directory does not exist or is not a directory.
- `type: "memory"`: Backs the mount with an isolated, temporary in-memory filesystem.
- `readonly: true`: Blocks write operations on the mount.

## Environment variables

| Variable                 | Purpose                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `ECHORIAD_IMAGE`         | Fallback guest image selector / asset directory when `image` is not set in either config file                         |
| `XDG_CONFIG_HOME`        | Base config directory (default `$HOME/.config`); the system file is read from `$XDG_CONFIG_HOME/echoriad/config.json` |
| `GONDOLIN_DEFAULT_IMAGE` | Overrides Gondolin's bundled default image                                                                            |

## Credits

Based on Earendil Works' [`pi-extension-gondolin`] example.

[gondolin]: https://earendil-works.github.io/gondolin/
[node.js]: https://nodejs.org/en
[pi]: https://pi.dev/
[`pi-extension-gondolin`]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/gondolin/index.ts
[qemu]: https://www.qemu.org/
