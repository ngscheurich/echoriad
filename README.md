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

Paths you give the tools are translated between host and guest automatically. A relative path resolves against `/workspace`; an absolute path inside the host working directory maps into `/workspace`; anything else is treated as a guest-absolute path.

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

## Configuration

Per-project configuration is read from `.echoriad.json` in the project root.

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
  }
}
```

### Fields

| Field     | Description                                                                                                                                                                                                                                 | Default                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `image`   | Guest image selector (`name:tag` or build id) or a path to a directory containing the guest assets (`vmlinuz-virt`, `initramfs.cpio.lz4`, `rootfs.ext4`). A relative path is resolved against the project root. Overrides `ECHORIAD_IMAGE`. | Gondolin default (`alpine-base:latest`, or `$GONDOLIN_DEFAULT_IMAGE`) |
| `cpus`    | Number of vCPUs                                                                                                                                                                                                                             | `2`                                                                   |
| `memory`  | VM memory, QEMU syntax (e.g. `"1G"`, `"512M"`)                                                                                                                                                                                              | `"1G"`                                                                |
| `network` | Network policy (see below)                                                                                                                                                                                                                  | enabled, allow all HTTP/HTTPS                                         |

### Network

- `network.enabled`: Set to `false` to disable networking entirely.
- `network.allowedHosts`: Governs **HTTP/HTTPS egress only** (omitted = allow all; an explicit list = allowlist; `[]` = deny all).
- `network.secrets`: Maps a host env var to a guest-side placeholder scoped to specific hosts. `fromEnv` defaults to the secret name. The referenced host env var **must** be set, or the extension errors out at VM start.
- `network.tcp`: Maps raw-TCP destinations (e.g. databases) from a guest hostname to an upstream `host:port`. Required for non-HTTP protocols, which are otherwise blocked by Gondolin's protocol sniffer. When `network.tcp` is present the extension enables synthetic per-host DNS automatically.

## Environment variables

| Variable                 | Purpose                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `ECHORIAD_IMAGE`         | Fallback guest image selector / asset directory when `image` is not set in config |
| `GONDOLIN_DEFAULT_IMAGE` | Overrides Gondolin's bundled default image                                        |

## Credits

Based on Earendil Works' [`pi-extension-gondolin`] example.

[gondolin]: https://earendil-works.github.io/gondolin/
[node.js]: https://nodejs.org/en
[pi]: https://pi.dev/
[`pi-extension-gondolin`]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/gondolin/index.ts
[qemu]: https://www.qemu.org/
