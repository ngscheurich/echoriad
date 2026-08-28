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
 * Per-project configuration is read from `.echoriad.json` in the project root.
 * System-wide defaults are read from `$XDG_CONFIG_HOME/echoriad/config.json`
 * (defaulting to `~/.config/echoriad/config.json`); per-project fields
 * override the system-wide file, which in turn overrides `ECHORIAD_IMAGE`.
 *
 * Example configuration:
 *
 *   {
 *     "image": "my-custom:latest",            // optional, overrides ECHORIAD_IMAGE
 *     "cpus": 4,                              // optional, default 2
 *     "memory": "2G",                         // optional, qemu syntax, default "1G"
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
  RealFSProvider,
  VM,
  type VMOptions,
} from "@earendil-works/gondolin";
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

function hostPathToGuest(localCwd: string, hostPath: string): string {
  const relativePath = path.relative(localCwd, hostPath);
  if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
  return relativePath
    ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath))
    : GUEST_WORKSPACE;
}

function toGuestPath(localCwd: string, inputPath: string): string {
  const trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return GUEST_WORKSPACE;
  if (path.isAbsolute(trimmed)) {
    if (isInsideHostPath(localCwd, trimmed))
      return hostPathToGuest(localCwd, trimmed);
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createEchoriadReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (filePath) =>
      vm.fs.readFile(toGuestPath(localCwd, filePath)),
    access: async (filePath) => {
      await vm.fs.access(toGuestPath(localCwd, filePath));
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix
        .extname(toGuestPath(localCwd, filePath))
        .toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

function createEchoriadWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, {
        encoding: "utf8",
      });
    },
    mkdir: async (dirPath) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
    },
  };
}

function createEchoriadEditOps(vm: VM, localCwd: string): EditOperations {
  const readOps = createEchoriadReadOps(vm, localCwd);
  const writeOps = createEchoriadWriteOps(vm, localCwd);
  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}

function createEchoriadLsOps(vm: VM, localCwd: string): LsOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(localCwd, filePath));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
    readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
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

