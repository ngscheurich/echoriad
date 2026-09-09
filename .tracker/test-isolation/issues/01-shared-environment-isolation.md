# Shared environment isolation helper

Status: ready-for-agent

One test helper that every suite uses to isolate the process environment,
replacing the per-file save/restore blocks that drifted apart.

Covers at minimum: `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `ECHORIAD_IMAGE`,
`HOME`, and `process.chdir` (save/restore). Pointed-at directories need
not exist; missing files read as absent. Every test file that touches any
of these today (`bash.test.ts`, `cli.test.ts`, `authorization.test.ts`,
`images-store.test.ts`, `extension-lifecycle.test.ts`, `reporting.test.ts`,
and the CLI command suites) migrates onto it.

A follow-on audit lists every remaining read of process state reachable
from tests (`os.homedir`, `process.platform`, `require.resolve` of
package metadata) and either isolates or explicitly documents each one as
environment-independent.

Verification: the suite passes with a developer-owned
`~/.config/echoriad/config.json` present on macOS. Reproduce the original
failure by reverting the helper in a scratch branch if needed.
