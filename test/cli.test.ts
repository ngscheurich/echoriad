import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import {
  type AuthorizationAssociation,
  readAuthorizations,
  saveAssociations,
} from "../src/authorization.ts";
import { main } from "../src/cli/index.ts";
import type { UiStream } from "../src/cli/ui.ts";
import { CancelledError } from "../src/cli/ui.ts";
import { ConfigError } from "../src/config.ts";

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
    loadSystemConfig: () => ({}),
    ...overrides,
  };
}

test("main reports an unknown command through the error convention", async () => {
  const stderr = captureStream();
  const exit = await main(["frobnicate"], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), 'error: unknown command "frobnicate"\n');
});

test("main reports a missing command through the error convention", async () => {
  const stderr = captureStream();
  const exit = await main([], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), "error: missing command\n");
});

test("main rejects unknown global options", async () => {
  const stderr = captureStream();
  const exit = await main(["--color", "status"], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), 'error: unknown option "--color"\n');
});

test("main reuses ConfigError messages verbatim", async () => {
  const stderr = captureStream();
  const configError = new ConfigError(
    "Echoriad: invalid system config (/x/config.json): broken",
    "/x/config.json",
  );
  const exit = await main(
    ["status"],
    testDeps({
      stderr,
      loadSystemConfig: () => {
        throw configError;
      },
    }),
  );
  assert.equal(exit, 1);
  assert.equal(
    stderr.output(),
    "error: Echoriad: invalid system config (/x/config.json): broken\n",
  );
});

test("main accepts the --plain flag before the command", async () => {
  // Flags after the command name belong to the command itself; only
  // --plain is recognized before it.
  const stderr = captureStream();
  const exit = await main(["--plain", "frobnicate"], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), 'error: unknown command "frobnicate"\n');
});

test("main dispatches to the build command and reports its errors", async () => {
  const stderr = captureStream();
  const exit = await main(["build", "--bogus"], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), 'error: unknown option "--bogus"\n');
});
const BUILD_CONFIG = JSON.stringify({
  arch: "aarch64",
  distro: "alpine",
  alpine: { version: "3.23.0" },
});

/** A project with a build-config selection and a private cache directory. */
function makeCliProject(t: TestContext): {
  dir: string;
  cacheDir: string;
  authFile: string;
  consumer: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, ".echoriad.json"),
    JSON.stringify({ buildConfig: "build-config.json" }),
  );
  fs.writeFileSync(path.join(dir, "build-config.json"), BUILD_CONFIG);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-cli-cache-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const authFile = path.join(cacheDir, "echoriad", "image-authorizations.json");
  // authorizationFilePath() reads the process environment at call time,
  // so the cache location is steered through XDG_CACHE_HOME.
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheDir;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
  });
  return {
    dir,
    cacheDir,
    authFile,
    consumer: `root:${fs.realpathSync(dir)}`,
  };
}

test("approve --yes runs the full pipeline through main and records the association", async (t) => {
  const project = makeCliProject(t);
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await main(
    ["approve", "--yes"],
    testDeps({
      stdout,
      stderr,
      cwd: project.dir,
      isInteractive: false,
      resolveImage: () => ({ buildId: "build-cli" }),
    }),
  );
  assert.equal(exit, 0);
  assert.match(stdout.output(), /Action: reuse the globally cached image/);
  assert.match(stdout.output(), /approved [0-9a-f]{12} \(build build-cli\)/);

  const associations = readAuthorizations(project.authFile);
  assert.equal(associations.length, 1);
  assert.equal(associations[0]!.consumer, project.consumer);
  assert.equal(associations[0]!.config, "repo:build-config.json");
  assert.equal(associations[0]!.buildId, "build-cli");
  assert.match(associations[0]!.fingerprint, /^[0-9a-f]{64}$/);
});

test("approve reports a declined prompt through the error convention", async (t) => {
  const project = makeCliProject(t);
  const stderr = captureStream();
  const exit = await main(
    ["approve"],
    testDeps({
      stderr,
      cwd: project.dir,
      resolveImage: () => ({ buildId: "build-cli" }),
      confirm: async () => false,
    }),
  );
  assert.equal(exit, 1);
  assert.equal(stderr.output(), "error: not approved; no build approval recorded\n");
});

test("a cancelled approve prompt prints the cancel convention", async (t) => {
  const project = makeCliProject(t);
  const stderr = captureStream();
  const exit = await main(
    ["approve"],
    testDeps({
      stderr,
      cwd: project.dir,
      resolveImage: () => ({ buildId: "build-cli" }),
      confirm: async () => {
        throw new CancelledError("approve");
      },
    }),
  );
  assert.equal(exit, 1);
  assert.equal(stderr.output(), "cancelled: approve\n");
});

test("approve reports unknown options after the command verb", async (t) => {
  const project = makeCliProject(t);
  const stderr = captureStream();
  const exit = await main(["approve", "--bogus"], testDeps({ stderr, cwd: project.dir }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), 'error: unknown option "--bogus"\n');
});

test("revoke --all --yes runs through main and keeps other consumers' associations", async (t) => {
  const project = makeCliProject(t);
  const own: AuthorizationAssociation = {
    consumer: project.consumer,
    config: "repo:build-config.json",
    fingerprint: "a".repeat(64),
    buildId: "build-a",
  };
  const other: AuthorizationAssociation = {
    consumer: "git:/elsewhere/.git",
    config: "repo:build-config.json",
    fingerprint: "a".repeat(64),
    buildId: "build-a",
  };
  saveAssociations(project.authFile, [own, other]);
  const stdout = captureStream();
  const exit = await main(
    ["revoke", "--all", "--yes"],
    testDeps({
      stdout,
      cwd: project.dir,
      isInteractive: false,
    }),
  );
  assert.equal(exit, 0);
  assert.equal(stdout.output(), "revoked aaaaaaaaaaaa (repo:build-config.json)\n");
  assert.deepEqual(readAuthorizations(project.authFile), [other]);
});

test("a cancelled revoke multiselect prints the cancel convention", async (t) => {
  const project = makeCliProject(t);
  saveAssociations(project.authFile, [
    {
      consumer: project.consumer,
      config: "repo:build-config.json",
      fingerprint: "a".repeat(64),
      buildId: "build-a",
    },
  ]);
  const stderr = captureStream();
  const exit = await main(
    ["revoke"],
    testDeps({
      stderr,
      cwd: project.dir,
      multiselect: async () => {
        throw new CancelledError("revoke");
      },
    }),
  );
  assert.equal(exit, 1);
  assert.equal(stderr.output(), "cancelled: revoke\n");
});

test("revoke without prompts fails closed without a terminal", async (t) => {
  const project = makeCliProject(t);
  saveAssociations(project.authFile, [
    {
      consumer: project.consumer,
      config: "repo:build-config.json",
      fingerprint: "a".repeat(64),
      buildId: "build-a",
    },
  ]);
  const stderr = captureStream();
  const exit = await main(
    ["revoke", "--yes"],
    testDeps({ stderr, cwd: project.dir, isInteractive: false }),
  );
  assert.equal(exit, 1);
  assert.match(stderr.output(), /revoke needs an interactive terminal/);
  assert.match(stderr.output(), /revoke --all --yes/);
});
