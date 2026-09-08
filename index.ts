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
 *   Set ECHORIAD_IMAGE to an image selector (`name:tag` or build id) or a
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
 *     "image": "my-custom:latest",            // optional, overrides ECHORIAD_IMAGE
 *     "buildConfig": "build-config.json",     // optional; mutual exclusive with "image"
 *     "cpus": 4,                              // optional, default 2
 *     "memory": "2G",                         // optional, qemu syntax, default "1G"
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
 *       "enabled": true,                      // optional, default true
 *       "allowedHosts": ["api.github.com"],   // optional HTTP/HTTPS egress allowlist
 *       "secrets": {                          // optional, host env -> guest placeholder
 *         "GITHUB_TOKEN": {
 *           "hosts": ["api.github.com"],
 *           "fromEnv": "GITHUB_TOKEN"
 *         }
 *       },
 *       "tcp": {                              // optional, raw TCP host mappings
 *         "postgres": "127.0.0.1:5432"        //   guest host -> upstream host:port
 *       }
 *     }
 *   }
 *
 *  Mounts:
 *    - Key is the guest-absolute mount point
 *    - Strings configure read-write host mounts relative to the project root
 *    - Object host mounts support `path` (~, $ENV expansion) and `readonly: true`
 *    - Memory mounts use `type: "memory"` and optional `readonly: true`
 *
 *  Networking:
 *    - `network.enabled`: set to `false` to disable networking entirely
 *    - `network.allowedHosts`: governs HTTP/HTTPS egress only (omitted = allow all; explicit list = allowlist; `[]` = deny all)
 *    - `network.tcp` maps raw-TCP destinations (e.g. databases)
 *
 *  `network.tcp` is required for non-HTTP protocols, which are otherwise
 *  blocked by Gondolin's protocol sniffer. TCP mappings require synthetic DNS,
 *  which the extension enables automatically when `network.tcp` is present.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHttpHooks,
  MemoryProvider,
  ReadonlyProvider,
  RealFSProvider,
  type VirtualProvider,
  VM,
  type VMOptions,
} from "@earendil-works/gondolin";
import {
  loadProjectConfig,
  loadSystemConfig,
  resolveImageSelection,
  type HostMountConfig,
  type MemoryMountConfig,
  type MountConfig,
  type ProjectConfig,
  type ProjectNetworkConfig,
  type ProjectSecretConfig,
} from "./src/config.ts";
import {
  GuestImageError,
  prepareGuestImage,
} from "./src/guest-image.ts";
import { deriveBuildIdentity } from "./src/authorization.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  type EditOperations,
  type FindOperations,
  formatSize,
  type GrepToolDetails,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  truncateHead,
  truncateLine,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

type HostMountMapping = {
  hostPath: string;
  guestPath: string;
};

function toGuestPath(
  localCwd: string,
  inputPath: string,
  hostMounts?: HostMountMapping[],
): string {
  const trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return GUEST_WORKSPACE;

  const mappings =
    hostMounts && hostMounts.length > 0
      ? hostMounts
      : [{ hostPath: localCwd, guestPath: GUEST_WORKSPACE }];

  if (path.isAbsolute(trimmed)) {
    for (const mount of mappings) {
      if (isInsideHostPath(mount.hostPath, trimmed)) {
        const relativePath = path.relative(mount.hostPath, trimmed);
        return relativePath
          ? path.posix.join(mount.guestPath, toPosix(relativePath))
          : mount.guestPath;
      }
    }
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createEchoriadReadOps(
  vm: VM,
  localCwd: string,
  hostMounts?: HostMountMapping[],
): ReadOperations {
  return {
    readFile: async (filePath) =>
      vm.fs.readFile(toGuestPath(localCwd, filePath, hostMounts)),
    access: async (filePath) => {
      await vm.fs.access(toGuestPath(localCwd, filePath, hostMounts));
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix
        .extname(toGuestPath(localCwd, filePath, hostMounts))
        .toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

function createEchoriadWriteOps(
  vm: VM,
  localCwd: string,
  hostMounts?: HostMountMapping[],
): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      await vm.fs.writeFile(
        toGuestPath(localCwd, filePath, hostMounts),
        content,
        {
          encoding: "utf8",
        },
      );
    },
    mkdir: async (dirPath) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dirPath, hostMounts), {
        recursive: true,
      });
    },
  };
}

