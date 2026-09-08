/**
 * Gondolin Tool Router
 *
 * Runs pi's built-in tools inside a local Gondolin micro-VM. The host working
 * directory is mounted at /workspace in the guest. File changes under
 * /workspace write through to the host; other guest filesystem changes are
 * isolated to the VM.
 *
 * Based on Earendil Works' `pi-extension-gondolin` example.
 *
 * Usage:
 *   Auto-discovered globally. Start pi in any project and the Gondolin VM
 *   tools take over for read/write/edit/bash/ls/find/grep. Or, load explicitly
 *   with: pi -e ~/.pi/agent/extensions/echoriad
 *
 * Requirements:
 *   - Node.js >= 23.6.0 for @earendil-works/gondolin
 *   - QEMU installed (for example, `brew install qemu` on macOS)
 *
 * Custom guest image:
 *   Set ECHORIAD_IMAGE to an image selector (`name:tag` or build ID) or a
 *   path to a directory containing the guest assets (vmlinuz-virt,
 *   initramfs.cpio.lz4, rootfs.ext4). When unset, Gondolin's default
 *   (alpine-base:latest, or $GONDOLIN_DEFAULT_IMAGE) is used.
 *
 * Automatic guest image builds:
 *   Instead of selecting an existing image, a configuration file may set
 *   "buildConfig" to a Gondolin build-config path. Echoriad fingerprints
 *   the config and its local inputs and reuses an authorized cached build
 *   silently; otherwise it shows the human-facing approval prompt before
 *   reusing a globally cached image or launching the bundled Gondolin CLI.
 *   Authorizations are stored per consumer under the Echoriad cache
 *   directory, so deleting that directory revokes them. A config file may
 *   define "image" or "buildConfig", not both. A project selector overrides
 *   both system selectors; ECHORIAD_IMAGE applies only when no file selects
 *   a source.
 *
 * Per-project configuration is read from `.echoriad.json` in the project root.
 * System-wide defaults are read from `$XDG_CONFIG_HOME/echoriad/config.json`
 * (defaulting to `~/.config/echoriad/config.json`); per-project fields
 * override the system-wide file, which in turn overrides `ECHORIAD_IMAGE`.
 *
 * Example configuration:
 *
 *   {
 *     "image": "my-custom:latest",        // optional, overrides ECHORIAD_IMAGE
 *     "buildConfig": "build-config.json", // mutually exclusive with "image"
 *     "cpus": 4,                          // optional, default 2
 *     "memory": "2G",                     // optional, default "1G" (QEMU)
 *     "mounts": {
 *       "/root/.pi": {
 *         "type": "host",
 *         "path": "~/.pi",
 *         "readonly": true
 *       },
 *       "/tmp/scratch": {
 *         "type": "memory"
 *       },
 *       "/mnt/extra": "extra"
 *     },
 *     "network": {
 *       "enabled": true,                    // optional, default true
 *       "allowedHosts": ["api.github.com"], // optional HTTP/HTTPS allowlist
 *       "secrets": {                        // host env -> guest placeholder
 *         "GITHUB_TOKEN": {
 *           "hosts": ["api.github.com"],
 *           "fromEnv": "GITHUB_TOKEN"
 *         }
 *       },
 *       "tcp": {                          // optional, raw TCP host mappings
 *         "postgres": "127.0.0.1:5432"    // guest host -> upstream host:port
 *       }
 *     }
 *   }
 *
 *  Mounts:
 *    - Key is the guest-absolute mount point
 *    - Strings configure read-write host mounts relative to project root
 *    - Object host mounts support `path` (~, $ENV expansion) and
 *      `readonly: true`
 *    - Memory mounts use `type: "memory"` and optional `readonly: true`
 *
 *  Networking:
 *    - `network.enabled`: set to `false` to disable networking entirely
 *    - `network.allowedHosts`: governs HTTP/HTTPS egress only
 *      (omitted = allow all; explicit list = allowlist; `[]` = deny all)
 *    - `network.tcp` maps raw-TCP destinations (e.g. databases)
 *
 *  `network.tcp` is required for non-HTTP protocols, which are otherwise
 *  blocked by Gondolin's protocol sniffer. TCP mappings require synthetic DNS,
 *  which the extension enables automatically when `network.tcp` is present.
 */

