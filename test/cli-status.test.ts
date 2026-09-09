import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { computeStatus, type StatusDeps } from "../src/cli/status.ts";
import type { UiStream } from "../src/cli/ui.ts";
import { GuestImageError } from "../src/guest-image.ts";

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

const CONSUMER_ID = "git:/proj/.git";
const CONFIG_ID = "repo:build.json";
const FINGERPRINT = "a".repeat(64);

/** Deps that resolve to a project build-config selection, overridable per case. */
function buildConfigDeps(overrides: Partial<StatusDeps> = {}): Partial<StatusDeps> {
  return {
    loadProjectConfig: () => ({}),
    loadSystemConfig: () => ({}),
    resolveImageSelection: () => ({
      kind: "buildConfig",
      configPath: "/proj/build.json",
      origin: "project",
    }),
    readFile: () => "{}",
    parseBuildConfig: () => ({ arch: "aarch64", distro: "alpine" }),
    computeBuildFingerprint: () => ({
      fingerprint: FINGERPRINT,
      abbreviated: "a".repeat(12),
      localInputPaths: [],
    }),
    imageRefForFingerprint: (fingerprint: string) => `echoriad-build-${fingerprint}:latest`,
    deriveBuildIdentity: () => ({
      consumerId: CONSUMER_ID,
      consumerLabel: "project (/proj)",
      configId: CONFIG_ID,
    }),
    authorizationFilePath: () => "/tmp/auth.json",
    ...overrides,
  };
}

test("default selection reports no image selected", () => {
  const result = computeStatus("/proj", undefined, {
    loadProjectConfig: () => ({}),
    loadSystemConfig: () => ({}),
    resolveImageSelection: () => ({ kind: "default", origin: "built-in default" }),
  });
  assert.equal(result.verdict, "no image selected");
  assert.equal(result.source.kind, "default");
  assert.equal(result.fingerprint, undefined);
});

test("project image selection reports no image selected with origin", () => {
  const result = computeStatus("/proj", undefined, {
    loadProjectConfig: () => ({}),
    loadSystemConfig: () => ({}),
    resolveImageSelection: () => ({
      kind: "image",
      value: "my:1",
      baseDir: "/proj",
      origin: "project",
    }),
  });
  assert.equal(result.verdict, "no image selected");
  assert.equal(result.source.kind, "project");
  assert.equal(result.source.value, "my:1");
  assert.equal(result.fingerprint, undefined);
});

test("env image selection reports no image selected", () => {
  const result = computeStatus("/proj", "from-env:1", {
    loadProjectConfig: () => ({}),
    loadSystemConfig: () => ({}),
    resolveImageSelection: () => ({
      kind: "image",
      value: "from-env:1",
      baseDir: process.cwd(),
      origin: "env",
    }),
  });
  assert.equal(result.verdict, "no image selected");
  assert.equal(result.source.kind, "env");
  assert.equal(result.source.value, "from-env:1");
});

test("buildConfig with no cached image reports needs build", () => {
  const result = computeStatus(
    "/proj",
    undefined,
    buildConfigDeps({
      resolveImage: () => {
        throw new Error("no image");
      },
      readAuthorizations: () => [],
    }),
  );
  assert.equal(result.verdict, "needs build");
  assert.equal(result.source.kind, "project");
  assert.equal(result.source.value, "/proj/build.json");
  assert.equal(result.fingerprint?.abbreviated, "a".repeat(12));
  assert.equal(result.fingerprint?.full, FINGERPRINT);
});

test("buildConfig with cached image but no association reports needs approval", () => {
  const result = computeStatus(
    "/proj",
    undefined,
    buildConfigDeps({
      resolveImage: () => ({ buildId: "build-123" }),
      readAuthorizations: () => [],
    }),
  );
  assert.equal(result.verdict, "needs approval");
});

test("buildConfig with a stale association build id reports needs approval", () => {
  const result = computeStatus(
    "/proj",
    undefined,
    buildConfigDeps({
      resolveImage: () => ({ buildId: "build-new" }),
      readAuthorizations: () => [
        {
          consumer: CONSUMER_ID,
          config: CONFIG_ID,
          fingerprint: FINGERPRINT,
          buildId: "build-old",
        },
      ],
    }),
  );
  assert.equal(result.verdict, "needs approval");
});

test("buildConfig with a matching association reports up to date", () => {
  const result = computeStatus(
    "/proj",
    undefined,
    buildConfigDeps({
      resolveImage: () => ({ buildId: "build-123" }),
      readAuthorizations: () => [
        {
          consumer: CONSUMER_ID,
          config: CONFIG_ID,
          fingerprint: FINGERPRINT,
          buildId: "build-123",
        },
      ],
    }),
  );
  assert.equal(result.verdict, "up to date");
});