function createEchoriadEditOps(
  vm: VM,
  localCwd: string,
  hostMounts?: HostMountMapping[],
): EditOperations {
  const readOps = createEchoriadReadOps(vm, localCwd, hostMounts);
  const writeOps = createEchoriadWriteOps(vm, localCwd, hostMounts);
  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}

function createEchoriadLsOps(
  vm: VM,
  localCwd: string,
  hostMounts?: HostMountMapping[],
): LsOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(localCwd, filePath, hostMounts));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) =>
      vm.fs.stat(toGuestPath(localCwd, filePath, hostMounts)),
    readdir: async (dirPath) =>
      vm.fs.listDir(toGuestPath(localCwd, dirPath, hostMounts)),
  };
}

async function walkGuestFiles(
  vm: VM,
  root: string,
  visit: (guestPath: string, relativePath: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const stat = await vm.fs.stat(root, { signal });
  if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

  const walkDirectory = async (
    dir: string,
    relativeDir: string,
  ): Promise<boolean> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const entries = await vm.fs.listDir(dir, { signal });
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const guestPath = path.posix.join(dir, entry);
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, entry)
        : entry;
      let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
      try {
        entryStat = await vm.fs.stat(guestPath, { signal });
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (!(await walkDirectory(guestPath, relativePath))) return false;
      } else if (!(await visit(guestPath, relativePath))) {
        return false;
      }
    }
    return true;
  };

  return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
  const normalizedPattern = toPosix(pattern);
  if (normalizedPattern.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, normalizedPattern) ||
      path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
    );
  }
  return path.posix.matchesGlob(
    path.posix.basename(relativePath),
    normalizedPattern,
  );
}

function createEchoriadFindOps(
  vm: VM,
  localCwd: string,
  hostMounts?: HostMountMapping[],
): FindOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(localCwd, filePath, hostMounts));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const root = toGuestPath(localCwd, cwd, hostMounts);
      const results: string[] = [];
      await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
        if (results.length >= options.limit) return false;
        if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
        return results.length < options.limit;
      });
      return results;
    },
  };
}

function createLineMatcher(
  pattern: string,
  literal: boolean | undefined,
  ignoreCase: boolean | undefined,
) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) =>
      (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
  outputLines: string[];
  lines: string[];
  relativePath: string;
  lineIndex: number;
  contextLines: number;
}): boolean {
  let linesTruncated = false;
  const start =
    params.contextLines > 0
      ? Math.max(0, params.lineIndex - params.contextLines)
      : params.lineIndex;
  const end =
    params.contextLines > 0
      ? Math.min(
          params.lines.length - 1,
          params.lineIndex + params.contextLines,
        )
      : params.lineIndex;

  for (let index = start; index <= end; index++) {
    const rawLine = params.lines[index] ?? "";
    const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
    if (wasTruncated) linesTruncated = true;
    const separator = index === params.lineIndex ? ":" : "-";
    params.outputLines.push(
      `${params.relativePath}${separator}${index + 1}${separator} ${text}`,
    );
  }
  return linesTruncated;
}

