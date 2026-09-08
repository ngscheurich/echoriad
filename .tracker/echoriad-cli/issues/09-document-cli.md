# Document the CLI

Status: ready-for-agent

Blocked by: 03, 04, 05, 06, 07, 08

Documentation catches up with the shipped CLI, per the spec.

- README: a CLI section covering every command, `--plain`/`ECHORIAD_PLAIN`, the system-config `plain` field, `--json` surfaces, and the sharing of approval/consumer identity with pi (approve once, reuse in both).
- README and `index.ts` header: the automatic-builds section states that external input changes still do not invalidate the cache and that `echoriad build --force` is now the supported forced rebuild.
- `automatic-build-config/spec.md` and its issue 10 non-goals reference this feature where the CLI supersedes them (forced rebuild; store-layout removal with the defended approach).
- Command help text uses the glossary term "guest image"; docs never call selector-selected images Echoriad's.
- AGENTS.md layout is handled by issue 01, not here.
