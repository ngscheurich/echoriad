import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BuildConfig } from "@earendil-works/gondolin";
import type { AuthorizationAssociation } from "../src/authorization.ts";
import type { Ui, UiStream } from "../src/cli/ui.ts";
import { CancelledError, createUi } from "../src/cli/ui.ts";
import type { GuestImageDeps, GuestImageError } from "../src/guest-image.ts";

// The approval prompt is clack `confirm`; tests redirect it to the fixture
// so the cancel path is drivable without a terminal.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@clack/prompts" && context.parentURL?.endsWith("/src/cli/image.ts")) {
      return { url: new URL("./fixtures/clack.ts", import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { state: clack } = await import("./fixtures/clack.ts");
const { resolveGuestImage } = await import("../src/cli/image.ts");

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

function makeUi(interactive: boolean): { ui: Ui; stdout: CapturedStream; stderr: CapturedStream } {
  const stdout = captureStream();
  const stderr = captureStream();
  const ui = createUi({ stdout, stderr, plain: false, isInteractive: interactive });
  return { ui, stdout, stderr };
}

const FINGERPRINT = "f".repeat(64);

function baseConfig(): BuildConfig {
  return { arch: "aarch64", distro: "alpine", alpine: { version: "3.23.0" } };
}

type BuiltCommand = { configPath: string; outputDir: string; imageRef: string };

/**
 * Pipeline deps mirroring test/guest-image.test.ts: a fixed fingerprint, a
 * ref set that stands in for Gondolin's store, and recorded builds.
 */
function prepareDeps(overrides: {
  existingRefs?: Set<string>;
  authorizations?: AuthorizationAssociation[];
  builtCommands?: BuiltCommand[];
  emitDuringBuild?: (emit: (chunk: string) => void) => void;
}): Partial<GuestImageDeps> {
  const config = baseConfig();
  return {
    readConfig: () => JSON.stringify(config),
    parseConfig: () => config,
    fingerprint: () => ({
      fingerprint: FINGERPRINT,
      abbreviated: "f".repeat(12),
      localInputPaths: [],
    }),
    resolveImage: (selector: string) => {
      if (overrides.existingRefs?.has(selector)) return { buildId: "existing-build-id" };
      throw new Error(`no image for ${selector}`);
    },
    build: async (command, onOutput) => {
      overrides.builtCommands?.push(command);
      overrides.emitDuringBuild?.((chunk) => onOutput?.(chunk));
      overrides.existingRefs?.add(command.imageRef);
    },
    makeOutputDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-image-test-")),
    removeOutputDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    readAuthorizations: () => overrides.authorizations ?? [],
    writeAuthorization: () => {},
  };
}

/** A temp project holding a build config; ECHORIAD_IMAGE is neutralized. */
function project(overrides: { project?: object } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-cli-image-"));
  const configPath = path.join(dir, "build-config.json");
  fs.writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2));
  const previousImage = process.env.ECHORIAD_IMAGE;
  delete process.env.ECHORIAD_IMAGE;
  return {
    dir,
    configPath,
    configs: {
      project: { buildConfig: "build-config.json", ...(overrides.project ?? {}) },
      system: {},
    },
    restore() {
      if (previousImage === undefined) delete process.env.ECHORIAD_IMAGE;
      else process.env.ECHORIAD_IMAGE = previousImage;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a default selection resolves to no image path", () => {
  const { ui } = makeUi(false);
  const resolved = resolveGuestImage({
    projectRoot: "/proj",
    configs: { project: {}, system: {} },
    ui,
    command: "echoriad bash",
  });
  return resolved.then((value) => {
    assert.deepEqual(value, {});
  });
});

test("an image selector passes through unless it names a directory", (t) => {
  const proj = project();
  t.after(() => proj.restore());
  fs.mkdirSync(path.join(proj.dir, "assets"));
  const { ui } = makeUi(false);

  const selector = resolveGuestImage({
    projectRoot: proj.dir,
    configs: { project: { image: "my-image:latest" }, system: {} },
    ui,
    command: "echoriad bash",
  });
  const directory = resolveGuestImage({
    projectRoot: proj.dir,
    configs: { project: { image: "assets" }, system: {} },
    ui,
    command: "echoriad bash",
  });

  return Promise.all([selector, directory]).then(([a, b]) => {
    assert.equal(a.imagePath, "my-image:latest");
    assert.equal(b.imagePath, path.resolve(proj.dir, "assets"));
  });
});

test("an authorized cached build is reused silently with its build id", async (t) => {
  const proj = project();
  t.after(() => proj.restore());
  const { ui, stdout } = makeUi(true);
  const authorizations: AuthorizationAssociation[] = [
    {
      consumer: `root:${fs.realpathSync(proj.dir)}`,
      config: "repo:build-config.json",
      fingerprint: FINGERPRINT,
      buildId: "existing-build-id",
    },
  ];
  const builtCommands: BuiltCommand[] = [];

  const resolved = await resolveGuestImage({
    projectRoot: proj.dir,
    configs: proj.configs,
    ui,
    command: "echoriad bash",
    deps: {
      prepare: prepareDeps({
        existingRefs: new Set([`echoriad-build-${FINGERPRINT}:latest`]),
        authorizations,
        builtCommands,
      }),
    },
  });

  assert.equal(resolved.imagePath, "existing-build-id");
  assert.equal(resolved.build?.built, false);
  assert.equal(builtCommands.length, 0);
  assert.match(stdout.output(), /Echoriad: reusing authorized guest image f{12}/);
});

test("a noninteractive session fails closed when approval is needed", async (t) => {
  const proj = project();
  t.after(() => proj.restore());
  const { ui } = makeUi(false);
  let approved = false;

  await assert.rejects(
    resolveGuestImage({
      projectRoot: proj.dir,
      configs: proj.configs,
      ui,
      command: "echoriad bash",
      deps: {
        approve: async () => {
          approved = true;
          return true;
        },
        prepare: prepareDeps({ existingRefs: new Set() }),
      },
    }),
    (error: GuestImageError) => /noninteractive/.test(error.message) && error.permanent,
  );
  assert.equal(approved, false);
});

test("an approved build resolves to the built image and streams output lines", async (t) => {
  const proj = project();
  t.after(() => proj.restore());
  const { ui, stdout } = makeUi(true);
  const approvals: { action: string; summary: string }[] = [];
  const builtCommands: BuiltCommand[] = [];

  const resolved = await resolveGuestImage({
    projectRoot: proj.dir,
    configs: proj.configs,
    ui,
    command: "echoriad bash",
    deps: {
      approve: async (action, summary) => {
        approvals.push({ action, summary });
        return true;
      },
      prepare: prepareDeps({
        existingRefs: new Set(),
        builtCommands,
        emitDuringBuild: (emit) => {
          emit("step one\n");
          emit("step ");
          emit("two\n");
        },
      }),
    },
  });

  assert.equal(resolved.imagePath, "existing-build-id");
  assert.equal(resolved.build?.built, true);
  assert.equal(builtCommands.length, 1);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.action, "build");
  assert.match(approvals[0]?.summary ?? "", /Action: build the guest image/);
  // Discrete lines: partial chunks coalesce, one line per output line.
  assert.match(stdout.output(), /step one\n/);
  assert.match(stdout.output(), /step two\n/);
  assert.match(stdout.output(), /Echoriad: building guest image f{12}/);
  assert.match(stdout.output(), /Echoriad: guest image build complete f{12}/);
});

