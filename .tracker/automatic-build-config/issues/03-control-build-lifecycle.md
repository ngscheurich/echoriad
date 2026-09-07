# Control the build lifecycle

Status: ready-for-agent

Blocked by: 01

Complete subprocess lifecycle and human-facing diagnostics for automatic builds as defined by `.tracker/automatic-build-config/spec.md`.

Report building, cache reuse, completion, and failure without adding host paths, approval details, logs, or errors to model context. Stream Gondolin output to human-facing diagnostics. Preserve host environment and network behavior, and show the required warning for post-build commands.

Run the Gondolin CLI in a process group that Echoriad can terminate on cancellation or Pi shutdown. Remove Echoriad's temporary output directory after cancellation or failure. Do not authorize partial results. Preserve older images without falling back to them.

Keep concurrent builds independent and use unique output directories. Document the accepted duplicate-build and concurrent-input race behavior in code-facing tests where applicable.

Add focused automated coverage for statuses, diagnostic routing, environment inheritance, cancellation, process-group termination, temporary-directory cleanup, partial imports, and failure without stale fallback. Process tests must use a controlled child fixture rather than a real image build.

## Comments
