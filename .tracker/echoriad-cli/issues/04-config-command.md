# config command

Status: resolved

Blocked by: 02

`echoriad config` prints the effective resolved configuration for the project at cwd, per the spec (Commands: `echoriad config`).

Every field shows its origin: project (`.echoriad.json`), system (`$XDG_CONFIG_HOME/echoriad/config.json`), env (`ECHORIAD_IMAGE`), or built-in default. Scalars coalesce per-field (`project.x ?? system.x`, no env fallback for scalars today); the image selection follows `resolveImageSelection` precedence and is shown with its kind and canonical path (build-config path resolved against its declaring directory; selector-based images with their base dir). `--json` for scripting.

An invalid configuration file is an error with the standard form and a nonzero exit — never a silently degraded "resolved" view.

## Comments

Implemented on top of 02. `src/cli/config-command.ts` renders the view:
the image selection with its kind and canonical path (build-config
paths resolved, selector-based images with their base dir), and every
scalar annotated with the layer it coalesced from — project, system,
env, or built-in default. `ImageSelection` gained an `origin` field on
its image and default variants, so the view attributes the selection
without re-deriving precedence at the display site. `--json` carries
the same information as the human form. Invalid project or system
config files error with the standard form and exit 1; stdout stays
empty. Handlers now receive a `CommandContext` (cwd, env, the loaded
system config, the project-config loader) threaded from `main`, so
commands test without a TTY or real config files. `config` takes no
positional arguments; unknown options and positionals fail closed
through the error seam. Landed on branch `echoriad-cli-config` (plus
a lockfile chore syncing the `bin` entry).