async function executeEchoriadGrep(
  vm: VM,
  localCwd: string,
  params: GrepToolInput,
  signal?: AbortSignal,
  hostMounts?: HostMountMapping[],
): Promise<TextToolResult<GrepToolDetails>> {
  const root = toGuestPath(localCwd, params.path ?? ".", hostMounts);
  const rootStat = await vm.fs.stat(root, { signal });
  const rootIsDirectory = rootStat.isDirectory();
  const matcher = createLineMatcher(
    params.pattern,
    params.literal,
    params.ignoreCase,
  );
  const contextLines =
    params.context && params.context > 0 ? params.context : 0;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
  const outputLines: string[] = [];
  const details: GrepToolDetails = {};
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;

  await walkGuestFiles(
    vm,
    root,
    async (guestPath, relativePath) => {
      if (matchCount >= effectiveLimit) return false;
      if (params.glob && !matchesToolGlob(relativePath, params.glob))
        return true;
      let content: string;
      try {
        content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
      } catch {
        return true;
      }
      const lines = content
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n");
      const displayPath = rootIsDirectory
        ? relativePath
        : path.posix.basename(guestPath);
      for (let index = 0; index < lines.length; index++) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (!matcher(lines[index] ?? "")) continue;
        matchCount++;
        if (
          appendGrepBlock({
            outputLines,
            lines,
            relativePath: displayPath,
            lineIndex: index,
            contextLines,
          })
        ) {
          linesTruncated = true;
        }
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          return false;
        }
      }
      return true;
    },
    signal,
  );

  if (matchCount === 0)
    return {
      content: [{ type: "text", text: "No matches found" }],
      details: undefined,
    };

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  const notices: string[] = [];
  let output = truncation.content;

  if (matchLimitReached) {
    details.matchLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} matches limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("long lines truncated");
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

function sanitizeEnv(
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function createEchoriadBashOps(
  vm: VM,
  localCwd: string,
  shellPath: string,
  hostMounts?: HostMountMapping[],
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      const guestCwd = toGuestPath(localCwd, cwd, hostMounts);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const proc = vm.exec([shellPath, "-lc", command], {
          cwd: guestCwd,
          env: sanitizeEnv(env),
          signal: controller.signal,
          stdout: "pipe",
          stderr: "pipe",
        });
        for await (const chunk of proc.output()) onData(chunk.data);
        const result = await proc;
        return { exitCode: result.exitCode };
      } catch (error) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function expandEnvAndTilde(rawPath: string): string {
  let expanded = rawPath.replace(
    /\$(?:([A-Za-z_][A-Za-z0-9_]*)|{([A-Za-z_][A-Za-z0-9_]*)})/g,
    (_, name1, name2) => {
      const varName = name1 || name2;
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(
          `Echoriad: environment variable "${varName}" in mount path "${rawPath}" is not set`,
        );
      }
      return value;
    },
  );

  if (expanded === "~") {
    expanded = os.homedir();
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }

  return expanded;
}

function resolveHostPath(projectRoot: string, rawPath: string): string {
  const expanded = expandEnvAndTilde(rawPath);
  return path.resolve(projectRoot, expanded);
}

function validateHostDirectory(rawPath: string, hostPath: string): void {
  if (!fs.existsSync(hostPath)) {
    throw new Error(
      `Echoriad: host mount path does not exist: ${rawPath} (${hostPath})`,
    );
  }
  const stat = fs.statSync(hostPath);
  if (!stat.isDirectory()) {
    throw new Error(
      `Echoriad: host mount path is not a directory: ${rawPath} (${hostPath})`,
    );
  }
}

type ResolvedMounts = {
  vfsMounts: Record<string, VirtualProvider>;
  hostMounts: HostMountMapping[];
};

