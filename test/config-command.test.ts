import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import type { UiStream } from "../src/cli/ui.ts";
import { ConfigError, systemConfigPath } from "../src/config.ts";

interface CapturedStream extends UiStream {
  output(): string;
}

function captureStream(): CapturedStream {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    output: () => chunks.join(""),
  };
}

function testDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    env: {},
    isInteractive: true,
    cwd: "/proj",
    loadSystemConfig: () => ({}),
    loadProjectConfig: () => ({}),
    ...overrides,
  };
}

/** The one human-readable line a named field produces, or a failure. */
function fieldLine(name: string, output: string): string {
  const line = output.split("\n").find((l) => l.startsWith(`${name}: `));
  assert.ok(line, `expected a "${name}:" line in:\n${output}`);
  return line;
}

test("config shows every field at its built-in default when nothing is set", async () => {;
  const stdout = captureStream();
  const exit = await main(["config"], testDeps({ stdout }));
  assert.equal(exit, 0);
  assert.equal(
    stdout.output(),
    "image: default (built-in default)\n" +
      "cpus: not set (built-in default)\n" +
      "memory: not set (built-in default)\n" +
      "network: not set (built-in default)\n" +
      "mounts: not set (built-in default)\n",
  );
});

test("config shows a project buildConfig with its canonical path", async () => {;
  const stdout = captureStream();
  const exit = await main(
    ["config"],
    testDeps({ stdout, loadProjectConfig: () => ({ buildConfig: "build.json" }) }),
  );
  assert.equal(exit, 0);
  assert.equal(
    fieldLine("image", stdout.output()),
    "image: buildConfig /proj/build.json (project)",
  );
});

test("config shows a system buildConfig resolved against the system config directory", async () => {;
  const stdout = captureStream();
  const exit = await main(
    ["config"],
    testDeps({ stdout, loadSystemConfig: () => ({ buildConfig: "build.json" }) }),
  );
  assert.equal(exit, 0);
  const expected = path.resolve(path.dirname(systemConfigPath()), "build.json");
  assert.equal(fieldLine("image", stdout.output()), `image: buildConfig ${expected} (system)`);
});

test("config shows a project image selector with its base dir", async () => {;
  const stdout = captureStream();
  const exit = await main(
    ["config"],
    testDeps({ stdout, loadProjectConfig: () => ({ image: "proj:1" }) }),
  );
  assert.equal(exit, 0);
  assert.equal(
    fieldLine("image", stdout.output()),
    "image: image proj:1 (base dir /proj) (project)",
  );
});

test("config shows a system image selector with the system base dir", async () => {;
  const stdout = captureStream();
  const exit = await main(["config"], testDeps({ stdout, loadSystemConfig: () => ({ image: "sys:1" }) }));
  assert.equal(exit, 0);
  assert.equal(
    fieldLine("image", stdout.output()),
    `image: image sys:1 (base dir ${path.dirname(systemConfigPath())}) (system)`,
  );
});

test("config shows an env image selector with its origin", async () => {;
  const stdout = captureStream();
  const exit = await main(["config"], testDeps({ stdout, env: { ECHORIAD_IMAGE: "env:1" } }));
  assert.equal(exit, 0);
  assert.equal(
    fieldLine("image", stdout.output()),
    `image: image env:1 (base dir ${process.cwd()}) (env)`,
  );
});

test("scalar fields coalesce project over system", async () => {;
  const stdout = captureStream();
  const exit = await main(
    ["config"],
    testDeps({
      stdout,
      loadProjectConfig: () => ({ cpus: 4 }),
      loadSystemConfig: () => ({ cpus: 2, memory: "2G" }),
    }),
  );
  assert.equal(exit, 0);
  const output = stdout.output();
  assert.equal(fieldLine("cpus", output), "cpus: 4 (project)");
  assert.equal(fieldLine("memory", output), "memory: 2G (system)");
});