test("a missing build config fails with the pipeline's actionable message", () => {
  assert.throws(
    () =>
      computeStatus(
        "/proj",
        undefined,
        buildConfigDeps({
          readFile: () => {
            const error = new Error("ENOENT: no such file") as Error & { code: string };
            error.code = "ENOENT";
            throw error;
          },
        }),
      ),
    (error: unknown) =>
      error instanceof GuestImageError &&
      /build config \/proj\/build\.json does not exist/.test(error.message) &&
      error.permanent,
  );
});

test("an unreadable build config reports the read failure, not a missing file", () => {
  assert.throws(
    () =>
      computeStatus(
        "/proj",
        undefined,
        buildConfigDeps({
          readFile: () => {
            const error = new Error("EACCES: permission denied") as Error & { code: string };
            error.code = "EACCES";
            throw error;
          },
        }),
      ),
    (error: unknown) =>
      error instanceof GuestImageError &&
      /build config \/proj\/build\.json could not be read: EACCES/.test(error.message) &&
      error.permanent,
  );
});

test("a build config rejected by Gondolin fails with the pipeline's message", () => {
  assert.throws(
    () =>
      computeStatus(
        "/proj",
        undefined,
        buildConfigDeps({
          readFile: () => "{}",
          parseBuildConfig: () => {
            throw new Error("unsupported arch");
          },
        }),
      ),
    (error: unknown) =>
      error instanceof GuestImageError &&
      /build config \/proj\/build\.json was rejected by Gondolin: unsupported arch/.test(
        error.message,
      ),
  );
});

test("a fingerprint failure surfaces as a GuestImageError", () => {
  assert.throws(
    () =>
      computeStatus(
        "/proj",
        undefined,
        buildConfigDeps({
          computeBuildFingerprint: () => {
            throw new Error('Echoriad: build config local input "init.sh" does not exist');
          },
        }),
      ),
    (error: unknown) =>
      error instanceof GuestImageError &&
      /local input "init\.sh" does not exist/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// CLI integration through main()
// ---------------------------------------------------------------------------

function mainDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stdout: captureStream(),
    stderr: captureStream(),
    env: {},
    cwd: "/proj",
    isInteractive: true,
    loadSystemConfig: () => ({}),
    ...overrides,
  };
}

test("main runs status and reports the default selection", () => {
  const deps = mainDeps();
  const exit = main(["status"], deps);
  assert.equal(exit, 0);
  const stdout = (deps.stdout as CapturedStream).output();
  assert.equal(stdout, "source: default\nverdict: no image selected\n");
});

test("main runs status --json and carries the complete state", () => {
  const deps = mainDeps();
  const exit = main(["status", "--json"], deps);
  assert.equal(exit, 0);
  const parsed = JSON.parse((deps.stdout as CapturedStream).output()) as Record<string, unknown>;
  assert.deepEqual(parsed.source, { kind: "default" });
  assert.equal(parsed.verdict, "no image selected");
  assert.equal("fingerprint" in parsed, false);
});

test("main status reports a project image selector", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".echoriad.json"), JSON.stringify({ image: "my:1" }));
  const deps = mainDeps({ cwd: dir });
  const exit = main(["status"], deps);
  assert.equal(exit, 0);
  const stdout = (deps.stdout as CapturedStream).output();
  assert.equal(stdout, "source: project (my:1)\nverdict: no image selected\n");
});

test("main status reports an env image selector", () => {
  const deps = mainDeps({ env: { ECHORIAD_IMAGE: "env:1" } });
  const exit = main(["status"], deps);
  assert.equal(exit, 0);
  const stdout = (deps.stdout as CapturedStream).output();
  assert.equal(stdout, "source: env (env:1)\nverdict: no image selected\n");
});

test("main status reports an invalid project config through the error convention", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, ".echoriad.json"),
    JSON.stringify({ image: "a:1", buildConfig: "b.json" }),
  );
  const deps = mainDeps({ cwd: dir });
  const exit = main(["status"], deps);
  assert.equal(exit, 1);
  const stderr = (deps.stderr as CapturedStream).output();
  assert.match(stderr, /^error: Echoriad: invalid \.echoriad\.json/);
  assert.match(stderr, /defines both/);
});

test("main status rejects unknown options", () => {
  const deps = mainDeps();
  const exit = main(["status", "--verbose"], deps);
  assert.equal(exit, 1);
  const stderr = (deps.stderr as CapturedStream).output();
  assert.equal(stderr, 'error: unknown option "--verbose" for status\n');
});

test("main status reports a missing build config through the error convention", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, ".echoriad.json"),
    JSON.stringify({ buildConfig: "missing-build.json" }),
  );
  const deps = mainDeps({ cwd: dir });
  const exit = main(["status"], deps);
  assert.equal(exit, 1);
  const stderr = (deps.stderr as CapturedStream).output();
  assert.match(stderr, /^error: Echoriad: build config .* does not exist/);
});
