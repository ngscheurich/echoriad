import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadProjectConfig, loadSystemConfig } from "../src/config.ts";
import { EchoriadError, GUEST_WORKSPACE, resolveVmSpec } from "../src/vm-spec.ts";

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-vm-spec-"));
}

function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, ".echoriad.json"), JSON.stringify(config));
}

test("the default spec mounts the workspace and sets only the session label", () => {
  const dir = scratchDir();
  const { options, hostMounts } = resolveVmSpec({
    projectRoot: dir,
    configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
    sessionLabel: "pi test",
  });
  assert.equal(options.sessionLabel, "pi test");
  assert.deepEqual(options.sandbox, {});
  assert.deepEqual(Object.keys(options.vfs?.mounts ?? {}), [GUEST_WORKSPACE]);
  assert.deepEqual(hostMounts, [{ hostPath: dir, guestPath: GUEST_WORKSPACE }]);
});

test("an explicit image path and cpus/memory land in the sandbox options", () => {
  const dir = scratchDir();
  writeConfig(dir, { cpus: 4, memory: "2G" });
  const { options } = resolveVmSpec({
    projectRoot: dir,
    configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
    imagePath: "alpine-base:latest",
    sessionLabel: "pi test",
  });
  assert.deepEqual(options.sandbox, { imagePath: "alpine-base:latest", cpus: 4, memory: "2G" });
});

test("cpus and memory coalesce project over system", () => {
  const dir = scratchDir();
  writeConfig(dir, { cpus: 8 });
  const { options } = resolveVmSpec({
    projectRoot: dir,
    configs: {
      project: loadProjectConfig(dir),
      system: { cpus: 2, memory: "1G" },
    },
    sessionLabel: "pi test",
  });
  assert.deepEqual(options.sandbox, { cpus: 8, memory: "1G" });
});

test("network.enabled false disables networking and skips HTTP hooks", () => {
  const dir = scratchDir();
  writeConfig(dir, { network: { enabled: false } });
  const { options } = resolveVmSpec({
    projectRoot: dir,
    configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
    sessionLabel: "pi test",
  });
  assert.equal(options.sandbox?.netEnabled, false);
  assert.equal(options.httpHooks, undefined);
});

test("an allowedHosts list wires HTTP hooks and a default environment", () => {
  const dir = scratchDir();
  writeConfig(dir, { network: { allowedHosts: ["api.github.com"] } });
  const { options } = resolveVmSpec({
    projectRoot: dir,
    configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
    sessionLabel: "pi test",
  });
  assert.ok(options.httpHooks);
  assert.ok(options.env);
});

test("a secret referencing an unset host env var fails closed", () => {
  const dir = scratchDir();
  writeConfig(dir, {
    network: {
      secrets: { GITHUB_TOKEN: { hosts: ["api.github.com"], fromEnv: "UNSET_VAR_XYZ" } },
    },
  });
  assert.throws(
    () =>
      resolveVmSpec({
        projectRoot: dir,
        configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
        sessionLabel: "pi test",
      }),
    (error: unknown) =>
      error instanceof EchoriadError &&
      error.message ===
        'Echoriad: secret "GITHUB_TOKEN" references host env var "UNSET_VAR_XYZ" which is not set',
  );
});

test("tcp mappings require synthetic per-host DNS", () => {
  const dir = scratchDir();
  writeConfig(dir, { network: { tcp: { postgres: "127.0.0.1:5432" } } });
  const { options } = resolveVmSpec({
    projectRoot: dir,
    configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
    sessionLabel: "pi test",
  });
  assert.deepEqual(options.tcp, { hosts: { postgres: "127.0.0.1:5432" } });
  assert.deepEqual(options.dns, { mode: "synthetic", syntheticHostMapping: "per-host" });
});

test("a string mount adds a host mount mapping for path translation", () => {
  const dir = scratchDir();
  const extra = scratchDir();
  writeConfig(dir, { mounts: { "/mnt/extra": extra } });
  const { options, hostMounts } = resolveVmSpec({
    projectRoot: dir,
    configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
    sessionLabel: "pi test",
  });
  assert.deepEqual(Object.keys(options.vfs?.mounts ?? {}), [GUEST_WORKSPACE, "/mnt/extra"]);
  // Host mounts are sorted longest-host-path-first for mapping resolution.
  const paths = hostMounts.map((mount) => mount.hostPath);
  assert.deepEqual(
    paths.slice().sort((a, b) => b.length - a.length),
    paths,
  );
});

test("a memory mount is not exposed as a host mount", () => {
  const dir = scratchDir();
  writeConfig(dir, { mounts: { "/tmp/scratch": { type: "memory" } } });
  const { hostMounts } = resolveVmSpec({
    projectRoot: dir,
    configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
    sessionLabel: "pi test",
  });
  assert.deepEqual(hostMounts, [{ hostPath: dir, guestPath: GUEST_WORKSPACE }]);
});

test("a mount path that does not exist is an error", () => {
  const dir = scratchDir();
  writeConfig(dir, { mounts: { "/mnt/missing": path.join(dir, "nope") } });
  assert.throws(
    () =>
      resolveVmSpec({
        projectRoot: dir,
        configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
        sessionLabel: "pi test",
      }),
    /host mount path does not exist/,
  );
});

test("an empty string mount path is an error", () => {
  const dir = scratchDir();
  writeConfig(dir, { mounts: { "/mnt/extra": "  " } });
  assert.throws(
    () =>
      resolveVmSpec({
        projectRoot: dir,
        configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
        sessionLabel: "pi test",
      }),
    /must not be empty/,
  );
});

test("an unknown mount type is an error", () => {
  const dir = scratchDir();
  writeConfig(dir, {
    mounts: { "/mnt/extra": { type: "weird" } as unknown as Record<string, never> },
  });
  assert.throws(
    () =>
      resolveVmSpec({
        projectRoot: dir,
        configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
        sessionLabel: "pi test",
      }),
    /unknown mount type/,
  );
});

test("a mount path with an unset environment variable is an error", () => {
  const dir = scratchDir();
  writeConfig(dir, { mounts: { "/mnt/extra": "$UNSET_VAR_XYZ/subdir" } });
  assert.throws(
    () =>
      resolveVmSpec({
        projectRoot: dir,
        configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
        sessionLabel: "pi test",
      }),
    /environment variable "UNSET_VAR_XYZ"/,
  );
});

test("a tilde mount path expands to the home directory", () => {
  const dir = scratchDir();
  writeConfig(dir, { mounts: { "/root/.pi": "~" } });
  const { hostMounts } = resolveVmSpec({
    projectRoot: dir,
    configs: { project: loadProjectConfig(dir), system: loadSystemConfig() },
    sessionLabel: "pi test",
  });
  const home = hostMounts.find((mount) => mount.guestPath === "/root/.pi");
  assert.equal(home?.hostPath, os.homedir());
});
