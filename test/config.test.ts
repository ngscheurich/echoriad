import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type ProjectConfig, parseConfigFile, resolveImageSelection } from "../src/config.ts";

function makeConfigDir(): { dir: string; write: (content: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-config-"));
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

test("parseConfigFile rejects image + buildConfig in the same file", () => {
  const { dir, write } = makeConfigDir();
  write(JSON.stringify({ image: "a:1", buildConfig: "b.json" }));
  assert.throws(
    () => parseConfigFile(path.join(dir, ".echoriad.json"), "project config"),
    /defines both "image" and "buildConfig"/,
  );
});

test("buildConfig must be a non-empty string", () => {
  const { dir, write } = makeConfigDir();
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
