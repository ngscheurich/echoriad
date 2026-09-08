# status command

Status: ready-for-agent

Blocked by: 02

`echoriad status` reports the guest-image state of the project at cwd, per the spec (Commands: `echoriad status`).

Compute the selected source (project / system / env / default, with the resolved build-config path or selector value), the current build fingerprint (abbreviated and full for JSON), and one verdict: `up to date`, `needs build`, `needs approval` (image exists but the consumer's association is missing or its build id is stale), or `no image selected`. Exit 0 unless the configuration is invalid, then the standard error form. `--json` carries the complete state including the full fingerprint.

Human output goes through the ui seam; verdict words carry the meaning. Status never prompts.
