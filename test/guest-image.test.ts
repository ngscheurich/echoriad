import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildApprovalSummary,
  buildCommandArgs,
  imageRefForFingerprint,
  mayUsePrivilegedContainer,
  prepareGuestImage,
  resolveGondolinCli,
  tailOfOutput,
  GuestImageError,
} from "../src/guest-image.ts";
import type { AuthorizationAssociation } from "../src/authorization.ts";
import type { BuildConfig } from "@earendil-works/gondolin";
import { parseBuildConfig } from "@earendil-works/gondolin";

function realParseConfig(raw: string, configPath: string): BuildConfig {
  try {
    return parseBuildConfig(raw);
  } catch (error) {
    throw new GuestImageError(
      `Echoriad: build config ${configPath} was rejected by Gondolin: ${(error as Error).message}`,
      { permanent: true },
    );
  }
}

function baseConfig(): BuildConfig {
  return {
    arch: "aarch64",
    distro: "alpine",
    alpine: { version: "3.23.0" },
  };
}

function writeBuildConfig(dir: string, config: BuildConfig): string {
  const configPath = path.join(dir, "build-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function resolveCliPath(): string {
  const pkg = path.dirname(
    fs.realpathSync(
      new URL(
        "../node_modules/@earendil-works/gondolin/package.json",
        import.meta.url,
      ).pathname,
    ),
  );
  return path.join(pkg, "dist", "bin", "gondolin.js");
}

test("resolveGondolinCli resolves the CLI from the package dependency", () => {
  const cli = resolveGondolinCli();
  assert.equal(cli.cliPath, resolveCliPath());
  assert.equal(cli.version, "0.12.0");
  assert.ok(fs.existsSync(cli.cliPath));
});

test("buildCommandArgs uses --config, --output, and --tag", () => {
  const args = buildCommandArgs({
    cliPath: "/pkg/gondolin.js",
    configPath: "/proj/build-config.json",
    outputDir: "/tmp/out",
    imageRef: "echoriad-build-abc:latest",
  });
  assert.deepEqual(args, [
    "/pkg/gondolin.js",
    "build",
    "--config",
    "/proj/build-config.json",
    "--output",
    "/tmp/out",
    "--tag",
    "echoriad-build-abc:latest",
  ]);
});

test("image reference is internal and fingerprint-derived", () => {
  const ref = imageRefForFingerprint("a".repeat(64));
  assert.equal(ref, `echoriad-build-${"a".repeat(64)}:latest`);
  // Distinct fingerprints map to distinct references.
  assert.notEqual(ref, imageRefForFingerprint("b".repeat(64)));
});

test("approval summary shows consumer, project root, build config, and warnings", () => {
  const config: BuildConfig = {
    ...baseConfig(),
    postBuild: { commands: ["apk add curl"] },
    oci: { image: "example.com/base:1.2" },
  };
  const summary = buildApprovalSummary({
    action: "build",
    consumer: "project (/proj)",
    projectRoot: "/proj",
    configPath: "/proj/build-config.json",
    localInputPaths: ["/proj/init.sh", "/etc/external/secret-helper"],
    config,
  });
  assert.match(summary, /Action: build the guest image/);
  assert.match(summary, /Consumer: project \(\/proj\)/);
  assert.match(summary, /Project root: \/proj/);
  assert.match(summary, /Build config: \/proj\/build-config\.json/);
  assert.match(summary, /- \/proj\/init\.sh\n/);
  assert.match(summary, /- \/etc\/external\/secret-helper \(outside project\)/);
  // Commands are shown verbatim as plain lines.
  assert.match(summary, /postBuild\.commands \(verbatim\):\n  apk add curl\n/);
  assert.match(summary, /inherited host environment variables/);
  assert.match(summary, /OCI image: example\.com\/base:1\.2/);
  // The access warnings form one plain paragraph after a blank line.
  assert.match(
    summary,
    /\n\nBuilding uses host network access[^\n]*\.\s/,
  );
  assert.match(summary, /inherits the host environment/);
  assert.match(summary, /may contain host data/);
  // The dialog renders plain text; no markdown markers may appear.
  assert.doesNotMatch(summary, /\*\*|```/);
});

test("approval summary lists init scripts and sandbox helpers", () => {
  const config: BuildConfig = {
    ...baseConfig(),
    init: { rootfsInit: "init.sh" },
    sandboxdPath: "sandboxd",
  };
  const summary = buildApprovalSummary({
    action: "reuse",
    consumer: "system",
    projectRoot: "/proj",
    configPath: "/proj/build-config.json",
    localInputPaths: [],
    config,
  });
  assert.match(summary, /Action: reuse the globally cached image/);
  assert.match(summary, /Init scripts: init\.sh/);
  assert.match(summary, /Sandbox helpers: sandboxd/);
  assert.match(summary, /Local inputs: none/);
});

test("build-failure errors carry a bounded tail of Gondolin output", () => {
  const output = Array.from(
    { length: 30 },
    (_, i) => `step ${i + 1}`,
  ).join("\n");
  const tail = tailOfOutput(output, 12);
  const tailLines = tail.split("\n");
  assert.equal(tailLines.length, 12);
  assert.equal(tailLines[0], "step 19");
  assert.equal(tailLines[11], "step 30");
  // Trailing blank lines are dropped; long output is capped by characters.
  assert.equal(tailOfOutput("a\n\nb\n\n\n", 12), "a\n\nb");
  const long = "x".repeat(5000);
  assert.equal(tailOfOutput(long, 12, 4000).length, 4000);
});

test("privileged container warning appears only for container builds with postBuild commands", () => {
  const hostArch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  const plain: BuildConfig = { ...baseConfig() };
  assert.equal(mayUsePrivilegedContainer(plain), false);

  const withCommands: BuildConfig = {
    ...baseConfig(),
    postBuild: { commands: ["true"] },
  };
  // Mirror Gondolin's shouldUseContainer: forced, non-Linux, or arch-mismatched
  // macOS builds run in a container; container builds with postBuild commands
  // run privileged.
  const expected =
    process.platform !== "linux" ||
    (hostArch !== undefined && hostArch !== withCommands.arch);
  assert.equal(mayUsePrivilegedContainer(withCommands), expected);

  // Forcing the container always implies a privileged build with commands.
  const forced: BuildConfig = {
    ...withCommands,
    container: { force: true },
  };
  assert.equal(mayUsePrivilegedContainer(forced), true);

  const ociWithCommands: BuildConfig = {
    ...withCommands,
    oci: { image: "base:1" },
  };
  // OCI rootfs builds run natively even with commands.
  assert.equal(mayUsePrivilegedContainer(ociWithCommands), false);
});

function testDeps(overrides: {
  config?: BuildConfig;
  approveResult?: boolean;
  approveCalls?: { action: string; summary: string }[];
  builtCommands?: { configPath: string; outputDir: string; imageRef: string }[];
  existingRefs?: Set<string>;
  failBuild?: boolean;
  authorizations?: AuthorizationAssociation[];
}) {
  const config = overrides.config ?? baseConfig();
  const outputDirs: string[] = [];
  const authorizations = overrides.authorizations ?? [];
  const written: AuthorizationAssociation[] = [];
  return {
    deps: {
      readConfig: () => JSON.stringify(config),
      parseConfig: (raw: string) => JSON.parse(raw) as BuildConfig,
      fingerprint: () => ({
        fingerprint: "f".repeat(64),
        abbreviated: "f".repeat(12),
        localInputPaths: ["/proj/init.sh"],
      }),
      resolveImage: (selector: string) => {
        if (overrides.existingRefs?.has(selector)) {
          return { buildId: "existing-build-id" };
        }
        throw new Error(`no image for ${selector}`);
      },
      build: async (command: {
        configPath: string;
        outputDir: string;
        imageRef: string;
      }) => {
        overrides.builtCommands?.push(command);
        if (overrides.failBuild) {
          throw new GuestImageError("Echoriad: guest image build failed (Gondolin exited with code 1)");
        }
        overrides.existingRefs?.add(command.imageRef);
      },
      makeOutputDir: () => {
        const dir = fs.mkdtempSync(path.join("/tmp", "echoriad-test-out-"));
        outputDirs.push(dir);
        return dir;
      },
      removeOutputDir: (dir: string) => fs.rmSync(dir, { recursive: true, force: true }),
      readAuthorizations: () => authorizations,
      writeAuthorization: (association: AuthorizationAssociation) => {
        authorizations.push(association);
        written.push(association);
      },
    },
    outputDirs,
    authorizations,
    written,
  };
}

const CONSUMER_ID = "git:/proj/.git";
const CONFIG_ID = "repo:build-config.json";

const FINGERPRINT = "f".repeat(64);

function matchingAssociation(
  overrides: Partial<AuthorizationAssociation> = {},
): AuthorizationAssociation {
  return {
    consumer: CONSUMER_ID,
    config: CONFIG_ID,
    fingerprint: FINGERPRINT,
    buildId: "existing-build-id",
    ...overrides,
  };
}

test("approval denial stops startup before building or selecting", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const builtCommands: unknown[] = [];
  const approvals: { action: string; summary: string }[] = [];
  const { deps, written } = testDeps({ builtCommands, existingRefs: new Set() });
  await assert.rejects(
    prepareGuestImage({
      configPath,
      projectRoot: "/proj",
      consumer: "project (/proj)",
      consumerId: CONSUMER_ID,
      configId: CONFIG_ID,
      interactive: true,
      approve: async (action, summary) => {
        approvals.push({ action, summary });
        return false;
      },
      deps,
    }),
    /not approved/,
  );
  assert.equal(builtCommands.length, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.action, "build");
  // No authorization is recorded for a denied build.
  assert.equal(written.length, 0);
});

test("noninteractive sessions fail closed before building", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const builtCommands: unknown[] = [];
  const { deps } = testDeps({ builtCommands, existingRefs: new Set() });
  let approveCalled = false;
  await assert.rejects(
    prepareGuestImage({
      configPath,
      projectRoot: "/proj",
      consumer: "project (/proj)",
      consumerId: CONSUMER_ID,
      configId: CONFIG_ID,
      interactive: false,
      approve: async () => {
        approveCalled = true;
        return true;
      },
      deps,
    }),
    (error: GuestImageError) =>
      /noninteractive/.test(error.message) &&
      /Open the project interactively/.test(error.message) &&
      error.permanent,
  );
  assert.equal(approveCalled, false);
  assert.equal(builtCommands.length, 0);
});

test("successful build starts the VM from the imported image build id and records authorization", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const builtCommands: {
    configPath: string;
    outputDir: string;
    imageRef: string;
  }[] = [];
  const refs = new Set<string>();
  const { deps, written } = testDeps({ builtCommands, existingRefs: refs });
  const result = await prepareGuestImage({
    configPath,
    projectRoot: "/proj",
    consumer: "project (/proj)",
    consumerId: CONSUMER_ID,
    configId: CONFIG_ID,
    interactive: true,
    approve: async () => true,
    deps,
  });
  assert.equal(result.built, true);
  // the image selector is the build id resolved from Gondolin after import
  assert.equal(result.imageSelector, "existing-build-id");
  assert.equal(result.imageRef, imageRefForFingerprint("f".repeat(64)));
  assert.equal(builtCommands.length, 1);
  assert.equal(builtCommands[0]!.configPath, configPath);
  assert.equal(builtCommands[0]!.imageRef, result.imageRef);
  // unique temporary output directory, removed afterwards
  assert.ok(builtCommands[0]!.outputDir.startsWith("/tmp/echoriad-test-out-"));
  assert.equal(fs.existsSync(builtCommands[0]!.outputDir), false);
  // the successful build is recorded as an authorization association
  assert.deepEqual(written, [matchingAssociation()]);
  void refs;
});

test("a new consumer reusing a globally cached image needs approval first", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const builtCommands: unknown[] = [];
  const refs = new Set<string>([imageRefForFingerprint(FINGERPRINT)]);
  const approvals: { action: string; summary: string }[] = [];
  const { deps, written } = testDeps({ builtCommands, existingRefs: refs });
  const result = await prepareGuestImage({
    configPath,
    projectRoot: "/proj",
    consumer: "project (/proj)",
    consumerId: CONSUMER_ID,
    configId: CONFIG_ID,
    interactive: true,
    approve: async (action, summary) => {
      approvals.push({ action, summary });
      return true;
    },
    deps,
  });
  // No build runs: the globally cached image behind the fingerprint
  // reference is reused after approval.
  assert.equal(builtCommands.length, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.action, "reuse");
  assert.match(approvals[0]!.summary, /Action: reuse the globally cached image/);
  assert.equal(result.built, false);
  assert.equal(result.imageSelector, "existing-build-id");
  // Approval applies to this consumer and records the association.
  assert.deepEqual(written, [matchingAssociation()]);
});

test("denial of a cached-image reuse stops startup without building", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const builtCommands: unknown[] = [];
  const refs = new Set<string>([imageRefForFingerprint(FINGERPRINT)]);
  const { deps, written } = testDeps({ builtCommands, existingRefs: refs });
  await assert.rejects(
    prepareGuestImage({
      configPath,
      projectRoot: "/proj",
      consumer: "project (/proj)",
      consumerId: CONSUMER_ID,
      configId: CONFIG_ID,
      interactive: true,
      approve: async () => false,
      deps,
    }),
    /not approved/,
  );
  assert.equal(builtCommands.length, 0);
  assert.equal(written.length, 0);
});

test("an authorized association reuses a valid image silently", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const builtCommands: unknown[] = [];
  const refs = new Set<string>([imageRefForFingerprint(FINGERPRINT)]);
  const approvals: { action: string; summary: string }[] = [];
  const { deps, written } = testDeps({
    builtCommands,
    existingRefs: refs,
    authorizations: [matchingAssociation()],
  });
  const statuses: string[] = [];
  const result = await prepareGuestImage({
    configPath,
    projectRoot: "/proj",
    consumer: "project (/proj)",
    consumerId: CONSUMER_ID,
    configId: CONFIG_ID,
    interactive: true,
    approve: async (action, summary) => {
      approvals.push({ action, summary });
      return true;
    },
    onStatus: (message) => statuses.push(message),
    deps,
  });
  // A matching authorized association with a valid image object needs no
  // approval at all.
  assert.equal(approvals.length, 0);
  assert.equal(builtCommands.length, 0);
  assert.equal(result.built, false);
  assert.equal(result.imageSelector, "existing-build-id");
  assert.match(statuses.join("\n"), /reusing authorized guest image/);
  assert.equal(written.length, 0);
});

test("a noninteractive session reuses an authorized image without prompting", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const builtCommands: unknown[] = []
  const refs = new Set<string>([imageRefForFingerprint(FINGERPRINT)]);
  const { deps } = testDeps({
    builtCommands,
    existingRefs: refs,
    authorizations: [matchingAssociation()],
  });
  let approveCalled = false;
  const result = await prepareGuestImage({
    configPath,
    projectRoot: "/proj",
    consumer: "project (/proj)",
    consumerId: CONSUMER_ID,
    configId: CONFIG_ID,
    interactive: false,
    approve: async () => {
      approveCalled = true;
      return true;
    },
    deps,
  });
  assert.equal(approveCalled, false);
  assert.equal(result.built, false);
  assert.equal(result.imageSelector, "existing-build-id");
});

test("a missing Gondolin object prompts and rebuilds despite an authorized association", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const builtCommands: { imageRef: string }[] = [];
  // The association exists, but the image object behind the fingerprint
  // reference is gone (no existing refs).
  const refs = new Set<string>();
  const approvals: { action: string; summary: string }[] = [];
  const { deps, written } = testDeps({
    builtCommands,
    existingRefs: refs,
    authorizations: [matchingAssociation()],
  });
  const result = await prepareGuestImage({
    configPath,
    projectRoot: "/proj",
    consumer: "project (/proj)",
    consumerId: CONSUMER_ID,
    configId: CONFIG_ID,
    interactive: true,
    approve: async (action, summary) => {
      approvals.push({ action, summary });
      return true;
    },
    deps,
  });
  // The unusable cache entry prompts again and the image is rebuilt; an
  // older fingerprint is never used as a fallback.
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.action, "build");
  assert.equal(builtCommands.length, 1);
  assert.equal(builtCommands[0]!.imageRef, imageRefForFingerprint(FINGERPRINT));
  assert.equal(result.built, true);
  assert.equal(result.imageSelector, "existing-build-id");
  assert.deepEqual(written, [matchingAssociation()]);
});

test("cache deletion (empty authorization state) prompts again before reuse", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const builtCommands: unknown[] = [];
  // The image still exists globally, but the authorization metadata is
  // gone (deleted cache reads as empty).
  const refs = new Set<string>([imageRefForFingerprint(FINGERPRINT)]);
  const approvals: { action: string }[] = [];
  const { deps } = testDeps({ builtCommands, existingRefs: refs, authorizations: [] });
  const result = await prepareGuestImage({
    configPath,
    projectRoot: "/proj",
    consumer: "project (/proj)",
    consumerId: CONSUMER_ID,
    configId: CONFIG_ID,
    interactive: true,
    approve: async (action) => {
      approvals.push({ action });
      return true;
    },
    deps,
  });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.action, "reuse");
  assert.equal(result.built, false);
});

test("build failure stops startup, notifies the output tail, and removes the temporary output directory", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const { deps, outputDirs } = testDeps({ failBuild: true, existingRefs: new Set() });
  const failureTails: string[] = [];
  let error: GuestImageError | undefined;
  try {
    await prepareGuestImage({
      configPath,
      projectRoot: "/proj",
      consumer: "project (/proj)",
      consumerId: CONSUMER_ID,
      configId: CONFIG_ID,
      interactive: true,
      approve: async () => true,
      onBuildFailure: (tail) => failureTails.push(tail),
      deps,
    });
    assert.fail("expected prepareGuestImage to reject");
  } catch (caught) {
    error = caught as GuestImageError;
  }
  // The thrown error stays one line so the extension-error log does not
  // duplicate the tail; the tail goes to the failure callback instead.
  assert.equal(
    error.message,
    "Echoriad: guest image build failed (Gondolin exited with code 1)",
  );
  assert.equal(failureTails.length, 0); // stub build throws without a tail
  assert.equal(outputDirs.length, 1);
  assert.equal(fs.existsSync(outputDirs[0]!), false);
});

test("the real build path routes the output tail to onBuildFailure", async () => {
  // Drive runGondolinBuild through deps.build with a command that exits 1.
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = writeBuildConfig(dir, baseConfig());
  const { deps } = testDeps({ existingRefs: new Set() });
  const failureTails: string[] = [];
  await assert.rejects(
    prepareGuestImage({
      configPath,
      projectRoot: dir,
      consumer: "project",
      consumerId: CONSUMER_ID,
      configId: CONFIG_ID,
      interactive: true,
      approve: async () => true,
      onBuildFailure: (tail) => failureTails.push(tail),
      deps: {
        ...deps,
        build: (command, _onOutput, onBuildFailure) =>
          defaultRunBuildForTest(command, onBuildFailure),
      },
    }),
    /Gondolin exited with code 3/,
  );
  assert.equal(failureTails.length, 1);
  assert.match(failureTails[0]!, /missing required tool/);
});

async function defaultRunBuildForTest(
  command: { cliPath: string },
  onBuildFailure?: (tail: string) => void,
): Promise<void> {
  // Replaces the gondolin CLI with a tiny script that writes output and
  // exits 3, exercising the real spawn/tail path.
  const script = path.join(os.tmpdir(), `echoriad-fake-cli-${process.pid}.mjs`);
  fs.writeFileSync(
    script,
    `console.log("step 1");
process.stderr.write("missing required tool\\n");
process.exit(3);`,
  );
  const { runGondolinBuild } = await import("../src/guest-image.ts");
  try {
    await runGondolinBuild(
      { ...command, cliPath: script },
      undefined,
      onBuildFailure,
    );
  } finally {
    fs.rmSync(script, { force: true });
  }
}

test("missing and non-file build configs fail with actionable errors", async () => {
  const missing = path.join("/tmp", "echoriad-gi-missing-config.json");
  const { deps } = testDeps({ existingRefs: new Set() });
  await assert.rejects(
    prepareGuestImage({
      configPath: missing,
      projectRoot: "/proj",
      consumer: "project (/proj)",
      consumerId: CONSUMER_ID,
      configId: CONFIG_ID,
      interactive: true,
      approve: async () => true,
      deps,
    }),
    (error: GuestImageError) =>
      error.message.includes(missing) && error.message.includes("does not exist"),
  );

  const dir = fs.mkdtempSync(path.join("/tmp", "echoriad-gi-"));
  await assert.rejects(
    prepareGuestImage({
      configPath: dir,
      projectRoot: dir,
      consumer: "project",
      consumerId: CONSUMER_ID,
      configId: CONFIG_ID,
      interactive: true,
      approve: async () => true,
      deps,
    }),
    /is not a regular file/,
  );
});

test("build configs rejected by Gondolin fail with an actionable error", async () => {
  const { dir } = { dir: fs.mkdtempSync(path.join("/tmp", "echoriad-gi-")) };
  const configPath = path.join(dir, "build-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ arch: "sparc", distro: "alpine" }));
  const { deps } = testDeps({ existingRefs: new Set() });
  await assert.rejects(
    prepareGuestImage({
      configPath,
      projectRoot: dir,
      consumer: "project",
      consumerId: CONSUMER_ID,
      configId: CONFIG_ID,
      interactive: true,
      approve: async () => true,
      deps: {
        ...deps,
        readConfig: () => fs.readFileSync(configPath, "utf8"),
        parseConfig: realParseConfig,
      },
    }),
    (error: GuestImageError) =>
      /rejected by Gondolin/.test(error.message) && error.permanent,
  );
});

test("prepareGuestImage parses and fingerprints the real config end to end", async () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "echoriad-gi-e2e-"));
  fs.writeFileSync(path.join(dir, "init.sh"), "echo hi\n");
  const config: BuildConfig = {
    ...baseConfig(),
    init: { rootfsInit: "init.sh" },
  };
  const configPath = writeBuildConfig(dir, config);
  const refs = new Set<string>();
  const { deps } = testDeps({ existingRefs: refs });
  const result = await prepareGuestImage({
    configPath,
    projectRoot: dir,
    consumer: "project",
    consumerId: CONSUMER_ID,
    configId: CONFIG_ID,
    interactive: true,
    approve: async () => true,
    deps: {
      ...deps,
      // keep the real fingerprinting; only stub build/resolve
      build: async (command) => {
        refs.add(command.imageRef);
      },
    },
  });
  assert.equal(result.built, true);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(result.imageRef.startsWith("echoriad-build-"));
});

test("build statuses include the fingerprint and completion; cancellation never authorizes an import", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-lifecycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = writeBuildConfig(dir, baseConfig());
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const refs = new Set<string>();
    const { deps, written, outputDirs } = testDeps({ existingRefs: refs });
    const statuses: string[] = [];
    const promise = prepareGuestImage({
      configPath, projectRoot: dir, consumer: "project",
      consumerId: CONSUMER_ID, configId: CONFIG_ID, interactive: true,
      approve: async () => true, signal: controller.signal,
      onStatus: (s) => statuses.push(s),
      deps: { ...deps, build: async (command) => {
        await deps.build(command);
        if (cancel) controller.abort();
      } },
    });
    if (cancel) {
      await assert.rejects(promise, /cancelled/);
      assert.deepEqual(written, []);
      assert.match(statuses.at(-1)!, /cancelled/);
      assert.equal(refs.size, 1); // An imported object may remain, without authorization.
    } else {
      await promise;
      assert.deepEqual(statuses, [
        "building guest image ffffffffffff",
        "guest image build complete ffffffffffff",
      ]);
      assert.equal(written.length, 1);
    }
    assert.ok(outputDirs.every((out) => !fs.existsSync(out)));
  }
});

test("concurrent builds stay independent: duplicate builds are accepted, each with a unique output directory", async (t) => {
  // The first release does not lock builds by fingerprint: two concurrent
  // sessions may both build the same fingerprint. Each gets its own
  // temporary output directory and its own authorization record. A local
  // input changed between fingerprinting and Gondolin reading it is the
  // accepted time-of-check/time-of-use race; builds run against the
  // original approved paths.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-concurrent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = writeBuildConfig(dir, baseConfig());
  const usedOutputDirs: string[] = [];
  let sequence = 0;
  const builds = [1, 2].map(() => {
    const refs = new Set<string>();
    const { deps, written } = testDeps({ existingRefs: refs });
    return prepareGuestImage({
      configPath, projectRoot: dir, consumer: "project",
      consumerId: CONSUMER_ID, configId: CONFIG_ID, interactive: true,
      approve: async () => true,
      deps: {
        ...deps,
        makeOutputDir: () => `/tmp/echoriad-unique-${++sequence}`,
        build: async (command) => {
          usedOutputDirs.push(command.outputDir);
          await deps.build(command);
        },
      },
    });
  });
  const results = await Promise.all(builds);
  assert.ok(results.every((result) => result.built));
  // Every build gets a unique temporary output directory even when the
  // fingerprint (and therefore the image reference) is identical.
  assert.equal(new Set(usedOutputDirs).size, 2);
  assert.equal(new Set(results.map((r) => r.imageRef)).size, 1);
});
