import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { readAuthorizations } from "../src/authorization.ts";
import { type ApproveDeps, approveCommand, resolveApproveDeps } from "../src/cli/approve.ts";
import type { CommandContext } from "../src/cli/index.ts";
import { CancelledError, CliError, createUi, type UiStream } from "../src/cli/ui.ts";
import { loadProjectConfig } from "../src/config.ts";
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

const BUILD_CONFIG = JSON.stringify({
  arch: "aarch64",
  distro: "alpine",
  alpine: { version: "3.23.0" },
});

interface ProjectFixture {
  dir: string;
  authFile: string;
}

function makeProject(t: TestContext, files: Record<string, string>): ProjectFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-approve-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-approve-cache-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  return { dir, authFile: path.join(cacheDir, "image-authorizations.json") };
}

function makeUi(isInteractive: boolean): {
  ui: ReturnType<typeof createUi>;
  stdout: CapturedStream;
  stderr: CapturedStream;
} {
  const stdout = captureStream();
  const stderr = captureStream();
  return {
    ui: createUi({ stdout, stderr, plain: true, isInteractive }),
    stdout,
    stderr,
  };
}

interface ResolveImageFake {
  calls: string[];
  resolveImage: ApproveDeps["resolveImage"];
}

function fakeResolveImage(buildId: string | undefined): ResolveImageFake {
  const calls: string[] = [];
  const resolveImage = (imageRef: string) => {
    calls.push(imageRef);
    if (buildId === undefined) {
      throw new Error(`no image for ${imageRef}`);
    }
    return { buildId };
  };
  return { calls, resolveImage };
}

function approveDeps(
  fixture: ProjectFixture,
  ctxOverrides: Partial<CommandContext> = {},
  depsOverrides: Partial<ApproveDeps> = {},
): ApproveDeps {
  const ctx: CommandContext = {
    cwd: fixture.dir,
    env: {},
    system: {},
    loadProjectConfig: loadProjectConfig,
    confirm: async () => {
      throw new Error("confirm must not be reached");
    },
    multiselect: async () => {
      throw new Error("multiselect must not be reached");
    },
    resolveImage: fakeResolveImage(undefined).resolveImage,
    ...ctxOverrides,
  };
  return resolveApproveDeps(ctx, {
    authorizationFilePath: () => fixture.authFile,
    ...depsOverrides,
  });
}

test("approve rejects a project that selects an existing image", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ image: "some:latest" }),
  });
  const image = fakeResolveImage("build-abc");
  const { ui } = makeUi(false);
  await assert.rejects(
    approveCommand(["--yes"], ui, approveDeps(fixture, {}, { resolveImage: image.resolveImage })),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(
        error.message,
        /approve applies to build-config selections only; this project selects an existing guest image \("some:latest"\)/,
      );
      return true;
    },
  );
  // The image store is never consulted for a non-build selection.
  assert.equal(image.calls.length, 0);
});

test("approve rejects a project with no image source selected", async (t) => {
  const fixture = makeProject(t, {});
  const { ui } = makeUi(false);
  await assert.rejects(
    approveCommand(["--yes"], ui, approveDeps(fixture)),
    /approve applies to build-config selections only; no image source is selected/,
  );
});

test("approve fails closed when no cached image exists for the fingerprint", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": BUILD_CONFIG,
  });
  const image = fakeResolveImage(undefined);
  const { ui } = makeUi(false);
  await assert.rejects(
    approveCommand(["--yes"], ui, approveDeps(fixture, {}, { resolveImage: image.resolveImage })),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /no guest image exists for fingerprint [0-9a-f]{12}/);
      assert.match(error.message, /"echoriad build"/);
      return true;
    },
  );
  assert.equal(image.calls.length, 1);
  assert.deepEqual(readAuthorizations(fixture.authFile), []);
});

test("approve --yes prints the summary and records the association", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": BUILD_CONFIG,
  });
  const image = fakeResolveImage("build-abc");
  const { ui, stdout } = makeUi(false);
  await approveCommand(
    ["--yes"],
    ui,
    approveDeps(fixture, {}, { resolveImage: image.resolveImage }),
  );

  const out = stdout.output();
  assert.match(out, /Action: reuse the globally cached image built from this build config/);
  assert.match(out, new RegExp(`Consumer: project \\(${fs.realpathSync(fixture.dir)}\\)`));
  assert.match(out, new RegExp(`Project root: ${fs.realpathSync(fixture.dir)}`));
  assert.match(out, /Build config: .*build-config\.json/);
  assert.match(out, /Building uses host network access/);
  assert.match(out, /approved [0-9a-f]{12} \(build build-abc\)/);

  // The recorded association carries the identity, the fingerprint that was
  // resolved in the image store, and the build ID the fingerprint mapped to.
  const associations = readAuthorizations(fixture.authFile);
  assert.equal(associations.length, 1);
  const imageRef = image.calls[0] ?? "";
  assert.match(imageRef, /^echoriad-build-[0-9a-f]{64}:latest$/);
  const association = associations[0]!;
  assert.equal(association.consumer, `root:${fs.realpathSync(fixture.dir)}`);
  assert.equal(association.config, "repo:build-config.json");
  assert.equal(
    association.fingerprint,
    imageRef.slice("echoriad-build-".length, -":latest".length),
  );
  assert.equal(association.buildId, "build-abc");
});

