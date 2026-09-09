# Filesystem mocking scope

Status: needs-triage

Decide where in-memory filesystem seams go and where real filesystem
semantics stay. This is a policy decision for the maintainer, recorded
here once made.

Candidates for seams (filesystem is incidental):

- `src/config.ts` — config loading is otherwise string-in/string-out.
- `src/fingerprint.ts` — local-input hashing reads declared paths; the
  hashing logic is pure once the bytes are read.
- `src/cli/config-command.ts`, `status.ts` — thin readers over config.

Where the filesystem is the subject under test (no seam; keep real):

- `src/identity.ts` — realpath, symlink, and git worktree semantics.
- `src/authorization.ts` — exclusive-create and atomic-rename behavior.
- `src/guest-image.ts` build pipeline — real Gondolin CLI child
  processes, cancellation, store layout.

Open question for the maintainer: seam style. Either dependency-inject
an fs interface through the modules above, or use `node:test`'s
`mock.method(fs, ...)` per test. No build step exists to lean on
(jest-style module mocking is unavailable; Node runs the TypeScript
source directly). The inject option is more code but explicit; the mock
option is less code but mutates shared module state per test.

Constraint from the maintainer: every remaining instance of a test
writing to the disk needs individual approval. The audit in issue 01
produces that list.
