/**
 * Semantic build fingerprint for Gondolin build configs.
 *
 * The fingerprint covers the canonical serialization of the parsed build
 * config, the contents and build-relevant metadata of every local input
 * recognized by the installed Gondolin schema, the installed Gondolin
 * package version, and an Echoriad fingerprint-schema version. File
 * timestamps and other external state do not affect it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { BuildConfig } from "@earendil-works/gondolin";

export const FINGERPRINT_SCHEMA_VERSION = 1;

let cachedGondolinVersion: string | undefined;

/** Version of the installed `@earendil-works/gondolin` package. */
export function gondolinVersion(): string {
  if (cachedGondolinVersion) return cachedGondolinVersion;
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve(
    "@earendil-works/gondolin/package.json",
  );
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  if (!parsed.version) {
    throw new Error(
      "Echoriad: installed @earendil-works/gondolin package.json has no version field",
    );
  }
  cachedGondolinVersion = parsed.version;
  return cachedGondolinVersion;
}

/**
 * Canonical JSON serialization: object keys are recursively sorted, array
 * order is preserved, and whitespace/formatting does not affect the result.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export type LocalInputNode =
  | { type: "file"; mode: number; sha256: string }
  | { type: "symlink"; target: string }
  | { type: "directory"; entries: Record<string, LocalInputNode> };

/** Local input paths declared by a build config, as written in the config. */
export function declaredLocalInputPaths(config: BuildConfig): string[] {
  const declared: string[] = [];
  if (config.init?.rootfsInit) declared.push(config.init.rootfsInit);
  if (config.init?.initramfsInit) declared.push(config.init.initramfsInit);
  if (config.init?.rootfsInitExtra) declared.push(config.init.rootfsInitExtra);
  for (const entry of config.postBuild?.copy ?? []) {
    if (entry.src) declared.push(entry.src);
  }
  if (config.sandboxdPath) declared.push(config.sandboxdPath);
  if (config.sandboxfsPath) declared.push(config.sandboxfsPath);
  if (config.sandboxsshPath) declared.push(config.sandboxsshPath);
  if (config.sandboxingressPath) declared.push(config.sandboxingressPath);
  if (config.nixos?.systemExpression) {
    declared.push(config.nixos.systemExpression);
  }
  return declared;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function describeNode(
  declaredPath: string,
  configDir: string,
  absolutePath: string,
  node: fs.Stats,
): LocalInputNode {
  if (node.isFile()) {
    return {
      type: "file",
      mode: node.mode & 0o7777,
      sha256: sha256File(absolutePath),
    };
  }
  if (node.isSymbolicLink()) {
    return { type: "symlink", target: fs.readlinkSync(absolutePath) };
  }
  if (node.isDirectory()) {
    const entries: Record<string, LocalInputNode> = {};
    const names = fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .map((dirent) => dirent.name)
      .sort();
    for (const name of names) {
      const childPath = path.join(absolutePath, name);
      entries[name] = describeNode(
        declaredPath,
        configDir,
        childPath,
        fs.lstatSync(childPath),
      );
    }
    return { type: "directory", entries };
  }
  const kind = node.isFIFO()
    ? "FIFO"
    : node.isSocket()
      ? "socket"
      : node.isBlockDevice()
        ? "block device"
        : node.isCharacterDevice()
          ? "character device"
          : "unsupported node";
  throw new Error(
    `Echoriad: local input "${declaredPath}" of the build config in ${configDir} ` +
      `contains an unsupported ${kind} at ${absolutePath}; ` +
      `remove it or point the build config at a regular file, directory, or symlink`,
  );
}

/**
 * Hash one declared local input. Relative paths resolve against the build
 * config's directory. Missing inputs are an actionable error.
 */
export function hashLocalInput(
  configDir: string,
  declaredPath: string,
): { key: string; node: LocalInputNode; absolutePath: string } {
  const absolutePath = path.resolve(configDir, declaredPath);
  let node: fs.Stats;
  try {
    node = fs.lstatSync(absolutePath);
  } catch {
    throw new Error(
      `Echoriad: build config local input "${declaredPath}" does not exist ` +
        `(resolved to ${absolutePath})`,
    );
  }
  const key = path
    .relative(configDir, absolutePath)
    .split(path.sep)
    .join(path.posix.sep);
  return {
    key,
    node: describeNode(declaredPath, configDir, absolutePath, node),
    absolutePath,
  };
}

export type BuildFingerprint = {
  /** full hex fingerprint */
  fingerprint: string;
  /** first 12 hex characters */
  abbreviated: string;
  /** resolved absolute paths of every local input covered by the fingerprint */
  localInputPaths: string[];
};

/**
 * Compute the complete semantic fingerprint of a parsed build config.
 *
 * Echoriad reads and hashes declared local inputs before approval, so this
 * may traverse large or external host paths.
 */
export function computeBuildFingerprint(
  config: BuildConfig,
  configDir: string,
): BuildFingerprint {
  const inputs: Record<string, LocalInputNode> = {};
  const localInputPaths: string[] = [];
  for (const declared of declaredLocalInputPaths(config)) {
    const { key, node, absolutePath } = hashLocalInput(configDir, declared);
    inputs[key] = node;
    if (!localInputPaths.includes(absolutePath)) {
      localInputPaths.push(absolutePath);
    }
  }
  const payload = {
    schema: FINGERPRINT_SCHEMA_VERSION,
    gondolinVersion: gondolinVersion(),
    config,
    inputs,
  };
  const fingerprint = crypto
    .createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex");
  return {
    fingerprint,
    abbreviated: fingerprint.slice(0, 12),
    localInputPaths,
  };
}
