# Control the build lifecycle

Status: resolved

Blocked by: 01

Complete subprocess lifecycle and human-facing diagnostics for automatic builds as defined by `.tracker/automatic-build-config/spec.md`.

Report building, cache reuse, completion, and failure without adding host paths, approval details, logs, or errors to model context. Stream Gondolin output to human-facing diagnostics. Preserve host environment and network behavior, and show the required warning for post-build commands.

Run the Gondolin CLI in a process group that Echoriad can terminate on cancellation or Pi shutdown. Remove Echoriad's temporary output directory after cancellation or failure. Do not authorize partial results. Preserve older images without falling back to them.

Keep concurrent builds independent and use unique output directories. Document the accepted duplicate-build and concurrent-input race behavior in code-facing tests where applicable.

Add focused automated coverage for statuses, diagnostic routing, environment inheritance, cancellation, process-group termination, temporary-directory cleanup, partial imports, and failure without stale fallback. Process tests must use a controlled child fixture rather than a real image build.

## Comments

Implemented in commit a821588. `runGondolinBuild` spawns the bundled CLI
as a detached process group leader; an `AbortSignal` threaded from pi
(aborting a caller's cancel, `session_shutdown`, or a tool call) sends
SIGTERM to the group and escalates to SIGKILL after one second, so
descendants that ignore SIGTERM still die. Cancellation checks sit at
each phase boundary (pre-spawn, post-approval, post-build, post-resolve),
and the temporary output directory is removed on every exit path.

Diagnostics: `prepareGuestImage` emits building / cache-reuse /
completion / failure statuses; Gondolin output streams to the pi status
line (stderr in headless modes) and never enters model context. Startup
failures and the failure-output tail go to `ui.notify` or stderr; tool
callers receive a generic "guest unavailable" error instead.

Coverage: `test/build-process.test.ts` drives `runGondolinBuild` with a
controlled child fixture (output routing, host env inheritance, group
termination of a SIGTERM-ignoring descendant, already-cancelled
never-spawn). `test/extension-lifecycle.test.ts` loads the real
`index.ts` with module hooks stubbing pi's tool helpers, Gondolin's
store/VM, and the spawn boundary: build failure routes to humans only,
tools fail without host details, and shutdown kills an in-flight build
promptly. `test/guest-image.test.ts` adds status sequences, cancellation
without authorization (imported objects stay unauthorized), temp-dir
cleanup, and the accepted duplicate-build / unique-output-dir /
input-race behavior.

Note: per-chunk notifications were considered for output streaming and
rejected as TUI spam; the latest line replaces the status instead.
Process checks read `ps` once instead of per-PID for portability.
