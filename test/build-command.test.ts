import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type BuildDeps, buildCommand, renderApprovalSummary } from "../src/cli/build.ts";
import { CancelledError, CliError, createUi, type Ui, type UiStream } from "../src/cli/ui.ts";
import { GuestImageError, type PrepareGuestImageOptions } from "../src/guest-image.ts";

const ABBREV = "abcdef123456";

function captureStream(): UiStream & { output(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    output: () => chunks.join(""),
  };
}

function captureUi(plain: boolean, isInteractive: boolean): { ui: Ui; stdout: () => string } {
  const stdout = captureStream();
  const ui = createUi({ stdout, stderr: captureStream(), plain, isInteractive });
  return { ui, stdout: stdout.output };
}

/** A temp project with a project-selected build config on disk. */
function makeProject(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-build-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "build-config.json"),
    JSON.stringify({ arch: "aarch64", distro: "alpine", alpine: { version: "3.23.0" } }),
  );
  fs.writeFileSync(
    path.join(dir, ".echoriad.json"),
    JSON.stringify({ buildConfig: "build-config.json" }),
  );
  return dir;
}

type PrepareBehavior = "upToDate" | "reuse" | "build" | "fail";

/**
 * A fake pipeline with the real one's contract: the up-to-date path never
 * calls approve; every other path prompts first, then builds (streaming
 * output) or adopts the cache. The fail path throws after streaming.
 */
function fakePrepare(behavior: PrepareBehavior): {
  prepare: BuildDeps["prepareGuestImage"];
  calls: PrepareGuestImageOptions[];
} {
  const calls: PrepareGuestImageOptions[] = [];
  const result = (built: boolean) => ({
    imageSelector: "build-id-1",
    fingerprint: "f".repeat(64),
    abbreviatedFingerprint: ABBREV,
    imageRef: `echoriad-build-${"f".repeat(64)}:latest`,
    buildId: "build-id-1",
    built,
    configPath: calls[0]!.configPath,
  });
  const prepare: BuildDeps["prepareGuestImage"] = async (options) => {
    calls.push(options);
    if (behavior === "upToDate" && !options.force) return result(false);
    const action = behavior === "reuse" && !options.force ? "reuse" : "build";
    const approved = await options.approve(action, `${action.toUpperCase()} SUMMARY`);
    if (!approved) {
      throw new GuestImageError(
        "Echoriad: the guest image request was not approved; VM startup stopped.",
        { permanent: true },
      );
    }
    if (behavior === "fail") {
      options.onBuildOutput?.("step 1\nhalf ");
      throw new GuestImageError("Echoriad: guest image build failed (Gondolin exited with code 1)");
    }
    if (behavior === "build" && action === "build") {
      options.onBuildOutput?.("step 1\nstep 2\r\npartial ");
    }
    return result(action === "build");
  };
  return { prepare, calls };
}

