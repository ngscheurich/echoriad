# Test isolation

Status: needs-triage

Policy: tests must never read anything from the developer's real
environment. Disk writes from tests require maintainer approval per
instance; reads should go through an in-memory filesystem seam wherever
the filesystem is not the subject under test.

Evidence this is needed: `test/bash.test.ts`'s `scratchProject` helper
saved and restored `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` without setting
them, so `runBash` read the developer's real system config and failed
against a stale `buildConfig` path on the host while passing on a clean
VM. Each test file currently rolls its own environment save/restore, and
at least one got it wrong.

Scope boundary, decided with the maintainer: some suites genuinely
exercise filesystem semantics — `identity.test.ts` (realpath, symlinks,
git worktrees), `authorization.test.ts` (exclusive-create and atomic
rename), `images-store.test.ts` and `build-process.test.ts` (real
Gondolin CLI and store layout). For those, an in-memory mock tests the
mock. Issue 02 records the decision on where seams go and where real
filesystem semantics stay.
