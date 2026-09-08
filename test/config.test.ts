import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ConfigError,
  type ProjectConfig,
  parseConfigFile,
  resolveImageSelection,
} from "../src/config.ts";

function makeConfigDir(t: { after: (fn: () => void) => void }): {
  dir: string;
  write: (content: string) => string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, ".echoriad.json");
  return {
    dir,
    write: (content: string) => {
      fs.writeFileSync(configPath, content);
      return configPath;
    },
  };
}

test("project buildConfig overrides both system selectors", () => {
  const selection = resolveImageSelection(
    { buildConfig: "build.json" },
    { image: "sys:latest", buildConfig: "sys-build.json" },
    "/proj",
  );
  assert.equal(selection.kind, "buildConfig");
  assert.equal(selection.kind === "buildConfig" && selection.configPath, "/proj/build.json");
  assert.equal(selection.kind === "buildConfig" && selection.origin, "project");
});

test("system buildConfig is used when the project defines no selector", () => {
  const selection = resolveImageSelection({}, { buildConfig: "b.json" }, "/proj");
  assert.equal(selection.kind, "buildConfig");
  assert.equal(selection.kind === "buildConfig" && selection.origin, "system");
});

test("project image overrides system buildConfig", () => {
  const selection = resolveImageSelection({ image: "proj:1" }, { buildConfig: "b.json" }, "/proj");
  assert.deepEqual(selection, {
    kind: "image",
    value: "proj:1",
    baseDir: "/proj",
  });
});

test("ECHORIAD_IMAGE fallback applies when no file selects a source", () => {
  const selection = resolveImageSelection({}, {}, "/proj", "env:1");
  assert.deepEqual(selection, {
    kind: "image",
    value: "env:1",
    baseDir: process.cwd(),
  });
});

test("default selection when nothing is set", () => {
  assert.equal(resolveImageSelection({}, {}, "/proj", undefined).kind, "default");
});

test("project buildConfig resolves relative to the project root", () => {
  const selection = resolveImageSelection({ buildConfig: "sub/dir/build.json" }, {}, "/proj");
  assert.equal(
    selection.kind === "buildConfig" && selection.configPath,
    "/proj/sub/dir/build.json",
  );
});

test("system buildConfig resolves relative to the system config directory", () => {
  const selection = resolveImageSelection({}, { buildConfig: "build.json" }, "/proj");
  // system base dir is <configDir>/echoriad; assert it is absolute and
  // ends with echoriad/build.json
  assert.equal(selection.kind, "buildConfig");
  assert.ok(selection.kind === "buildConfig" && path.isAbsolute(selection.configPath));
  assert.ok(
    selection.kind === "buildConfig" && selection.configPath.endsWith("echoriad/build.json"),
  );
});

test("absolute buildConfig paths remain absolute", () => {
  const selection = resolveImageSelection({ buildConfig: "/etc/gondolin/build.json" }, {}, "/proj");
  assert.equal(
    selection.kind === "buildConfig" && selection.configPath,
    "/etc/gondolin/build.json",
  );
});

test("parseConfigFile rejects image + buildConfig in the same file", (t) => {
  const { dir, write } = makeConfigDir(t);
  write(JSON.stringify({ image: "a:1", buildConfig: "b.json" }));
  assert.throws(
    () => parseConfigFile(path.join(dir, ".echoriad.json"), "project config"),
    /defines both "image" and "buildConfig"/,
  );
});

test("buildConfig must be a non-empty string", (t) => {
  const { dir, write } = makeConfigDir(t);
  write(JSON.stringify({ buildConfig: "" }));
  assert.throws(
    () => parseConfigFile(path.join(dir, ".echoriad.json"), "project config"),
    /non-empty string/,
  );
  write(JSON.stringify({ buildConfig: 5 }));
  assert.throws(
    () => parseConfigFile(path.join(dir, ".echoriad.json"), "project config"),
    /non-empty string/,
  );
});

test("other scalar fields keep independent precedence (cpus example)", () => {
  const project: ProjectConfig = { cpus: 4 };
  const system: ProjectConfig = { cpus: 2, memory: "4G" };
  const cpus = project.cpus ?? system.cpus;
  const memory = project.memory ?? system.memory;
  assert.equal(cpus, 4);
  assert.equal(memory, "4G");
});