function resolveMounts(projectRoot: string): ResolvedMounts {
  const config = loadProjectConfig(projectRoot);
  const vfsMounts: Record<string, VirtualProvider> = {
    [GUEST_WORKSPACE]: new RealFSProvider(projectRoot),
  };
  const hostMountMap = new Map<string, string>();
  hostMountMap.set(GUEST_WORKSPACE, projectRoot);

  if (config.mounts) {
    if (typeof config.mounts !== "object" || Array.isArray(config.mounts)) {
      throw new Error(`Echoriad: "mounts" configuration must be an object`);
    }

    for (const [rawGuestPath, mountDef] of Object.entries(config.mounts)) {
      const guestPath = path.posix.resolve("/", toPosix(rawGuestPath));

      if (typeof mountDef === "string") {
        if (!mountDef.trim()) {
          throw new Error(
            `Echoriad: host mount path for "${rawGuestPath}" must not be empty`,
          );
        }
        const hostPath = resolveHostPath(projectRoot, mountDef);
        validateHostDirectory(mountDef, hostPath);
        vfsMounts[guestPath] = new RealFSProvider(hostPath);
        hostMountMap.set(guestPath, hostPath);
      } else if (
        mountDef &&
        typeof mountDef === "object" &&
        !Array.isArray(mountDef)
      ) {
        if (
          mountDef.readonly !== undefined &&
          typeof mountDef.readonly !== "boolean"
        ) {
          throw new Error(
            `Echoriad: "readonly" option for mount "${rawGuestPath}" must be a boolean`,
          );
        }

        const type = (mountDef as HostMountConfig).type ?? "host";
        if (type === "host") {
          const hostMount = mountDef as HostMountConfig;
          if (
            !hostMount.path ||
            typeof hostMount.path !== "string" ||
            !hostMount.path.trim()
          ) {
            throw new Error(
              `Echoriad: host mount for "${rawGuestPath}" requires a non-empty string "path" property`,
            );
          }
          const hostPath = resolveHostPath(projectRoot, hostMount.path);
          validateHostDirectory(hostMount.path, hostPath);
          let provider: VirtualProvider = new RealFSProvider(hostPath);
          if (hostMount.readonly) {
            provider = new ReadonlyProvider(provider);
          }
          vfsMounts[guestPath] = provider;
          hostMountMap.set(guestPath, hostPath);
        } else if (type === "memory") {
          const memMount = mountDef as MemoryMountConfig;
          let provider: VirtualProvider = new MemoryProvider();
          if (memMount.readonly) {
            provider = new ReadonlyProvider(provider);
          }
          vfsMounts[guestPath] = provider;
          hostMountMap.delete(guestPath);
        } else {
          throw new Error(
            `Echoriad: unknown mount type "${type}" for "${rawGuestPath}" (expected "host" or "memory")`,
          );
        }
      } else {
        throw new Error(
          `Echoriad: invalid mount configuration for "${rawGuestPath}"`,
        );
      }
    }
  }

  const hostMounts: HostMountMapping[] = Array.from(
    hostMountMap.entries(),
  ).map(([guestPath, hostPath]) => ({ guestPath, hostPath }));
  hostMounts.sort((a, b) => b.hostPath.length - a.hostPath.length);

  return { vfsMounts, hostMounts };
}

type ResolvedImageStartup = {
  imagePath?: string;
  imageLabel: string;
};

/**
 * Resolve the guest image source for this startup. When a build config is
 * selected, the human approval prompt, fingerprinting, and automatic build
 * happen here; the returned image selector is the imported Gondolin build id.
 */