/** Deps with a recording prompt that answers `answer`. */
function recordingDeps(
  projectRoot: string,
  prepare: BuildDeps["prepareGuestImage"],
  answer: boolean | Error,
  overrides: Partial<BuildDeps> = {},
): { deps: BuildDeps; prompts: { action: string; summary: string }[] } {
  const prompts: { action: string; summary: string }[] = [];
  const deps: BuildDeps = {
    cwd: () => projectRoot,
    envImage: () => undefined,
    loadSystemConfig: () => ({}),
    prepareGuestImage: prepare,
    prompt: async (action, summary) => {
      prompts.push({ action, summary });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    ...overrides,
  };
  return { deps, prompts };
}

test("build rejects projects that select an existing image", async (t) => {
  const dir = makeProject(t);
  fs.writeFileSync(path.join(dir, ".echoriad.json"), JSON.stringify({ image: "base:latest" }));
  const { prepare, calls } = fakePrepare("upToDate");
  const { deps } = recordingDeps(dir, prepare, true);
  const { ui } = captureUi(true, true);
  await assert.rejects(
    buildCommand([], ui, deps),
    (error: CliError) =>
      error instanceof CliError &&
      /build applies to build-config selections only/.test(error.message) &&
      /the existing image "base:latest"/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("build rejects projects with no image selection at all", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-build-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { prepare, calls } = fakePrepare("upToDate");
  const { deps } = recordingDeps(dir, prepare, true);
  const { ui } = captureUi(true, true);
  await assert.rejects(
    buildCommand([], ui, deps),
    (error: CliError) => error instanceof CliError && /the default image/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("an authorized cached image prints up to date and records nothing", async (t) => {
  const dir = makeProject(t);
  const { prepare, calls } = fakePrepare("upToDate");
  const { deps, prompts } = recordingDeps(dir, prepare, true);
  const { ui, stdout } = captureUi(true, true);
  await buildCommand([], ui, deps);
  assert.equal(stdout(), "up to date\n");
  assert.equal(prompts.length, 0);
  const options = calls[0]!;
  assert.equal(options.projectRoot, dir);
  assert.equal(options.configId, "repo:build-config.json");
  assert.match(options.consumerId, /^root:/);
  assert.equal(options.consumer, `project (${options.consumerId.slice("root:".length)})`);
  assert.equal(options.interactive, true);
  assert.equal(options.force, false);
});

test("a build prompts with the action and summary and streams discrete output lines", async (t) => {
  const dir = makeProject(t);
  const { prepare, calls } = fakePrepare("build");
  const { deps, prompts } = recordingDeps(dir, prepare, true);
  const { ui, stdout } = captureUi(true, true);
  await buildCommand([], ui, deps);
  assert.deepEqual(prompts, [{ action: "build", summary: "BUILD SUMMARY" }]);
  assert.equal(calls[0]!.force, false);
  const lines = stdout().split("\n");
  assert.ok(lines.includes("step 1"));
  assert.ok(lines.includes("step 2"));
  assert.ok(lines.includes("partial"));
  assert.equal(lines.at(-2), `guest image build complete ${ABBREV}`);
});

test("an approved cache reuse reports the reused image", async (t) => {
  const dir = makeProject(t);
  const { prepare } = fakePrepare("reuse");
  const { deps, prompts } = recordingDeps(dir, prepare, true);
  const { ui, stdout } = captureUi(true, true);
  await buildCommand([], ui, deps);
  assert.deepEqual(prompts, [{ action: "reuse", summary: "REUSE SUMMARY" }]);
  assert.equal(stdout(), `reused cached guest image ${ABBREV}\n`);
});

test("--force rebuilds the current fingerprint", async (t) => {
  const dir = makeProject(t);
  const { prepare, calls } = fakePrepare("upToDate");
  const { deps, prompts } = recordingDeps(dir, prepare, true);
  const { ui, stdout } = captureUi(true, true);
  await buildCommand(["--force"], ui, deps);
  assert.equal(calls[0]!.force, true);
  assert.deepEqual(prompts, [{ action: "build", summary: "BUILD SUMMARY" }]);
  assert.equal(stdout(), `guest image build complete ${ABBREV}\n`);
});

test("unknown options and stray arguments are command errors", async (t) => {
  const dir = makeProject(t);
  const { prepare } = fakePrepare("upToDate");
  const { deps } = recordingDeps(dir, prepare, true);
  const { ui } = captureUi(true, true);
  await assert.rejects(buildCommand(["--bogus"], ui, deps), /unknown option "--bogus"/);
  await assert.rejects(buildCommand(["extra"], ui, deps), /unexpected argument "extra"/);
});

test("authorization-store warnings surface on the output seam", async (t) => {
  const dir = makeProject(t);
  const prepare: BuildDeps["prepareGuestImage"] = async (options) => {
    options.onWarning?.("Echoriad: the image build authorization metadata is malformed");
    return {
      imageSelector: "b",
      fingerprint: "f".repeat(64),
      abbreviatedFingerprint: ABBREV,
      imageRef: "r",
      buildId: "b",
      built: false,
      configPath: options.configPath,
    };
  };
  const { deps } = recordingDeps(dir, prepare, true);
  const { ui, stdout } = captureUi(true, true);
  await buildCommand([], ui, deps);
  assert.match(stdout(), /authorization metadata is malformed/);
  assert.match(stdout(), /up to date/);
});

test("cancelling the approval prompt aborts as cancelled, not denied", async (t) => {
  const dir = makeProject(t);
  const { prepare } = fakePrepare("build");
  const { deps } = recordingDeps(dir, prepare, new CancelledError("build"));
  const { ui } = captureUi(true, true);
  await assert.rejects(
    buildCommand([], ui, deps),
    (error: CancelledError) => error instanceof CancelledError && error.command === "build",
  );
});

test("a denied approval propagates the pipeline's fail-closed error", async (t) => {
  const dir = makeProject(t);
  const { prepare } = fakePrepare("build");
  const { deps } = recordingDeps(dir, prepare, false);
  const { ui, stdout } = captureUi(true, true);
  await assert.rejects(buildCommand([], ui, deps), /not approved/);
  assert.equal(stdout(), "");
});

test("noninteractive sessions propagate the pipeline's fail-closed error", async (t) => {
  const dir = makeProject(t);
  const prepare: BuildDeps["prepareGuestImage"] = async (options) => {
    if (!options.interactive) {
      throw new GuestImageError(
        "Echoriad: the selected build config requires approval before building " +
          "the guest image, but this session is noninteractive.",
        { permanent: true },
      );
    }
    throw new Error("unreachable");
  };
  const { deps } = recordingDeps(dir, prepare, true);
  const { ui, stdout } = captureUi(false, false);
  await assert.rejects(
    buildCommand([], ui, deps),
    (error: GuestImageError) => /noninteractive/.test(error.message) && error.permanent,
  );
  assert.equal(stdout(), "");
});

test("a failed build keeps its streamed lines and flushes the partial last line", async (t) => {
  const dir = makeProject(t);
  const { prepare } = fakePrepare("fail");
  const { deps } = recordingDeps(dir, prepare, true);
  const { ui, stdout } = captureUi(true, true);
  await assert.rejects(buildCommand([], ui, deps), /Gondolin exited with code 1/);
  const lines = stdout().split("\n");
  assert.ok(lines.includes("step 1"));
  assert.ok(lines.includes("half"));
});

test("a system-selected build config runs with the system consumer identity", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-build-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "sys-build-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ arch: "aarch64", distro: "alpine" }));
  const { prepare, calls } = fakePrepare("upToDate");
  const { deps } = recordingDeps(dir, prepare, true, {
    loadSystemConfig: () => ({ buildConfig: configPath }),
  });
  const { ui, stdout } = captureUi(true, true);
  await buildCommand([], ui, deps);
  const options = calls[0]!;
  assert.equal(options.configPath, configPath);
  assert.equal(options.consumerId, "system");
  assert.equal(options.consumer, "system configuration");
  // A system-selected config is identified by its canonical path, which
  // differs from the temp-dir path when the OS symlinks its temp root
  // (macOS /var/folders -> /private/var/folders).
  assert.equal(options.configId, `file:${fs.realpathSync(configPath)}`);
  assert.equal(stdout(), "up to date\n");
});

test("an environment image selector is rejected like a configured one", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-build-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { prepare, calls } = fakePrepare("upToDate");
  const { deps } = recordingDeps(dir, prepare, true, {
    envImage: () => "env-image:latest",
  });
  const { ui } = captureUi(true, true);
  await assert.rejects(
    buildCommand([], ui, deps),
    (error: CliError) =>
      error instanceof CliError && /the existing image "env-image:latest"/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("framed mode completes without touching the plain seam for lines", async (t) => {
  // Clack framing writes to the terminal directly; running it here only
  // exercises the code path — the plain-seam content is asserted above.
  const dir = makeProject(t);
  const { prepare } = fakePrepare("upToDate");
  const { deps } = recordingDeps(dir, prepare, true);
  const { ui, stdout } = captureUi(false, true);
  await buildCommand([], ui, deps);
  assert.equal(stdout(), "");
});

test("the approval summary renders verbatim on the plain seam", () => {
  const { ui, stdout } = captureUi(true, true);
  const summary = "Action: build the guest image from this build config\n\nWarning line";
  renderApprovalSummary(ui, summary);
  assert.equal(stdout(), `${summary}\n`);
});
