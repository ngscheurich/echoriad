# config command

Status: ready-for-agent

Blocked by: 02

`echoriad config` prints the effective resolved configuration for the project at cwd, per the spec (Commands: `echoriad config`).

Every field shows its origin: project (`.echoriad.json`), system (`$XDG_CONFIG_HOME/echoriad/config.json`), env (`ECHORIAD_IMAGE`), or built-in default. Scalars coalesce per-field (`project.x ?? system.x`, no env fallback for scalars today); the image selection follows `resolveImageSelection` precedence and is shown with its kind and canonical path (build-config path resolved against its declaring directory; selector-based images with their base dir). `--json` for scripting.

An invalid configuration file is an error with the standard form and a nonzero exit — never a silently degraded "resolved" view.