async function resolveImageStartup(
  projectRoot: string,
  ctx?: ExtensionContext,
  signal?: AbortSignal,
): Promise<ResolvedImageStartup> {
  const project = loadProjectConfig(projectRoot);
  const system = loadSystemConfig();

  const selection = resolveImageSelection(project, system, projectRoot);

  if (selection.kind === "default") {
    return { imageLabel: "default" };
  }

  if (selection.kind === "image") {
    // Precedence: project config > system config > env var. Relative image
    // paths resolve against the base dir of whichever source supplied them
    // (the directory containing the config file, or process.cwd() for the
    // env var, matching Gondolin's own resolvePathSelector() behaviour).
    const image = selection.value;
    if (image.startsWith(".")) {
      const resolved = path.resolve(selection.baseDir, image);
      let isDir = false;
      try {
        isDir = fs.statSync(resolved).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        throw new Error(
          `Echoriad: image path "${image}" (resolved to ${resolved}) does not exist or is not a directory. ` +
            `Use a "name:tag" selector or a directory containing vmlinuz-virt, initramfs.cpio.lz4, rootfs.ext4.`,
        );
      }
      return { imagePath: resolved, imageLabel: image };
    }
    return { imagePath: image, imageLabel: image };
  }

  // A build config is selected: fingerprint it, then reuse an authorized
  // cached image silently or require approval before reusing or building.
  // The consumer identity is the canonical common Git directory for Git
  // projects (linked worktrees share it), the canonical project root
  // otherwise, and a system-wide consumer for system-selected configs.
  const identity = deriveBuildIdentity({
    origin: selection.origin,
    projectRoot,
    configPath: selection.configPath,
  });
  const result = await prepareGuestImage({
    configPath: selection.configPath,
    projectRoot,
    consumer: identity.consumerLabel,
    consumerId: identity.consumerId,
    configId: identity.configId,
    interactive: Boolean(ctx?.hasUI),
    signal,
    approve: (action, summary) =>
      ctx
        ? ctx.ui.confirm(
            action === "build"
              ? "Build Gondolin guest image?"
              : "Reuse cached Gondolin guest image?",
            summary,
            { signal },
          )
        : Promise.resolve(false),
    onWarning: (message) => {
      // Messages from the authorization store are already prefixed.
      ctx?.ui.notify(message, "warning");
    },
    onStatus: (message) =>
      ctx?.ui.setStatus("echoriad", `Echoriad: ${message}`),
    onBuildOutput: (chunk) => {
      // Stream Gondolin's output to the human-facing status line only;
      // it never enters model context. The latest line replaces the
      // previous one instead of stacking a notification per chunk.
      const lastLine =
        chunk
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .pop() ?? "";
      if (ctx?.hasUI) {
        ctx.ui.setStatus(
          "echoriad",
          `Echoriad: building guest image — ${lastLine.slice(0, 80)}`,
        );
      } else {
        process.stderr.write(chunk);
      }
    },
    onBuildFailure: (outputTail) => {
      ctx?.ui.notify(
        `Echoriad: guest image build failed.\nRecent Gondolin output:\n${outputTail}`,
        "error",
      );
    },
  });
  return { imagePath: result.imageSelector, imageLabel: result.imageRef };
}

