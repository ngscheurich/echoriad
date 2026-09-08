/**
 * Configuration loading and image-source selection for Echoriad.
 *
 * Both the project configuration (`.echoriad.json`) and the system
 * configuration accept an `image` selector or a `buildConfig` path to a
 * Gondolin build config. The two fields occupy one logical selection slot:
 * a configuration file that defines both is invalid. Project selectors
 * override system selectors; other scalar fields keep their independent
 * precedence.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ProjectSecretConfig = {
  hosts: string[];
  fromEnv?: string;
};

export type ProjectNetworkConfig = {
  enabled?: boolean;
  allowedHosts?: string[];
  secrets?: Record<string, ProjectSecretConfig>;
  /** guest host[:port] -> upstream host:port raw tcp mappings */
  tcp?: Record<string, string>;
};

export type HostMountConfig = {
  type?: "host";
  path: string;
  readonly?: boolean;
};

export type MemoryMountConfig = {
  type: "memory";
  readonly?: boolean;
};

export type MountConfig = string | HostMountConfig | MemoryMountConfig;

export type ProjectConfig = {
  image?: string;
  buildConfig?: string;
  cpus?: number;
  memory?: string;
  network?: ProjectNetworkConfig;
  mounts?: Record<string, MountConfig>;
};

export const CONFIG_PATH = ".echoriad.json";

/** Errors from configuration reading, parsing, and validation. */
export class ConfigError extends Error {
  readonly configPath: string;
  constructor(message: string, configPath: string) {
    super(message);
    this.name = "ConfigError";
    this.configPath = configPath;
  }
}

function invalid(label: string, configPath: string, message: string): ConfigError {
  return new ConfigError(`Echoriad: invalid ${label} (${configPath}): ${message}`, configPath);
}

function requireStringArray(
  value: unknown,
  field: string,
  label: string,
  configPath: string,
): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid(label, configPath, `field "${field}" must be an array of strings`);
  }
}

function validateNetwork(value: unknown, label: string, configPath: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(label, configPath, `field "network" must be an object`);
  }
  const network = value as ProjectNetworkConfig;
  if ("enabled" in network && typeof network.enabled !== "boolean") {
    throw invalid(label, configPath, `field "network.enabled" must be a boolean`);
  }
  if ("allowedHosts" in network) {
    requireStringArray(network.allowedHosts, "network.allowedHosts", label, configPath);
  }
  if ("tcp" in network) {
    const tcp = network.tcp;
    if (
      tcp === null ||
      typeof tcp !== "object" ||
      Array.isArray(tcp) ||
      Object.values(tcp).some((upstream) => typeof upstream !== "string")
    ) {
      throw invalid(
        label,
        configPath,
        `field "network.tcp" must be an object mapping guest hosts to "host:port" strings`,
      );
    }
  }
  if ("secrets" in network) {
    const secrets = network.secrets;
    if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) {
      throw invalid(label, configPath, `field "network.secrets" must be an object`);
    }
    for (const [name, secret] of Object.entries(secrets)) {
      if (secret === null || typeof secret !== "object") {
        throw invalid(label, configPath, `field "network.secrets.${name}" must be an object`);
      }
      requireStringArray(secret.hosts, `network.secrets.${name}.hosts`, label, configPath);
      if ("fromEnv" in secret && typeof secret.fromEnv !== "string") {
        throw invalid(
          label,
          configPath,
          `field "network.secrets.${name}.fromEnv" must be a string`,
        );
      }
    }
  }
}

export function parseConfigFile(configPath: string, label: string): ProjectConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    // A missing file reads as "no configuration". Any other read failure
    // (permissions, a directory at the path) must surface, or the file's
    // settings would be silently dropped.
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw new ConfigError(
      `Echoriad: could not read ${label} (${configPath}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      configPath,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalid(
      label,
      configPath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid(label, configPath, "the configuration must be a JSON object");
  }
  const config = parsed as ProjectConfig;

  if ("image" in config && "buildConfig" in config) {
    throw invalid(
      label,
      configPath,
      `defines both "image" and "buildConfig"; ` +
        `a configuration file may define only one image selector`,
    );
  }
  if ("buildConfig" in config) {
    if (typeof config.buildConfig !== "string" || config.buildConfig.trim() === "") {
      throw invalid(
        label,
        configPath,
        `field "buildConfig" must be a non-empty string ` +
          `containing a path to a Gondolin build config`,
      );
    }
  }
  if ("image" in config) {
    if (typeof config.image !== "string" || config.image.trim() === "") {
      throw invalid(label, configPath, `field "image" must be a non-empty string`);
    }
  }
  if ("cpus" in config && (typeof config.cpus !== "number" || !Number.isInteger(config.cpus))) {
    throw invalid(label, configPath, `field "cpus" must be an integer`);
  }
  if ("memory" in config && typeof config.memory !== "string") {
    throw invalid(
      label,
      configPath,
      `field "memory" must be a string in QEMU size syntax (for example "2G")`,
    );
  }
  if (
    "mounts" in config &&
    (config.mounts === null || typeof config.mounts !== "object" || Array.isArray(config.mounts))
  ) {
    throw invalid(
      label,
      configPath,
      `field "mounts" must be an object mapping guest paths to mount configurations`,
    );
  }
  if ("network" in config) {
    validateNetwork(config.network, label, configPath);
  }
  return config;
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  return parseConfigFile(path.join(projectRoot, CONFIG_PATH), CONFIG_PATH);
}

// Base config directory following the XDG Base Directory Specification:
// `$XDG_CONFIG_HOME` if set, non-empty, and absolute; otherwise `$HOME/.config`.
// This is the most portable default across Linux, macOS, and the BSDs.
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== "" && path.isAbsolute(xdg)) return xdg;
  return path.join(os.homedir(), ".config");
}

export function systemConfigPath(): string {
  return path.join(configDir(), "echoriad", "config.json");
}

export function loadSystemConfig(): ProjectConfig {
  return parseConfigFile(systemConfigPath(), "system config");
}

/**
 * The selected guest image source, after applying selector precedence.
 *
 * `buildConfig` paths resolve against the directory of the configuration
 * that declared them. An `image` value resolves against the declaring
 * directory too (`process.cwd()` for the env var) when that joined path
 * exists and is a directory, mirroring Gondolin's own resolvePathSelector();
 * otherwise it passes through as a `name:tag`-style selector.
 */
export type ImageSelection =
  | { kind: "buildConfig"; configPath: string; origin: "project" | "system" }
  | { kind: "image"; value: string; baseDir: string }
  | { kind: "default" };

export function resolveImageSelection(
  project: ProjectConfig,
  system: ProjectConfig,
  projectRoot: string,
  envImage: string | undefined = process.env.ECHORIAD_IMAGE,
): ImageSelection {
  // A project selector overrides both system selectors. A single file can
  // only define one selector (enforced by parseConfigFile).
  if (typeof project.buildConfig === "string") {
    return {
      kind: "buildConfig",
      configPath: path.resolve(projectRoot, project.buildConfig),
      origin: "project",
    };
  }
  if (project.image) {
    return { kind: "image", value: project.image, baseDir: projectRoot };
  }
  if (typeof system.buildConfig === "string") {
    return {
      kind: "buildConfig",
      configPath: path.resolve(path.dirname(systemConfigPath()), system.buildConfig),
      origin: "system",
    };
  }
  if (system.image) {
    return { kind: "image", value: system.image, baseDir: path.dirname(systemConfigPath()) };
  }
  if (envImage) {
    return { kind: "image", value: envImage, baseDir: process.cwd() };
  }
  return { kind: "default" };
}
