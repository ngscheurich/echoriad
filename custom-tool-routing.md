# Custom tool containment and routing plan

## Goal

Ensure that every agent-callable tool registered by another Pi extension is either implemented through Echoriad, explicitly approved to run on the host, or blocked before execution.

## Feasibility

A configuration file can safely allow or block another extension's tools, but it cannot generically move their implementations into Gondolin. A custom tool's `execute()` function is arbitrary host-side JavaScript and may call `node:fs`, `child_process`, `fetch`, `pi.exec()`, or child-session APIs directly.

The following behavior was verified against the fetched `@earendil-works/pi-coding-agent` version `0.84.4` package:

- `tool_call` runs before every agent tool, including tools registered by extensions, and can block execution.
- `pi.getAllTools()` reports each tool's `sourceInfo`.
- `pi.setActiveTools()` can hide tools, although call-time blocking remains the stronger enforcement boundary.
- `pi.exec()` invokes the host's process execution helper directly.
- When extensions register the same tool name, the first extension in load order wins, while extension discovery within a directory is not explicitly sorted.

The installed Pi version must be checked before implementation because the compatibility report was produced against a different Pi commit.

## Policy model

Use three distinct terms throughout the implementation and documentation:

1. **Routed**: Echoriad owns the tool implementation and runs its effects through Gondolin.
2. **Host passthrough**: the original extension implementation runs on the host after explicit approval.
3. **Blocked**: the tool remains registered but cannot execute.

Unknown custom tools should default to blocked. Host passthrough must not be described as routing.

## Phase 1: Call-time enforcement

Add a `tool_call` handler in `index.ts` that evaluates every invocation against the effective tool policy.

For each call, the handler should:

- Look up the registered tool through `pi.getAllTools()`.
- Check the tool's source rather than trusting its name alone.
- Permit tools whose active definitions are owned and routed by Echoriad.
- Permit explicitly approved host-passthrough tools.
- Block every other tool with an actionable explanation.

Blocked tools may also be removed from Pi's active tool set so the model does not repeatedly attempt to call them. The call-time handler remains the enforcement boundary because another extension may dynamically register or reactivate tools.

This phase makes packages such as `@tintinweb/pi-subagents` fail closed: `Agent`, `SubagentWorkflow`, `get_subagent_result`, and `steer_subagent` are stopped before their host-side implementations begin. It does not make those tools useful through Gondolin.

The policy does not cover extension activity outside agent tool calls. Zentui's automatic host-side Git and runtime probes, for example, still require their restricted configuration or changes to Zentui itself.

## Phase 2: Configuration and trust boundaries

Add a custom-tool policy to the system configuration. A tentative shape is:

```json
{
  "customTools": {
    "default": "block",
    "hostPassthrough": [
      {
        "name": "some_safe_tool",
        "extension": "/absolute/path/to/extension/index.ts"
      }
    ]
  }
}
```

Host-passthrough approval must come from the system or user configuration. `.echoriad.json` is project-controlled and potentially agent-writable, so it must not be able to weaken the host policy. Project configuration may add denials or enable a known Gondolin-backed adapter, but it must not approve arbitrary host execution.

Each approval should bind the tool name to the extension's identity. A name-only approval could unintentionally authorize a different extension that registers the same name. The implementation should determine whether Pi's `sourceInfo` provides a sufficiently stable identity; if not, Echoriad should require an exact canonical extension path or request a stable package identity from Pi.

## Phase 3: Routed tool adapters

Introduce a code-level adapter interface for tools that can be implemented through Echoriad. Do not support arbitrary JSON command templates as a substitute for an audited adapter.

```ts
interface EchoriadToolAdapter {
  toolName: string;
  matchesSource(sourceInfo: SourceInfo): boolean;
  createTool(backend: EchoriadBackend): ToolDefinition;
}
```

The reusable backend should provide:

- guest process execution;
- guest filesystem operations;
- native tool factories;
- host-to-guest path translation;
- VM acquisition keyed by the requested working directory rather than captured `process.cwd()`.

Only adapters implemented and reviewed in code count as routed. Configuration merely selects a known adapter.

## Phase 4: Reliable tool replacement in Pi

Pi's current `tool_call` hook can block a tool or mutate its input, but it cannot return a replacement result. Registering a replacement under the same name is also unreliable because the first extension in load order wins and discovery order is not explicitly sorted.

Pursue one or more upstream Pi changes:

- allow `tool_call` to return a complete replacement result;
- add tool-execution middleware that can wrap another extension's tool;
- define deterministic tool override precedence;
- expose an injectable process and filesystem backend for extensions and child sessions.

Until reliable replacement exists, an Echoriad adapter should use an Echoriad-owned tool name, hide or block the original tool, and direct the model to the routed replacement.

## Phase 5: Coordinated `pi-subagents` integration

A generic adapter is not enough to contain `@tintinweb/pi-subagents`. A compatible implementation requires coordinated changes:

- Construct every child session with Gondolin-backed native tools for that child's actual working directory.
- Select the backend by child or worktree path instead of using the parent process's `process.cwd()`.
- Ensure that `isolated: true` and `extensions: false` cannot restore host-native tools.
- Move Git detection, worktree operations, and workflow gate commands away from host `pi.exec()`.
- Give workflow path reads and generated artifacts an explicit guest-versus-host policy.
- Apply the same routing to nested, scheduled, and resumed agents.
- Define one shared mapping between host worktrees, guest mounts, and cleanup behavior.

## Testing

Add focused tests for the policy layer:

- An unknown custom tool is blocked before its `execute()` function runs.
- A system-approved host-passthrough tool is allowed.
- Project configuration cannot add host-passthrough approval.
- A dynamically registered tool is still blocked.
- A source and name collision cannot impersonate an approved tool.
- A foreign extension registering `bash` cannot displace Echoriad unnoticed.
- A blocked call returns a useful model-visible reason.
- Extension background activity is documented and tested as outside the tool-call policy boundary.

Add end-to-end containment tests for the subagent integration covering ordinary, isolated, nested, scheduled, resumed, workflow, and worktree sessions. Each test should prove that the subagent cannot execute a host command or create a marker outside approved mounts.

## Delivery order

1. Add custom-tool classification and fail-closed call-time enforcement.
2. Add the system configuration policy and project-level restriction rules.
3. Extract a reusable Echoriad backend keyed by working directory.
4. Add the adapter API and pursue the required Pi integration points.
5. Implement and test the coordinated `pi-subagents` adapter.

The first delivery should prevent silent custom-tool bypasses without claiming that blocked or approved host tools have been routed through Gondolin.
