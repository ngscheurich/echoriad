/**
 * Host-to-guest path mapping for tool calls.
 *
 * Tool inputs arrive as host-style paths (absolute, project-relative, or
 * `./`-prefixed) and must be rewritten to guest-absolute paths before they
 * reach the VM's file system. The mapping resolves against the host mount
 * table — longest host path first — so files under extra mounts map into
 * their own guest mount point instead of the workspace.
 */

import path from "node:path";
import { GUEST_WORKSPACE, type HostMountMapping, toPosix } from "../vm-spec.ts";

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function isInsideHostPath(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function toGuestPath(
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
