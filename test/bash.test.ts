import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ExecProcess, ExecResult, VM, VMOptions } from "@earendil-works/gondolin";
import { attachTty, type BashDeps, runBash } from "../src/cli/bash.ts";
import type { Ui, UiStream } from "../src/cli/ui.ts";
import { createUi } from "../src/cli/ui.ts";
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

function makeUi(interactive: boolean): { ui: Ui; stdout: CapturedStream; stderr: CapturedStream } {
  const stdout = captureStream();
  const stderr = captureStream();
  const ui = createUi({ stdout, stderr, plain: false, isInteractive: interactive });
  return { ui, stdout, stderr };
}

/** A stdin stand-in with a recorded setRawMode, TTY-shaped. */
class FakeTtyInput extends PassThrough {
  isTTY = true;
  rawMode: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.rawMode.push(mode);
    return this;
  }
}

/** A stdout stand-in: TTY-shaped, resize-emitting, pipeable. */
class FakeTtyOutput extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 24;
  received: string[] = [];
  constructor() {
    super();
    this.on("data", (chunk: Buffer) => this.received.push(chunk.toString()));
  }
}

interface FakeProc {
  written: Buffer[];
  ended: boolean;
  resized: { rows: number; cols: number }[];
  stdout: PassThrough;
  stderr: PassThrough;
  proc: ExecProcess;
  resolveResult: (exitCode: number, signal?: number) => void;
}

