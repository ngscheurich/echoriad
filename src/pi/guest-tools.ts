/**
 * Pi tool operations backed by the Gondolin guest file system and shell.
 *
 * Each factory adapts one pi tool's operations interface to the VM: paths
 * are mapped host→guest, reads and writes go through the VM's file system,
 * and bash runs through the guest shell discovered at startup. The grep
 * implementation is local to this module because it needs guest-side
 * walking and line truncation control the generic tool does not expose.
 */

import path from "node:path";
import type { VM } from "@earendil-works/gondolin";
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepToolDetails,
  GrepToolInput,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { type HostMountMapping, toPosix } from "../vm-spec.ts";
import { toGuestPath } from "./guest-paths.ts";

const DEFAULT_GREP_LIMIT = 100;
/** Bounds the guest walk when a symlink cycle exists under the search root. */
const MAX_WALK_DEPTH = 32;

type TextToolResult<TDetails> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails | undefined;
};

export function createEchoriadReadOps(
  vm: VM,
  localCwd: string,
  hostMounts?: HostMountMapping[],
): ReadOperations {
  return {
    readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath, hostMounts)),
    access: async (filePath) => {
      await vm.fs.access(toGuestPath(localCwd, filePath, hostMounts));
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix.extname(toGuestPath(localCwd, filePath, hostMounts)).toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

export function createEchoriadWriteOps(
  vm: VM,
  localCwd: string,
  hostMounts?: HostMountMapping[],
): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      await vm.fs.writeFile(toGuestPath(localCwd, filePath, hostMounts), content, {
        encoding: "utf8",
      });
    },
    mkdir: async (dirPath) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dirPath, hostMounts), {
        recursive: true,
      });
    },
  };
}

export function createEchoriadEditOps(
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

export function createEchoriadLsOps(
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
    stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath, hostMounts)),
    readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath, hostMounts)),
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
    depth: number,
  ): Promise<boolean> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    // The guest FS exposes no lstat, so symlinked directories cannot be
    // distinguished from real ones; the depth cap bounds the traversal when
    // a symlink cycle exists under the search root.
    if (depth > MAX_WALK_DEPTH) return true;
    const entries = await vm.fs.listDir(dir, { signal });
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const guestPath = path.posix.join(dir, entry);
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
      let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
      try {
        entryStat = await vm.fs.stat(guestPath, { signal });
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (!(await walkDirectory(guestPath, relativePath, depth + 1))) return false;
      } else if (!(await visit(guestPath, relativePath))) {
        return false;
      }
    }
    return true;
  };

  return walkDirectory(root, "", 0);
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
  const normalizedPattern = toPosix(pattern);
  if (normalizedPattern.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, normalizedPattern) ||
      path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

export function createEchoriadFindOps(
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
    return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
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
  /** highest line index already emitted for this file, or -1 */
  lastEmittedLine: number;
}): { lastEmittedLine: number; truncated: boolean } {
  let linesTruncated = false;
  // Skip lines a previous match's context window already emitted, so
  // overlapping windows do not print the same lines twice.
  const start =
    params.contextLines > 0
      ? Math.max(0, params.lineIndex - params.contextLines, params.lastEmittedLine + 1)
      : params.lineIndex;
  const end =
    params.contextLines > 0
      ? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
      : params.lineIndex;

  for (let index = start; index <= end; index++) {
    const rawLine = params.lines[index] ?? "";
    const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
    if (wasTruncated) linesTruncated = true;
    const separator = index === params.lineIndex ? ":" : "-";
    params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
  }
  return { lastEmittedLine: end, truncated: linesTruncated };
}

export async function executeEchoriadGrep(
  vm: VM,
  localCwd: string,
  params: GrepToolInput,
  signal?: AbortSignal,
  hostMounts?: HostMountMapping[],
): Promise<TextToolResult<GrepToolDetails>> {
  const root = toGuestPath(localCwd, params.path ?? ".", hostMounts);
  const rootStat = await vm.fs.stat(root, { signal });
  const rootIsDirectory = rootStat.isDirectory();
  const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
  const contextLines = params.context && params.context > 0 ? params.context : 0;
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
      if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
      let content: string;
      try {
        content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
      } catch {
        return true;
      }
      const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
      let lastEmittedLine = -1;
      for (let index = 0; index < lines.length; index++) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (!matcher(lines[index] ?? "")) continue;
        matchCount++;
        const block = appendGrepBlock({
          outputLines,
          lines,
          relativePath: displayPath,
          lineIndex: index,
          contextLines,
          lastEmittedLine,
        });
        lastEmittedLine = block.lastEmittedLine;
        if (block.truncated) {
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

function sanitizeEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function createEchoriadBashOps(
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