function createEchoriadFindOps(vm: VM, localCwd: string): FindOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(localCwd, filePath));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const root = toGuestPath(localCwd, cwd);
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
): Promise<TextToolResult<GrepToolDetails>> {
  const root = toGuestPath(localCwd, params.path ?? ".");
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
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (signal?.aborted) throw new Error("aborted");
      const guestCwd = toGuestPath(localCwd, cwd);
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

type ProjectSecretConfig = {
  hosts: string[];
  fromEnv?: string;
};

type ProjectNetworkConfig = {
  enabled?: boolean;
  allowedHosts?: string[];
  secrets?: Record<string, ProjectSecretConfig>;
  /** guest host[:port] -> upstream host:port raw tcp mappings */
  tcp?: Record<string, string>;
};

type ProjectConfig = {
  image?: string;
  cpus?: number;
  memory?: string;
  network?: ProjectNetworkConfig;
  mounts?: Record<string, string>;
};

const CONFIG_PATH = ".echoriad.json";

function parseConfigFile(
  configPath: string,
  label: string,
): ProjectConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Echoriad: invalid ${label} (${configPath}): ${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Echoriad: ${label} (${configPath}) must be a JSON object`);
  }
  return parsed as ProjectConfig;
}

function loadProjectConfig(projectRoot: string): ProjectConfig {
  return parseConfigFile(
    path.join(projectRoot, CONFIG_PATH),
    path.relative(projectRoot, path.join(projectRoot, CONFIG_PATH)) ||
      CONFIG_PATH,
  );
}

// Base config directory following the XDG Base Directory Specification:
// `$XDG_CONFIG_HOME` if set and non-absolute-path-safe, otherwise `$HOME/.config`.
// This is the most portable default across Linux, macOS, and the BSDs.
function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "" && path.isAbsolute(xdg)) return xdg;
  return path.join(os.homedir(), ".config");
}

function systemConfigPath(): string {
  return path.join(configDir(), "echoriad", "config.json");
}

function loadSystemConfig(): ProjectConfig {
  return parseConfigFile(systemConfigPath(), "system config");
}

function resolveMounts(
  projectRoot: string,
): Record<string, RealFSProvider> {
  const config = loadProjectConfig(projectRoot);
  const mounts: Record<string, RealFSProvider> = {
    [GUEST_WORKSPACE]: new RealFSProvider(projectRoot),
  };
  if (config.mounts) {
    for (const [guestPath, hostRelative] of Object.entries(config.mounts)) {
      const hostPath = path.resolve(projectRoot, hostRelative);
      fs.mkdirSync(hostPath, { recursive: true });
      mounts[guestPath] = new RealFSProvider(hostPath);
    }
  }
  return mounts;
}

function resolveVmOptions(projectRoot: string): {
  options: VMOptions;
  imageLabel: string;
} {
  const project = loadProjectConfig(projectRoot);
  const system = loadSystemConfig();

  // Precedence for scalar defaults: project config > system config > env var.
  // Relative image paths resolve against the base dir of whichever source
  // supplied them (the directory containing the config file, or process.cwd()
  // for the env var, matching Gondolin's own resolvePathSelector() behaviour).
  const systemPath = systemConfigPath();
  let image: string | undefined;
  let imageBase: string;
  if (project.image) {
    image = project.image;
    imageBase = projectRoot;
  } else if (system.image) {
    image = system.image;
    imageBase = path.dirname(systemPath);
  } else {
    image = process.env.ECHORIAD_IMAGE;
    imageBase = process.cwd();
  }
  const cpus = project.cpus ?? system.cpus;
  const memory = project.memory ?? system.memory;

  const sandbox: NonNullable<VMOptions["sandbox"]> = {};
  if (image) {
    // A string imagePath can be either an image selector (`name:tag` / build id)
    // or a directory containing guest assets. Gondolin's resolvePathSelector()
    // resolves directory paths against process.cwd(); if the directory is
    // missing it silently falls through to parseImageRef(), which rejects
    // path-shaped strings with a confusing "invalid image name" error.
    // Resolve path-like selectors against the image source's base dir
    // ourselves and surface a clear error when the directory doesn't exist.
    if (typeof image === "string" && image.startsWith(".")) {
      const resolved = path.resolve(imageBase, image);
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
      sandbox.imagePath = resolved;
    } else {
      sandbox.imagePath = image;
    }
  }
  if (typeof cpus === "number") sandbox.cpus = cpus;
  if (typeof memory === "string") sandbox.memory = memory;

  const network = project.network ?? {};
  const options: VMOptions = {
    sessionLabel: `pi ${path.basename(projectRoot)}`,
    sandbox,
    vfs: { mounts: resolveMounts(projectRoot) },
  };

  if (network.enabled === false) {
    sandbox.netEnabled = false;
    return { options, imageLabel: image ?? "default" };
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

  return { options, imageLabel: image ?? "default" };
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
  let shellPath = "/bin/sh";
  let imageLabel = "default";

  async function startVm(ctx?: ExtensionContext): Promise<VM> {
    ctx?.ui.setStatus(
      "echoriad",
      ctx.ui.theme.fg("accent", `Echoriad: starting ${GUEST_WORKSPACE}`),
    );
    const { options: vmOptions, imageLabel: resolvedImageLabel } =
      resolveVmOptions(localCwd);
    imageLabel = resolvedImageLabel;
    const created = await VM.create(vmOptions);
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

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
    if (!vmStarting) {
      vmStarting = startVm(ctx).finally(() => {
        vmStarting = undefined;
      });
    }
    return vmStarting;
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const activeVm = vm;
    vm = undefined;
    vmStarting = undefined;
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
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(GUEST_WORKSPACE, {
        operations: createEchoriadReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(GUEST_WORKSPACE, {
        operations: createEchoriadWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(GUEST_WORKSPACE, {
        operations: createEchoriadEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(GUEST_WORKSPACE, {
        operations: createEchoriadBashOps(activeVm, localCwd, shellPath),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createLsTool(GUEST_WORKSPACE, {
        operations: createEchoriadLsOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createFindTool(GUEST_WORKSPACE, {
        operations: createEchoriadFindOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      return executeEchoriadGrep(activeVm, localCwd, params, signal);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    const activeVm = await ensureVm(ctx);
    return { operations: createEchoriadBashOps(activeVm, localCwd, shellPath) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    const localLine = `Current working directory: ${localCwd}`;
    const guestLine = `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM; host workspace mounted from ${localCwd})`;
    const systemPrompt = event.systemPrompt.includes(localLine)
      ? event.systemPrompt.replace(localLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    return { systemPrompt };
  });
}