test("invalid field types fail with file-and-field messages", (t) => {
  const cases: { name: string; content: unknown; message: RegExp }[] = [
    {
      name: "numeric image",
      content: { image: 5 },
      message: /field "image" must be a non-empty string/,
    },
    {
      name: "blank image",
      content: { image: "  " },
      message: /field "image" must be a non-empty string/,
    },
    { name: "string cpus", content: { cpus: "4" }, message: /field "cpus" must be an integer/ },
    { name: "numeric memory", content: { memory: 2 }, message: /field "memory" must be a string/ },
    {
      name: "non-array allowedHosts",
      content: { network: { allowedHosts: "api.github.com" } },
      message: /"network.allowedHosts" must be an array of strings/,
    },
    {
      name: "non-string secret hosts",
      content: { network: { secrets: { GITHUB_TOKEN: { hosts: "api.github.com" } } } },
      message: /"network.secrets.GITHUB_TOKEN.hosts" must be an array of strings/,
    },
    {
      name: "non-string fromEnv",
      content: { network: { secrets: { GITHUB_TOKEN: { hosts: [], fromEnv: 1 } } } },
      message: /"network.secrets.GITHUB_TOKEN.fromEnv" must be a string/,
    },
    {
      name: "numeric tcp upstream",
      content: { network: { tcp: { postgres: 5432 } } },
      message: /"network.tcp" must be an object mapping/,
    },
    {
      name: "non-boolean enabled",
      content: { network: { enabled: "yes" } },
      message: /"network.enabled" must be a boolean/,
    },
    { name: "array mounts", content: { mounts: [] }, message: /"mounts" must be an object/ },
  ];
  for (const { name, content, message } of cases) {
    const { dir, write } = makeConfigDir(t);
    write(JSON.stringify(content));
    assert.throws(
      () => parseConfigFile(path.join(dir, ".echoriad.json"), "project config"),
      message,
      name,
    );
  }
});

test("valid scalar and network fields parse", (t) => {
  const { dir, write } = makeConfigDir(t);
  write(
    JSON.stringify({
      image: "my:latest",
      cpus: 4,
      memory: "2G",
      mounts: { "/mnt/extra": "extra" },
      network: {
        enabled: true,
        allowedHosts: ["api.github.com"],
        secrets: { GITHUB_TOKEN: { hosts: ["api.github.com"], fromEnv: "GITHUB_TOKEN" } },
        tcp: { postgres: "127.0.0.1:5432" },
      },
    }),
  );
  const parsed = parseConfigFile(path.join(dir, ".echoriad.json"), "project config");
  assert.equal(parsed.image, "my:latest");
  assert.equal(parsed.cpus, 4);
  assert.equal(parsed.memory, "2G");
});

test("the system config schema accepts a boolean plain field", (t) => {
  const { write } = makeConfigDir(t);
  const configPath = write(JSON.stringify({ plain: true }));
  const parsed = parseConfigFile(configPath, "system config", "system");
  assert.equal(parsed.plain, true);
});

test("a non-boolean plain field fails in the system config", (t) => {
  const { write } = makeConfigDir(t);
  const configPath = write(JSON.stringify({ plain: "yes" }));
  assert.throws(
    () => parseConfigFile(configPath, "system config", "system"),
    /field "plain" must be a boolean/,
  );
});

test("plain is not a project config field", (t) => {
  const { write } = makeConfigDir(t);
  const configPath = write(JSON.stringify({ plain: true }));
  assert.throws(
    () => parseConfigFile(configPath, "project config"),
    /"plain" is only valid in the system config/,
  );
});

test("an unreadable config file fails loudly; a missing one reads as absent", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A directory at the config path fails to read (EISDIR) and must surface.
  const configPath = path.join(dir, ".echoriad.json");
  fs.mkdirSync(configPath);
  assert.throws(() => parseConfigFile(configPath, "project config"), ConfigError);
  assert.throws(() => parseConfigFile(configPath, "project config"), /could not read/);
  // A missing file is the intended "no configuration" case.
  assert.deepEqual(parseConfigFile(path.join(dir, "absent.json"), "project config"), {});
});
