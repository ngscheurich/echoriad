# Report automatic builds

Status: resolved

Blocked by: 01, 02

Extend `/echoriad` reporting for automatically built guest images.

Report the build-config path, abbreviated fingerprint, Gondolin build ID, and whether the current startup built or reused the image. Preserve the existing output for direct image selectors. Keep local input paths, authorization details, and build logs out of the command output and system prompt.

Add focused automated coverage for direct images, newly built images, reused images, unavailable VMs, and the absence of sensitive build details.

## Comments

Implemented in this slice. `resolveImageStartup` now carries an
`AutomaticBuildReport` (`configPath`, `abbreviatedFingerprint`, `buildId`,
`built`) on its memoized result, sourced from `prepareGuestImage`'s existing
return value — no changes to `src/` were needed.

The `/echoriad` command appends `Build config:`, `Fingerprint:` (12 hex
characters), `Gondolin build ID:`, and `Image source: built at startup /
reused cached image` after the existing lines when startup selected a build
config; direct image selectors keep the existing report unchanged. A failed
startup makes the command report "guest unavailable; see human-facing
diagnostics." without host paths or build details.

Coverage (5 new tests in `test/reporting.test.ts`, driven through the
extension fixture harness at the `/echoriad` command and `before_agent_start`
seams): direct images keep the existing output, newly built images, silently
reused images (second session, same cache, prompts forbidden), unavailable
VMs, and the absence of local input paths, build logs, and authorization
details from command output and the system prompt.

Note: the full suite (74 tests) passes; the two `authorization.test.ts`
failures seen when `TMPDIR` points inside this repository are an artifact of
running the tests inside the Gondolin VM (the temp dirs land inside the
`/workspace` git repo) and disappear with `TMPDIR=/tmp`.