function fakeProc(): FakeProc {
  const written: Buffer[] = [];
  const resized: { rows: number; cols: number }[] = [];
  let ended = false;
  let resolveResult: FakeProc["resolveResult"] = () => {};
  const result = new Promise<ExecResult>((resolve) => {
    resolveResult = (exitCode, signal) => resolve({ exitCode, signal } as ExecResult);
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = {
    write: (chunk: string | Buffer) => {
      written.push(Buffer.from(chunk));
    },
    end: () => {
      ended = true;
    },
    resize: (rows: number, cols: number) => {
      resized.push({ rows, cols });
    },
    result,
    stdout,
    stderr,
  } as unknown as ExecProcess;
  // Getters, not snapshots: the recorders live in closures this object
  // does not share, so property reads must observe the latest state.
  return {
    get written() {
      return written;
    },
    get ended() {
      return ended;
    },
    get resized() {
      return resized;
    },
    stdout,
    stderr,
    proc,
    resolveResult,
  };
}

interface FakeVm {
  shellOptions: unknown[];
  closed: number;
  vm: VM;
  started: Promise<void>;
}

function fakeVm(proc: ExecProcess): FakeVm {
  const shellOptions: unknown[] = [];
  let closed = 0;
  let signalStart: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  const vm = {
    shell: (options: unknown) => {
      shellOptions.push(options);
      signalStart();
      return proc;
    },
    close: async () => {
      closed++;
    },
  } as unknown as VM;
  return {
    get shellOptions() {
      return shellOptions;
    },
    get closed() {
      return closed;
    },
    vm,
    started,
  };
}

/** Default bash deps over the fakes, plus the shell-started signal. */
function bashDeps(vm: FakeVm, stdin: FakeTtyInput): { deps: BashDeps; started: Promise<void> } {
  return {
    deps: {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: new FakeTtyOutput() as unknown as NodeJS.WriteStream,
      stderr: new FakeTtyOutput() as unknown as NodeJS.WriteStream,
      createVm: async () => vm.vm,
    },
    started: vm.started,
  };
}

/** A temp project directory with env isolation; cwd moves in for the test. */
function scratchProject(config?: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-bash-"));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, ".echoriad.json"), JSON.stringify(config));
  }
  const previous = {
    cwd: process.cwd(),
    cache: process.env.XDG_CACHE_HOME,
    config: process.env.XDG_CONFIG_HOME,
    image: process.env.ECHORIAD_IMAGE,
  };
  delete process.env.ECHORIAD_IMAGE;
  process.chdir(dir);
  return {
    dir,
    restore() {
      process.chdir(previous.cwd);
      for (const [key, value] of Object.entries({
        XDG_CACHE_HOME: previous.cache,
        XDG_CONFIG_HOME: previous.config,
        ECHORIAD_IMAGE: previous.image,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// attachTty
// ---------------------------------------------------------------------------

test("attachTty forwards stdin data and guest output both ways", async () => {
  const fake = fakeProc();
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const stderr = new FakeTtyOutput();
  const attach = attachTty(
    fake.proc,
    stdin as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream,
    stderr as unknown as NodeJS.WriteStream,
  );

  stdin.write("ls -la\n");
  fake.stdout.write("guest says\n");
  fake.stderr.write("guest warns\n");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(Buffer.concat(fake.written).toString(), "ls -la\n");
  assert.equal(stdout.received.join(""), "guest says\n");
  assert.equal(stderr.received.join(""), "guest warns\n");
  assert.deepEqual(stdin.rawMode, [true]);
  attach.cleanup();
});

test("Ctrl-] detaches: the prefix is forwarded, output stops, later input drops", async () => {
  const fake = fakeProc();
  const stdin = new FakeTtyInput();
  const stdout = new FakeTtyOutput();
  const attach = attachTty(
    fake.proc,
    stdin as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream,
    new FakeTtyOutput() as unknown as NodeJS.WriteStream,
  );

  stdin.write("ec");
  stdin.write(Buffer.from([0x1d]));
  await attach.escape;
  stdin.write("late\n");
  fake.stdout.write("late output\n");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(Buffer.concat(fake.written).toString(), "ec");
  assert.equal(stdout.received.join(""), "");
  assert.deepEqual(stdin.rawMode, [true, false]);
});

test("resize is sent immediately and on terminal resize events", () => {
  const fake = fakeProc();
  const stdout = new FakeTtyOutput();
  stdout.columns = 100;
  stdout.rows = 30;
  const attach = attachTty(
    fake.proc,
    new FakeTtyInput() as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream,
    new FakeTtyOutput() as unknown as NodeJS.WriteStream,
  );

  assert.deepEqual(fake.resized, [{ rows: 30, cols: 100 }]);
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.emit("resize");
  assert.deepEqual(fake.resized, [
    { rows: 30, cols: 100 },
    { rows: 40, cols: 120 },
  ]);
  attach.cleanup();
  // Cleanup removes the resize listener.
  stdout.emit("resize");
  assert.equal(fake.resized.length, 2);
});

test("a settling result cleans up: raw mode off, input stops, end on stdin end", async () => {
  const fake = fakeProc();
  const stdin = new FakeTtyInput();
  attachTty(
    fake.proc,
    stdin as unknown as NodeJS.ReadStream,
    new FakeTtyOutput() as unknown as NodeJS.WriteStream,
    new FakeTtyOutput() as unknown as NodeJS.WriteStream,
  );

  stdin.write("bef");
  stdin.end();
  // Let the end event fire before the session result settles; cleanup
  // pauses stdin, which would otherwise swallow the pending end.
  await new Promise((resolve) => setImmediate(resolve));
  fake.resolveResult(0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.ended, true);
  assert.equal(Buffer.concat(fake.written).toString(), "bef");
  assert.deepEqual(stdin.rawMode, [true, false]);
  // After cleanup, host input no longer reaches the guest.
  stdin.write("after\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Buffer.concat(fake.written).toString(), "bef");
});

// ---------------------------------------------------------------------------
// runBash
// ---------------------------------------------------------------------------

test("runBash fails closed without an interactive terminal", async () => {
  const { ui, stderr } = makeUi(false);
  await assert.rejects(runBash([], ui), /needs an interactive terminal/);
  assert.equal(stderr.output(), "");
});

test("runBash rejects unexpected arguments", async () => {
  const { ui } = makeUi(true);
  await assert.rejects(runBash(["--foo"], ui), /takes no arguments/);
});

test("runBash builds the VM from the shared spec and passes the exit code through", async (t) => {
  const proj = scratchProject({ cpus: 3 });
  t.after(() => proj.restore());
  const { ui } = makeUi(true);
  const fake = fakeProc();
  const vm = fakeVm(fake.proc);
  const createdOptions: VMOptions[] = [];
  const { deps, started } = bashDeps(vm, new FakeTtyInput());
  deps.createVm = async (options: VMOptions) => {
    createdOptions.push(options);
    return vm.vm;
  };

  const session = runBash([], ui, deps);
  await started;
  fake.resolveResult(7);
  const code = await session;

  assert.equal(code, 7);
  assert.equal(vm.closed, 1);
  const options = createdOptions[0];
  assert.ok(options);
  // No image selected: the sandbox carries the coalesced scalars only.
  assert.equal(options.sandbox?.imagePath, undefined);
  assert.equal(options.sandbox?.cpus, 3);
  assert.equal(options.sessionLabel, `echoriad bash ${path.basename(proj.dir)}`);
  // The shell starts unattached in the guest workspace with the bash
  // fallback command.
  assert.deepEqual(vm.shellOptions, [
    {
      attach: false,
      cwd: "/workspace",
      command: [
        "/bin/sh",
        "-lc",
        "if command -v bash >/dev/null 2>&1; then exec bash -i; else exec /bin/sh -i; fi",
      ],
    },
  ]);
});

test("runBash starts the VM from the project's image selection", async (t) => {
  const proj = scratchProject({ image: "my-image:latest" });
  t.after(() => proj.restore());
  const { ui } = makeUi(true);
  const fake = fakeProc();
  const vm = fakeVm(fake.proc);
  const createdOptions: VMOptions[] = [];
  const { deps, started } = bashDeps(vm, new FakeTtyInput());
  deps.createVm = async (options: VMOptions) => {
    createdOptions.push(options);
    return vm.vm;
  };

  const session = runBash([], ui, deps);
  await started;
  fake.resolveResult(0);
  await session;

  assert.equal(createdOptions[0]?.sandbox?.imagePath, "my-image:latest");
});

test("runBash forwards the resolved guest image into the VM options", async (t) => {
  const proj = scratchProject();
  t.after(() => proj.restore());
  const { ui } = makeUi(true);
  const fake = fakeProc();
  const vm = fakeVm(fake.proc);
  const createdOptions: VMOptions[] = [];
  const { deps, started } = bashDeps(vm, new FakeTtyInput());
  deps.createVm = async (options: VMOptions) => {
    createdOptions.push(options);
    return vm.vm;
  };
  deps.resolveImage = async () => ({ imagePath: "resolved-build-id" });

  const session = runBash([], ui, deps);
  await started;
  fake.resolveResult(0);
  await session;

  assert.equal(createdOptions[0]?.sandbox?.imagePath, "resolved-build-id");
});

test("Ctrl-] detaches the session with exit code 130 and tears the VM down", async (t) => {
  const proj = scratchProject();
  t.after(() => proj.restore());
  const { ui, stdout } = makeUi(true);
  const fake = fakeProc();
  const vm = fakeVm(fake.proc);
  const stdin = new FakeTtyInput();
  const { deps, started } = bashDeps(vm, stdin);

  const session = runBash([], ui, deps);
  await started;
  stdin.write(Buffer.from([0x1d]));
  const code = await session;

  assert.equal(code, 130);
  assert.equal(vm.closed, 1);
  assert.match(stdout.output(), /\[echoriad\] detached \(Ctrl-\]\)/);
});

test("a guest shell exit by signal is reported and the exit code passes through", async (t) => {
  const proj = scratchProject();
  t.after(() => proj.restore());
  const { ui, stdout } = makeUi(true);
  const fake = fakeProc();
  const vm = fakeVm(fake.proc);
  const { deps, started } = bashDeps(vm, new FakeTtyInput());

  const session = runBash([], ui, deps);
  await started;
  fake.resolveResult(137, 9);
  const code = await session;

  assert.equal(code, 137);
  assert.match(stdout.output(), /signal 9/);
  assert.equal(vm.closed, 1);
});

test("an invalid project config surfaces as a ConfigError", async (t) => {
  const proj = scratchProject();
  fs.writeFileSync(path.join(proj.dir, ".echoriad.json"), "{ not json");
  t.after(() => proj.restore());
  const { ui } = makeUi(true);
  const fake = fakeProc();
  const vm = fakeVm(fake.proc);
  const { deps } = bashDeps(vm, new FakeTtyInput());

  await assert.rejects(runBash([], ui, deps), ConfigError);
  assert.equal(vm.closed, 0);
});
