# Extract the shared core and split the package

Status: resolved

Blocked by: none

The CLI and the pi extension share config resolution, consumer/build identity, VM spec construction, the guest-image pipeline, and the approval summary. Today the router code all lives in `index.ts` (~950 lines), and the VM-options and identity construction are embedded in it, even though `echoriad bash` needs the identical VM construction.

Split the repository into three zones per `.tracker/echoriad-cli/spec.md` (Packaging and layout):

- Shared core stays flat in `src/` (one module per concern). Extract VM/sandbox spec construction (mount resolution, network/secrets handling, cpus/memory) and consumer/build identity derivation from `index.ts` into shared modules. The extension's resulting `VMOptions` must be byte-identical in behavior.
- `src/pi/` receives the router, extracted incrementally; `index.ts` at the root re-exports `src/pi/` so the pi manifest path (`pi.extensions: ["./index.ts"]`) keeps working unchanged.
- `src/cli/` is created (empty scaffolding is fine at this stage).

Update AGENTS.md's repository-layout section to match. `npm test`, `npm run check` pass; existing tests run unmodified or move with their modules.

## Comments

Implemented in commit aab6f9a. VM/sandbox spec construction moved to
`src/vm-spec.ts` (its `resolveVmSpec` takes the session label and image
path as parameters; the extension passes exactly the values `index.ts`
used to hardcode, so the resulting `VMOptions` are byte-identical).
Consumer/build identity moved to `src/identity.ts` — one correction to
this issue's framing: that derivation lived in `src/authorization.ts`,
not `index.ts`; `authorization.ts` keeps only the association store.
The router was extracted into `src/pi/` (router, startup, guest tools,
guest path mapping) and the root `index.ts` re-exports it, so the pi
manifest path is unchanged. Identity tests moved with their module to
`test/identity.test.ts`; the lifecycle and reporting suites run
unmodified. `test/vm-spec.test.ts` is new (14 tests) and covers the
seam the CLI's `bash` command will consume.
