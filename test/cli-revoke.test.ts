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
import type { CommandContext } from "../src/cli/index.ts";
import { loadProjectConfig } from "../src/config.ts";
import type { MultiselectInput } from "../src/cli/prompts.ts";
import { type RevokeDeps, resolveRevokeDeps, revokeCommand } from "../src/cli/revoke.ts";
import { CancelledError, CliError, createUi, type UiStream } from "../src/cli/ui.ts";

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

interface ProjectFixture {
  dir: string;
  authFile: string;
  consumer: string;
}

function makeProject(t: TestContext, files: Record<string, string> = {}): ProjectFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-revoke-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-revoke-cache-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  return {
    dir,
    authFile: path.join(cacheDir, "image-authorizations.json"),
    consumer: `root:${fs.realpathSync(dir)}`,
  };
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

function association(overrides: Partial<AuthorizationAssociation>): AuthorizationAssociation {
  return {
    consumer: "other-consumer",
    config: "repo:build-config.json",
    fingerprint: "f".repeat(64),
    buildId: "build-x",
    ...overrides,
  };
}

function seedAuthFile(fixture: ProjectFixture, associations: AuthorizationAssociation[]): void {
  saveAssociations(fixture.authFile, associations);
}

interface MultiselectCapture {
  calls: { command: string; message: string; labels: string[] }[];
  select: <Value extends object>(
    command: string,
    input: MultiselectInput<Value>,
  ) => Promise<Value[]>;
}

function capturingMultiselect(
  choose: (input: MultiselectInput<AuthorizationAssociation>) => AuthorizationAssociation[],
): MultiselectCapture {
  const calls: MultiselectCapture["calls"] = [];
  const select = async <Value extends object>(command: string, input: MultiselectInput<Value>) => {
    const typed = input as MultiselectInput<AuthorizationAssociation>;
    calls.push({
      command,
      message: typed.message,
      labels: typed.options.map((option) => option.label),
    });
    return choose(typed) as unknown as Value[];
  };
  return { calls, select };
}

function revokeDeps(
  fixture: ProjectFixture,
  ctxOverrides: Partial<CommandContext> = {},
  depsOverrides: Partial<RevokeDeps> = {},
): RevokeDeps {
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
    resolveImage: () => {
      throw new Error("resolveImage must not be reached");
    },
    ...ctxOverrides,
  };
  return resolveRevokeDeps(ctx, {
    authorizationFilePath: () => fixture.authFile,
    ...depsOverrides,
  });
}

test("revoke with no associations is a no-op success", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  const { ui, stdout } = makeUi(false);
  await revokeCommand(["--all", "--yes"], ui, revokeDeps(fixture));
  assert.equal(stdout.output(), "no build approvals to revoke\n");
});

test("revoke lists only the current consumer's associations and revokes the selection", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  const ownA = association({
    consumer: fixture.consumer,
    fingerprint: "a".repeat(64),
    buildId: "build-a",
  });
  const ownB = association({
    consumer: fixture.consumer,
    fingerprint: "b".repeat(64),
    buildId: "build-b",
  });
  const other = association({ consumer: "git:/elsewhere/.git" });
  seedAuthFile(fixture, [ownA, ownB, other]);

  const confirmations: string[] = [];
  const selection = capturingMultiselect((input) => [input.options[0]!.value]);
  const { ui, stdout } = makeUi(true);
  await revokeCommand(
    [],
    ui,
    revokeDeps(fixture, {
      multiselect: selection.select,
      confirm: async (_command, message) => {
        confirmations.push(message);
        return true;
      },
    }),
  );

  // Only the current consumer's associations are offered.
  assert.equal(selection.calls.length, 1);
  assert.equal(selection.calls[0]!.command, "revoke");
  assert.deepEqual(selection.calls[0]!.labels, [
    "repo:build-config.json (fingerprint aaaaaaaaaaaa)",
    "repo:build-config.json (fingerprint bbbbbbbbbbbb)",
  ]);
  assert.deepEqual(confirmations, ["Revoke 1 build approval?"]);

  // The selected association is gone; the unselected one and the other
  // consumer's association remain.
  assert.deepEqual(readAuthorizations(fixture.authFile), [ownB, other]);
  assert.equal(stdout.output(), `revoked aaaaaaaaaaaa (repo:build-config.json)\n`);
});

test("revoke --all --yes removes every association of the current consumer only", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  const ownA = association({
    consumer: fixture.consumer,
    fingerprint: "a".repeat(64),
    buildId: "build-a",
  });
  const ownB = association({
    consumer: fixture.consumer,
    config: "repo:other.json",
    fingerprint: "b".repeat(64),
    buildId: "build-b",
  });
  const other = association({ consumer: "git:/elsewhere/.git" });
  seedAuthFile(fixture, [ownA, ownB, other]);

  const { ui, stdout } = makeUi(false);
  await revokeCommand(["--all", "--yes"], ui, revokeDeps(fixture));
  // Revocation deletes associations only; other consumers' stay untouched.
  assert.deepEqual(readAuthorizations(fixture.authFile), [other]);
  assert.equal(
    stdout.output(),
    "revoked aaaaaaaaaaaa (repo:build-config.json)\n" + "revoked bbbbbbbbbbbb (repo:other.json)\n",
  );
});