function resolveVmOptions(
  projectRoot: string,
  image: ResolvedImageStartup,
): {
  options: VMOptions;
  imageLabel: string;
  hostMounts: HostMountMapping[];
} {
  const project = loadProjectConfig(projectRoot);
  const system = loadSystemConfig();

  const cpus = project.cpus ?? system.cpus;
  const memory = project.memory ?? system.memory;

  const sandbox: NonNullable<VMOptions["sandbox"]> = {};
  if (image.imagePath) {
    sandbox.imagePath = image.imagePath;
  }
  if (typeof cpus === "number") sandbox.cpus = cpus;
  if (typeof memory === "string") sandbox.memory = memory;

  const network = project.network ?? {};
  const { vfsMounts, hostMounts } = resolveMounts(projectRoot);
  const options: VMOptions = {
    sessionLabel: `pi ${path.basename(projectRoot)}`,
    sandbox,
    vfs: { mounts: vfsMounts },
  };

  if (network.enabled === false) {
    sandbox.netEnabled = false;
    return { options, imageLabel: image.imageLabel, hostMounts };
  }

  const hasHttpPolicy = Array.isArray(network.allowedHosts) || network.secrets;
  const hasTcp = network.tcp && Object.keys(network.tcp).length > 0;

  if (hasHttpPolicy) {
    const secretDefs: Record<string, { hosts: string[]; value: string }> = {};
    for (const [name, def] of Object.entries(network.secrets ?? {})) {
      const envName = def.fromEnv ?? name;
      const value = process.env[envName];
      if (typeof value !== "string") {
        throw new Error(
          `Echoriad: secret "${name}" references host env var "${envName}" which is not set`,
        );
      }
      secretDefs[name] = { hosts: def.hosts, value };
    }
    const { httpHooks, env } = createHttpHooks({
      allowedHosts: network.allowedHosts,
      secrets: secretDefs,
    });
    options.httpHooks = httpHooks;
    options.env = env;
  }

  if (hasTcp) {
    // Raw TCP host mappings require synthetic per-host DNS so the guest can
    // resolve mapped hostnames and the host can map outbound flows.
    options.tcp = { hosts: network.tcp };
    options.dns = { mode: "synthetic", syntheticHostMapping: "per-host" };
  }

  return { options, imageLabel: image.imageLabel, hostMounts };
}

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
  let startupController: AbortController | undefined;
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
    // (or rebuild) again on the next startup attempt.
    if (!resolvedImage) {
      resolvedImage = await resolveImageStartup(localCwd, ctx, signal);
    }
    signal.throwIfAborted();
    const {
      options: vmOptions,
      imageLabel: resolvedImageLabel,
      hostMounts: resolvedHostMounts,
    } = resolveVmOptions(localCwd, resolvedImage);
    imageLabel = resolvedImageLabel;
    hostMounts = resolvedHostMounts;
    const created = await VM.create(vmOptions);
    if (signal.aborted) {
      await created.close();
      signal.throwIfAborted();
    }
    const bashProbe = await created.exec([
      "/bin/sh",
      "-lc",
      "command -v bash || true",
    ]);
    shellPath = bashProbe.stdout.trim() || "/bin/sh";
    vm = created;
    ctx?.ui.setStatus(
      "echoriad",
      ctx.ui.theme.fg(
        "accent",
        `Echoriad: ${created.id.slice(0, 8)} (${GUEST_WORKSPACE})`,
      ),
    );
    ctx?.ui.notify(
      `Gondolin VM ready. ${localCwd} is mounted at ${GUEST_WORKSPACE}. Image: ${imageLabel}.`,
      "info",
    );
    return created;
  }

  async function ensureVm(ctx?: ExtensionContext, signal = ctx?.signal): Promise<VM> {
    const unavailable = () => new Error("Echoriad: guest unavailable; see human-facing diagnostics.");
    if (shutdownController.signal.aborted || signal?.aborted) throw unavailable();
    if (vm) return vm;
    if (permanentStartupError) throw unavailable();
    if (!vmStarting) {
      startupController = new AbortController();
      const startupSignal = AbortSignal.any([
        startupController.signal, shutdownController.signal,
      ]);
      vmStarting = startVm(ctx, startupSignal).catch((error) => {
        if (error instanceof GuestImageError && error.permanent) {
          permanentStartupError = error.message;
        }
        // Startup details must never become tool errors in model context.
        if (ctx?.hasUI) ctx.ui.notify(String(error), "error");
        else process.stderr.write(String(error) + "\n");
        throw unavailable();
      }).finally(() => {
        vmStarting = undefined;
        startupController = undefined;
      });
    }
    const controller = startupController;
    const cancel = () => controller?.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      return await vmStarting;
    } finally {
      signal?.removeEventListener("abort", cancel);
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
    ctx.ui.setStatus(
      "echoriad",
      ctx.ui.theme.fg("muted", "Echoriad: stopping"),
    );
    try {
      await activeVm.close();
    } finally {
      ctx.ui.setStatus("echoriad", undefined);
    }
  });

  pi.registerCommand("echoriad", {
    description: "Show Gondolin VM status",
    handler: async (_args, ctx) => {
      const activeVm = await ensureVm(ctx);
      ctx.ui.notify(
        [
          `Gondolin VM: ${activeVm.id}`,
          `Host workspace: ${localCwd}`,
          `Guest workspace: ${GUEST_WORKSPACE}`,
          `Shell: ${shellPath}`,
          `Image: ${imageLabel}`,
        ].join("\n"),
        "info",
      );
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
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(GUEST_WORKSPACE, {
        operations: createEchoriadWriteOps(activeVm, localCwd, hostMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(GUEST_WORKSPACE, {
        operations: createEchoriadEditOps(activeVm, localCwd, hostMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(GUEST_WORKSPACE, {
        operations: createEchoriadBashOps(
          activeVm,
          localCwd,
          shellPath,
          hostMounts,
        ),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createLsTool(GUEST_WORKSPACE, {
        operations: createEchoriadLsOps(activeVm, localCwd, hostMounts),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
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
      return executeEchoriadGrep(
        activeVm,
        localCwd,
        params,
        signal,
        hostMounts,
      );
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    const activeVm = await ensureVm(ctx);
    return {
      operations: createEchoriadBashOps(
        activeVm,
        localCwd,
        shellPath,
        hostMounts,
      ),
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