test("a denied approval stops image resolution", async (t) => {
  const proj = project();
  t.after(() => proj.restore());
  const { ui } = makeUi(true);

  await assert.rejects(
    resolveGuestImage({
      projectRoot: proj.dir,
      configs: proj.configs,
      ui,
      command: "echoriad bash",
      deps: {
        approve: async () => false,
        prepare: prepareDeps({ existingRefs: new Set() }),
      },
    }),
    /not approved/,
  );
});

test("a cancelled approval prompt reports the command as cancelled", async (t) => {
  const proj = project();
  t.after(() => proj.restore());
  const { ui } = makeUi(true);
  clack.answer = clack.cancel;
  t.after(() => {
    clack.answer = true;
    clack.messages.length = 0;
  });

  await assert.rejects(
    resolveGuestImage({
      projectRoot: proj.dir,
      configs: proj.configs,
      ui,
      command: "echoriad bash",
      deps: { prepare: prepareDeps({ existingRefs: new Set() }) },
    }),
    (error: CancelledError) => error instanceof CancelledError && error.command === "echoriad bash",
  );
  // The prompt carried the standard approval summary.
  assert.match(clack.messages[0] ?? "", /Build Gondolin guest image\?/);
  assert.match(clack.messages[0] ?? "", /Action: build the guest image/);
});