import path from "node:path";
import { VM } from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { loadProjectConfig, loadSystemConfig } from "../config.ts";
import { GuestImageError } from "../guest-image.ts";
import {
  GUEST_WORKSPACE,
  type HostMountMapping,
  type LoadedConfigs,
  resolveVmSpec,
} from "../vm-spec.ts";
import {
  createEchoriadBashOps,
  createEchoriadEditOps,
  createEchoriadFindOps,
  createEchoriadLsOps,
  createEchoriadReadOps,
  createEchoriadWriteOps,
  executeEchoriadGrep,
} from "./guest-tools.ts";
import { type ResolvedImageStartup, resolveImageStartup } from "./startup.ts";

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localGrep = createGrepTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localLs = createLsTool(localCwd);

  let vm: VM | undefined;
  let vmStarting: Promise<VM> | undefined;
  const shutdownController = new AbortController();
  let permanentStartupError: string | undefined;
  let resolvedImage: ResolvedImageStartup | undefined;
  let shellPath = "/bin/sh";
  let imageLabel = "default";
  let hostMounts: HostMountMapping[] = [];

  async function startVm(ctx: ExtensionContext | undefined, signal: AbortSignal): Promise<VM> {
    ctx?.ui.setStatus(
      "echoriad",
      ctx.ui.theme.fg("accent", `Echoriad: starting ${GUEST_WORKSPACE}`),
    );
    // Resolve the image source first: a selected build config is approved,
    // fingerprinted, and built (or reused) before the VM is created. The
    // result is memoized so a transient VM-creation failure does not prompt
    // (or rebuild) again on the next startup attempt. The configs are read
    // once per startup attempt so image selection, mounts, and network all
    // see the same file contents.
    const configs: LoadedConfigs = {
      project: loadProjectConfig(localCwd),
      system: loadSystemConfig(),
    };
    if (!resolvedImage) {
      resolvedImage = await resolveImageStartup(localCwd, configs, ctx, signal);
    }
    signal.throwIfAborted();
    const spec = resolveVmSpec({
      projectRoot: localCwd,
      configs,
      imagePath: resolvedImage.imagePath,
      sessionLabel: `pi ${path.basename(localCwd)}`,
    });
    imageLabel = resolvedImage.imageLabel;
    hostMounts = spec.hostMounts;
    const created = await VM.create(spec.options);
    if (signal.aborted) {
      await created.close();
      signal.throwIfAborted();
    }
    const bashProbe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
    shellPath = bashProbe.stdout.trim() || "/bin/sh";
    vm = created;
    ctx?.ui.setStatus(
      "echoriad",
      ctx.ui.theme.fg("accent", `Echoriad: ${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`),
    );
    ctx?.ui.notify(
      `Gondolin VM ready. ${localCwd} is mounted at ${GUEST_WORKSPACE}. Image: ${imageLabel}.`,
      "info",
    );
    return created;
  }

  async function ensureVm(ctx?: ExtensionContext, signal?: AbortSignal): Promise<VM> {
    const unavailable = () =>
      new Error("Echoriad: guest unavailable; see human-facing diagnostics.");
    if (shutdownController.signal.aborted || signal?.aborted) throw unavailable();
    if (vm) return vm;
    if (permanentStartupError) throw unavailable();
    if (!vmStarting) {
      // Startup is bound to the session-scoped shutdown signal only: a
      // per-tool-call signal never cancels the shared startup, which would
      // kill an in-flight build and every concurrent waiter with it.
      vmStarting = startVm(ctx, shutdownController.signal)
        .catch((error) => {
          if (error instanceof GuestImageError && error.permanent) {
            permanentStartupError = error.message;
          }
          // Startup details must never become tool errors in model context.
          if (ctx?.hasUI) ctx.ui.notify(String(error), "error");
          else process.stderr.write(`${error}\n`);
          throw unavailable();
        })
        .finally(() => {
          vmStarting = undefined;
        });
    }
    const starting = vmStarting;
    if (!signal) return starting;
    // Wait for the shared startup without owning it: an aborted tool call
    // stops only itself, and the abandoned promise stays observed.
    const caller = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(unavailable()), { once: true });
    });
    try {
      return await Promise.race([starting, caller]);
    } finally {
      starting.catch(() => {});
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shutdownController.abort();
    await vmStarting?.catch(() => {});
    const activeVm = vm;
    vm = undefined;
    if (!activeVm) return;
    ctx.ui.setStatus("echoriad", ctx.ui.theme.fg("muted", "Echoriad: stopping"));
    try {
      await activeVm.close();
    } finally {
      ctx.ui.setStatus("echoriad", undefined);
    }
  });

  pi.registerCommand("echoriad", {
    description: "Show Gondolin VM status",
    handler: async (_args, ctx) => {
      let activeVm: VM;
      try {
        activeVm = await ensureVm(ctx);
      } catch {
        // Startup already reported the failure to humans; the command keeps
        // host paths and build details out of its output.
        ctx.ui.notify("Echoriad: guest unavailable; see human-facing diagnostics.", "warning");
        return;
      }
      const lines = [
        `Gondolin VM: ${activeVm.id}`,
        `Host workspace: ${localCwd}`,
        `Guest workspace: ${GUEST_WORKSPACE}`,
        `Shell: ${shellPath}`,
        `Image: ${imageLabel}`,
      ];
      const build = resolvedImage?.build;
      if (build) {
        lines.push(
          `Build config: ${build.configPath}`,
          `Fingerprint: ${build.abbreviatedFingerprint}`,
          `Gondolin build ID: ${build.buildId}`,
          `Image source: ${build.built ? "built at startup" : "reused cached image"}`,
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx, signal);
      const tool = createReadTool(GUEST_WORKSPACE, {
        operations: createEchoriadReadOps(activeVm, localCwd, hostMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx, signal);
      const tool = createWriteTool(GUEST_WORKSPACE, {
        operations: createEchoriadWriteOps(activeVm, localCwd, hostMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx, signal);
      const tool = createEditTool(GUEST_WORKSPACE, {
        operations: createEchoriadEditOps(activeVm, localCwd, hostMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx, signal);
      const tool = createBashTool(GUEST_WORKSPACE, {
        operations: createEchoriadBashOps(activeVm, localCwd, shellPath, hostMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx, signal);
      const tool = createLsTool(GUEST_WORKSPACE, {
        operations: createEchoriadLsOps(activeVm, localCwd, hostMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx, signal);
      const tool = createFindTool(GUEST_WORKSPACE, {
        operations: createEchoriadFindOps(activeVm, localCwd, hostMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const activeVm = await ensureVm(ctx, signal);
      return executeEchoriadGrep(activeVm, localCwd, params, signal, hostMounts);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    const activeVm = await ensureVm(ctx);
    return {
      operations: createEchoriadBashOps(activeVm, localCwd, shellPath, hostMounts),
    };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // A permanent startup failure (approval denial, noninteractive session)
    // was already reported during session_start; do not attempt (and log)
    // the VM again here. The system prompt stays host-side, which is
    // truthful while no VM is running. Tools still fail closed through
    // ensureVm.
    if (permanentStartupError) return undefined;
    await ensureVm(ctx);
    const localLine = `Current working directory: ${localCwd}`;
    const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt };
  });
}