test("object fields render as inline JSON with their origin", async () => {;
  const stdout = captureStream();
  const exit = await main(
    ["config"],
    testDeps({
      stdout,
      loadProjectConfig: () => ({ network: { enabled: true } }),
      loadSystemConfig: () => ({ mounts: { "/data": "/data" } }),
    }),
  );
  assert.equal(exit, 0);
  const output = stdout.output();
  assert.equal(fieldLine("network", output), 'network: {"enabled":true} (project)');
  assert.equal(fieldLine("mounts", output), 'mounts: {"/data":"/data"} (system)');
});

test("config --json carries every field with its origin", async () => {;
  const stdout = captureStream();
  const exit = await main(
    ["config", "--json"],
    testDeps({
      stdout,
      loadProjectConfig: () => ({ cpus: 4, network: { enabled: true } }),
      loadSystemConfig: () => ({ memory: "2G" }),
    }),
  );
  assert.equal(exit, 0);
  const parsed = JSON.parse(stdout.output());
  assert.deepEqual(parsed.image, { kind: "default", origin: "built-in default" });
  assert.deepEqual(parsed.cpus, { value: 4, origin: "project" });
  assert.deepEqual(parsed.memory, { value: "2G", origin: "system" });
  assert.deepEqual(parsed.network, { value: { enabled: true }, origin: "project" });
  assert.deepEqual(parsed.mounts, { value: null, origin: "built-in default" });
});

test("config --json carries the image selection with kind and canonical path", async () => {;
  const stdout = captureStream();
  const exit = await main(
    ["config", "--json"],
    testDeps({ stdout, loadProjectConfig: () => ({ buildConfig: "build.json" }) }),
  );
  assert.equal(exit, 0);
  const parsed = JSON.parse(stdout.output());
  assert.deepEqual(parsed.image, {
    kind: "buildConfig",
    configPath: "/proj/build.json",
    origin: "project",
  });
});

test("config --json carries image selectors with their base dir", async () => {;
  const stdout = captureStream();
  const exit = await main(
    ["config", "--json"],
    testDeps({ stdout, loadProjectConfig: () => ({ image: "proj:1" }) }),
  );
  assert.equal(exit, 0);
  const parsed = JSON.parse(stdout.output());
  assert.deepEqual(parsed.image, {
    kind: "image",
    value: "proj:1",
    baseDir: "/proj",
    origin: "project",
  });
});

test("an invalid project config errors instead of degrading the resolved view", async () => {;
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await main(
    ["config"],
    testDeps({
      stdout,
      stderr,
      loadProjectConfig: () => {
        throw new ConfigError(
          "Echoriad: invalid .echoriad.json (/proj/.echoriad.json): broken",
          "/proj/.echoriad.json",
        );
      },
    }),
  );
  assert.equal(exit, 1);
  assert.equal(
    stderr.output(),
    "error: Echoriad: invalid .echoriad.json (/proj/.echoriad.json): broken\n",
  );
  assert.equal(stdout.output(), "");
});

test("an invalid system config errors before any resolved view prints", async () => {;
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await main(
    ["config"],
    testDeps({
      stdout,
      stderr,
      loadSystemConfig: () => {
        throw new ConfigError("Echoriad: invalid system config: broken", "/x/config.json");
      },
    }),
  );
  assert.equal(exit, 1);
  assert.equal(stderr.output(), "error: Echoriad: invalid system config: broken\n");
  assert.equal(stdout.output(), "");
});

test("config rejects unknown options and positional arguments", async () => {;
  const stderr = captureStream();
  const exit = await main(["config", "--frobnicate"], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), 'error: unknown option "--frobnicate"\n');

  const stderr2 = captureStream();
  const exit2 = await main(["config", "extra"], testDeps({ stderr: stderr2 }));
  assert.equal(exit2, 1);
  assert.match(stderr2.output(), /config takes no arguments/);
});

test("config works without a terminal; it never prompts", async () => {;
  const stdout = captureStream();
  const exit = await main(["config"], testDeps({ stdout, isInteractive: false }));
  assert.equal(exit, 0);
  assert.match(stdout.output(), /image: default \(built-in default\)/);
});