test("approve prompts interactively and records the association on yes", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": BUILD_CONFIG,
  });
  const confirmations: string[] = [];
  const { ui } = makeUi(true);
  await approveCommand(
    [],
    ui,
    approveDeps(
      fixture,
      {
        confirm: async (_command, message) => {
          confirmations.push(message);
          return true;
        },
      },
      { resolveImage: fakeResolveImage("build-abc").resolveImage },
    ),
  );
  assert.deepEqual(confirmations, ["Reuse cached Gondolin guest image?"]);
  assert.equal(readAuthorizations(fixture.authFile).length, 1);
});

test("a declined prompt records nothing and fails through the error convention", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": BUILD_CONFIG,
  });
  const { ui } = makeUi(true);
  await assert.rejects(
    approveCommand(
      [],
      ui,
      approveDeps(
        fixture,
        { confirm: async () => false },
        { resolveImage: fakeResolveImage("build-abc").resolveImage },
      ),
    ),
    /not approved; no build approval recorded/,
  );
  assert.deepEqual(readAuthorizations(fixture.authFile), []);
});

test("cancelling the prompt propagates the cancel convention", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": BUILD_CONFIG,
  });
  const { ui } = makeUi(true);
  await assert.rejects(
    approveCommand(
      [],
      ui,
      approveDeps(
        fixture,
        {
          confirm: async () => {
            throw new CancelledError("approve");
          },
        },
        { resolveImage: fakeResolveImage("build-abc").resolveImage },
      ),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CancelledError);
      assert.equal(error.command, "approve");
      return true;
    },
  );
});

test("approve without --yes fails closed on a noninteractive terminal", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": BUILD_CONFIG,
  });
  const { ui } = makeUi(false);
  await assert.rejects(
    approveCommand(
      [],
      ui,
      approveDeps(fixture, {}, { resolveImage: fakeResolveImage("build-abc").resolveImage }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /approve needs an interactive terminal/);
      assert.match(error.message, /approve --yes/);
      return true;
    },
  );
  assert.deepEqual(readAuthorizations(fixture.authFile), []);
});

test("approve surfaces a missing build config as an actionable error", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "missing.json" }),
  });
  const { ui } = makeUi(false);
  await assert.rejects(approveCommand(["--yes"], ui, approveDeps(fixture)), (error: unknown) => {
    assert.ok(error instanceof GuestImageError);
    assert.match(error.message, /does not exist; check the "buildConfig" path/);
    return true;
  });
});

test("approve wraps fingerprint failures as guest-image errors", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": JSON.stringify({
      arch: "aarch64",
      distro: "alpine",
      alpine: { version: "3.23.0" },
      init: { rootfsInit: "missing-init.sh" },
    }),
  });
  const { ui } = makeUi(false);
  await assert.rejects(approveCommand(["--yes"], ui, approveDeps(fixture)), (error: unknown) => {
    assert.ok(error instanceof GuestImageError);
    assert.match(error.message, /local input "missing-init\.sh" does not exist/);
    return true;
  });
});

test("approve rejects unknown options and positional arguments", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": BUILD_CONFIG,
  });
  const { ui } = makeUi(false);
  await assert.rejects(
    approveCommand(["--bogus"], ui, approveDeps(fixture)),
    /unknown option "--bogus"/,
  );
  await assert.rejects(
    approveCommand(["extra"], ui, approveDeps(fixture)),
    /unexpected argument "extra"/,
  );
});

test("approve --yes warns about malformed metadata and still records", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": BUILD_CONFIG,
  });
  fs.writeFileSync(fixture.authFile, "{ not json");
  const { ui, stderr } = makeUi(false);
  await approveCommand(
    ["--yes"],
    ui,
    approveDeps(fixture, {}, { resolveImage: fakeResolveImage("build-abc").resolveImage }),
  );
  assert.match(stderr.output(), /^warning: .*malformed/);
  const associations = readAuthorizations(fixture.authFile);
  assert.equal(associations.length, 1);
  assert.equal(associations[0]!.buildId, "build-abc");
});