test("a declined confirmation revokes nothing", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  const own = association({ consumer: fixture.consumer, fingerprint: "a".repeat(64) });
  seedAuthFile(fixture, [own]);
  const { ui } = makeUi(true);
  await assert.rejects(
    revokeCommand(["--all"], ui, revokeDeps(fixture, { confirm: async () => false })),
    /not revoked; no associations removed/,
  );
  assert.deepEqual(readAuthorizations(fixture.authFile), [own]);
});

test("cancelling the multiselect propagates the cancel convention", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  seedAuthFile(fixture, [association({ consumer: fixture.consumer })]);
  const { ui } = makeUi(true);
  await assert.rejects(
    revokeCommand(
      [],
      ui,
      revokeDeps(fixture, {
        multiselect: async () => {
          throw new CancelledError("revoke");
        },
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CancelledError);
      assert.equal(error.command, "revoke");
      return true;
    },
  );
  assert.equal(readAuthorizations(fixture.authFile).length, 1);
});

test("revoke without --all fails closed on a noninteractive terminal", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  seedAuthFile(fixture, [association({ consumer: fixture.consumer })]);
  const { ui } = makeUi(false);
  await assert.rejects(revokeCommand(["--yes"], ui, revokeDeps(fixture)), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /revoke needs an interactive terminal/);
    assert.match(error.message, /revoke --all --yes/);
    return true;
  });
  assert.equal(readAuthorizations(fixture.authFile).length, 1);
});

test("--all without --yes fails closed on a noninteractive terminal", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  seedAuthFile(fixture, [association({ consumer: fixture.consumer })]);
  const { ui } = makeUi(false);
  await assert.rejects(revokeCommand(["--all"], ui, revokeDeps(fixture)), (error: unknown) => {
    assert.ok(error instanceof CliError);
    assert.match(error.message, /revoke --yes/);
    return true;
  });
  assert.equal(readAuthorizations(fixture.authFile).length, 1);
});

test("an empty interactive selection revokes nothing", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  const own = association({ consumer: fixture.consumer });
  seedAuthFile(fixture, [own]);
  const selection = capturingMultiselect(() => []);
  const { ui, stdout } = makeUi(true);
  await revokeCommand([], ui, revokeDeps(fixture, { multiselect: selection.select }));
  assert.equal(stdout.output(), "no associations selected; nothing revoked\n");
  assert.deepEqual(readAuthorizations(fixture.authFile), [own]);
});

test("revoke warns about malformed metadata and reads it as empty", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  fs.writeFileSync(fixture.authFile, "{ not json");
  const { ui, stdout, stderr } = makeUi(false);
  await revokeCommand(["--all", "--yes"], ui, revokeDeps(fixture));
  assert.match(stderr.output(), /^warning: .*malformed/);
  assert.equal(stdout.output(), "no build approvals to revoke\n");
});

test("revoke derives the consumer from a system buildConfig selection", async (t) => {
  const fixture = makeProject(t, {});
  const systemConfig = path.join(fixture.dir, "system.json");
  fs.writeFileSync(systemConfig, "{}");
  const system = association({
    consumer: "system",
    config: `file:${fs.realpathSync(systemConfig)}`,
    fingerprint: "a".repeat(64),
  });
  const own = association({ consumer: fixture.consumer, fingerprint: "b".repeat(64) });
  seedAuthFile(fixture, [system, own]);
  const { ui } = makeUi(false);
  await revokeCommand(
    ["--all", "--yes"],
    ui,
    revokeDeps(
      fixture,
      {},
      {
        system: { buildConfig: systemConfig },
      },
    ),
  );
  // The system consumer's association is revoked; the project-root
  // consumer's is a different consumer and stays.
  assert.deepEqual(readAuthorizations(fixture.authFile), [own]);
});

test("revoke derives the consumer from the project root without a build config", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ image: "some:latest" }),
  });
  const own = association({ consumer: fixture.consumer, fingerprint: "a".repeat(64) });
  const other = association({ consumer: "git:/elsewhere/.git" });
  seedAuthFile(fixture, [own, other]);
  const { ui } = makeUi(false);
  await revokeCommand(["--all", "--yes"], ui, revokeDeps(fixture));
  assert.deepEqual(readAuthorizations(fixture.authFile), [other]);
});

test("revoke rejects unknown options and positional arguments", async (t) => {
  const fixture = makeProject(t, {
    ".echoriad.json": JSON.stringify({ buildConfig: "build-config.json" }),
    "build-config.json": "{}",
  });
  const { ui } = makeUi(false);
  await assert.rejects(
    revokeCommand(["--bogus"], ui, revokeDeps(fixture)),
    /unknown option "--bogus"/,
  );
  await assert.rejects(
    revokeCommand(["extra"], ui, revokeDeps(fixture)),
    /unexpected argument "extra"/,
  );
});
