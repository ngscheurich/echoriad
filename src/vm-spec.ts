/**
 * VM and sandbox spec construction from a resolved Echoriad configuration.
 *
 * Everything here is shared by the pi extension and the CLI: mount
 * resolution (host, memory, read-only), network and secret wiring, and the
 * cpus/memory coalescing between the project and system configurations.
 * The returned `VMOptions` are what `VM.create` consumes; path mapping for
 * tool calls uses the returned host-mount table.
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
  type VMOptions,
} from "@earendil-works/gondolin";
import type { ProjectConfig } from "./config.ts";

/** The guest path the host working directory is mounted at. */
export const GUEST_WORKSPACE = "/workspace";

/**
 * Errors from resolving user configuration into VM options — mount path
 * validation, environment expansion, secret wiring. Startup details stay
 * in human-facing channels; the tool layer reports only the category.
 */
export class EchoriadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EchoriadError";
  }
}

/** One host directory exposed in the guest, used for host→guest path mapping. */
export type HostMountMapping = {
  hostPath: string;
  guestPath: string;
};

/** The project and system configurations, loaded together per startup. */
export type LoadedConfigs = {
  project: ProjectConfig;
  system: ProjectConfig;
};

/** Convert a host path to POSIX separators so guest paths compare equal. */
export function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function expandEnvAndTilde(rawPath: string): string {
  let expanded = rawPath.replace(
    /\$(?:([A-Za-z_][A-Za-z0-9_]*)|{([A-Za-z_][A-Za-z0-9_]*)})/g,
    (_, name1, name2) => {
      const varName = name1 || name2;
      const value = process.env[varName];
      if (value === undefined) {
        throw new EchoriadError(
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
    throw new EchoriadError(`Echoriad: host mount path does not exist: ${rawPath} (${hostPath})`);
  }
  const stat = fs.statSync(hostPath);
  if (!stat.isDirectory()) {
    throw new EchoriadError(
      `Echoriad: host mount path is not a directory: ${rawPath} (${hostPath})`,
    );
  }
}

type ResolvedMounts = {
  vfsMounts: Record<string, VirtualProvider>;
  hostMounts: HostMountMapping[];
};

function resolveMounts(projectRoot: string, config: ProjectConfig): ResolvedMounts {
  const vfsMounts: Record<string, VirtualProvider> = {
    [GUEST_WORKSPACE]: new RealFSProvider(projectRoot),
  };
  const hostMountMap = new Map<string, string>();
  hostMountMap.set(GUEST_WORKSPACE, projectRoot);

  if (config.mounts) {
    for (const [rawGuestPath, mountDef] of Object.entries(config.mounts)) {
      const guestPath = path.posix.resolve("/", toPosix(rawGuestPath));

      if (typeof mountDef === "string") {
        if (!mountDef.trim()) {
          throw new EchoriadError(
            `Echoriad: host mount path for "${rawGuestPath}" must not be empty`,
          );
        }
        const hostPath = resolveHostPath(projectRoot, mountDef);
        validateHostDirectory(mountDef, hostPath);
        vfsMounts[guestPath] = new RealFSProvider(hostPath);
        hostMountMap.set(guestPath, hostPath);
      } else if (mountDef && typeof mountDef === "object" && !Array.isArray(mountDef)) {
        if (mountDef.readonly !== undefined && typeof mountDef.readonly !== "boolean") {
          throw new EchoriadError(
            `Echoriad: "readonly" option for mount "${rawGuestPath}" must be a boolean`,
          );
        }

        const type = mountDef.type ?? "host";
        if (mountDef.type === undefined || mountDef.type === "host") {
          const hostMount = mountDef;
          if (!hostMount.path || typeof hostMount.path !== "string" || !hostMount.path.trim()) {
            throw new EchoriadError(
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
        } else if (mountDef.type === "memory") {
          const memMount = mountDef;
          let provider: VirtualProvider = new MemoryProvider();
          if (memMount.readonly) {
            provider = new ReadonlyProvider(provider);
          }
          vfsMounts[guestPath] = provider;
          hostMountMap.delete(guestPath);
        } else {
          throw new EchoriadError(
            `Echoriad: unknown mount type "${type}" for "${rawGuestPath}" (expected "host" or "memory")`,
          );
        }
      } else {
        throw new EchoriadError(`Echoriad: invalid mount configuration for "${rawGuestPath}"`);
      }
    }
  }

  const hostMounts: HostMountMapping[] = Array.from(hostMountMap.entries()).map(
    ([guestPath, hostPath]) => ({ guestPath, hostPath }),
  );
  hostMounts.sort((a, b) => b.hostPath.length - a.hostPath.length);

  return { vfsMounts, hostMounts };
}

export type ResolvedVmSpec = {
  options: VMOptions;
  hostMounts: HostMountMapping[];
};

/**
 * Resolve the full VM option set for a project: sandbox image, cpus, and
 * memory; workspace and extra mounts; HTTP egress policy with secrets; and
 * raw TCP mappings with synthetic DNS. Network settings come from the
 * project configuration only; cpus and memory coalesce
 * `project.x ?? system.x`.
 */
export function resolveVmSpec(input: {
  projectRoot: string;
  configs: LoadedConfigs;
  /** image selector or asset directory; undefined uses the Gondolin default */
  imagePath?: string;
  sessionLabel: string;
}): ResolvedVmSpec {
  const { project, system } = input.configs;

  const cpus = project.cpus ?? system.cpus;
  const memory = project.memory ?? system.memory;

  const sandbox: NonNullable<VMOptions["sandbox"]> = {};
  if (input.imagePath) {
    sandbox.imagePath = input.imagePath;
  }
  if (cpus !== undefined) sandbox.cpus = cpus;
  if (memory !== undefined) sandbox.memory = memory;

  const network = project.network ?? {};
  const { vfsMounts, hostMounts } = resolveMounts(input.projectRoot, project);
  const options: VMOptions = {
    sessionLabel: input.sessionLabel,
    sandbox,
    vfs: { mounts: vfsMounts },
  };

  if (network.enabled === false) {
    sandbox.netEnabled = false;
    return { options, hostMounts };
  }

  const hasHttpPolicy = Array.isArray(network.allowedHosts) || network.secrets;
  const tcp = network.tcp;
  const hasTcp = tcp && Object.keys(tcp).length > 0;

  if (hasHttpPolicy) {
    const secretDefs: Record<string, { hosts: string[]; value: string }> = {};
    for (const [name, def] of Object.entries(network.secrets ?? {})) {
      const envName = def.fromEnv ?? name;
      const value = process.env[envName];
      if (typeof value !== "string") {
        throw new EchoriadError(
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
    options.tcp = { hosts: tcp };
    options.dns = { mode: "synthetic", syntheticHostMapping: "per-host" };
  }

  return { options, hostMounts };
}
