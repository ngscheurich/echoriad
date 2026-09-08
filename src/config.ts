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

export function parseConfigFile(configPath: string, label: string): ProjectConfig {
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
		throw new Error(`Echoriad: invalid ${label} (${configPath}): ${(error as Error).message}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Echoriad: ${label} (${configPath}) must be a JSON object`);
	}
	const config = parsed as ProjectConfig;

	if ("image" in config && "buildConfig" in config) {
		throw new Error(
			`Echoriad: ${label} (${configPath}) defines both "image" and "buildConfig"; ` +
				`a configuration file may define only one image selector`,
		);
	}
	if ("buildConfig" in config) {
		if (typeof config.buildConfig !== "string" || config.buildConfig.trim() === "") {
			throw new Error(
				`Echoriad: ${label} (${configPath}) field "buildConfig" must be a non-empty string ` +
					`containing a path to a Gondolin build config`,
			);
		}
	}
	return config;
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
	return parseConfigFile(
		path.join(projectRoot, CONFIG_PATH),
		path.relative(projectRoot, path.join(projectRoot, CONFIG_PATH)) || CONFIG_PATH,
	);
}

// Base config directory following the XDG Base Directory Specification:
// `$XDG_CONFIG_HOME` if set and non-absolute-path-safe, otherwise `$HOME/.config`.
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
 * that declared them; relative `image` paths keep resolving against the
 * declaring directory too (or `process.cwd()` for the env var, matching
 * Gondolin's own resolvePathSelector() behaviour).
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
