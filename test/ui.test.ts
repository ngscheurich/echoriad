import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CancelledError,
  CliError,
  createUi,
  resolvePlainMode,
  type UiStream,
} from "../src/cli/ui.ts";

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

test("plain mode follows the documented precedence", () => {
  const cases = [
    {
      name: "flag wins over env and system config",
      input: { flag: true, env: "", systemPlain: false },
      want: true,
    },
    {
      name: "non-empty env wins over system config, regardless of value",
      input: { flag: false, env: "0", systemPlain: false },
      want: true,
    },
    {
      name: "non-empty env set to false still forces plain (NO_COLOR semantics)",
      input: { flag: false, env: "false", systemPlain: false },
      want: true,
    },
    {
      name: "empty env is ignored, falls through to system config",
      input: { flag: false, env: "", systemPlain: true },
      want: true,
    },
    {
      name: "undefined env falls through to system config",
      input: { flag: false, env: undefined, systemPlain: true },
      want: true,
    },
    {
      name: "system config off with nothing else set",
      input: { flag: false, env: undefined, systemPlain: false },
      want: false,
    },
    {
      name: "system config unset with nothing else set",
      input: { flag: false, env: undefined, systemPlain: undefined },
      want: false,
    },
  ];
  for (const { name, input, want } of cases) {
    assert.equal(resolvePlainMode(input), want, name);
  }
});

test("ui.error writes the error convention to stderr", () => {
  const stderr = captureStream();
  const ui = createUi({
    stdout: captureStream(),
    stderr,
    plain: false,
    isInteractive: true,
  });
  ui.error("Echoriad: invalid .echoriad.json: bad field");
  assert.equal(stderr.output(), "error: Echoriad: invalid .echoriad.json: bad field\n");
});

test("ui.cancelled writes the cancel convention to stderr", () => {
  const stderr = captureStream();
  const ui = createUi({
    stdout: captureStream(),
    stderr,
    plain: false,
    isInteractive: true,
  });
  ui.cancelled("approve");
  assert.equal(stderr.output(), "cancelled: approve\n");
});

test("ui.line writes a plain line to stdout", () => {
  const stdout = captureStream();
  const ui = createUi({
    stdout,
    stderr: captureStream(),
    plain: false,
    isInteractive: true,
  });
  ui.line("up to date");
  assert.equal(stdout.output(), "up to date\n");
});

test("the non-TTY gate fails closed with the alternative", () => {
  const ui = createUi({
    stdout: captureStream(),
    stderr: captureStream(),
    plain: false,
    isInteractive: false,
  });
  assert.throws(
    () => ui.requireInteractive("approve", "use `approve --yes` to skip the prompt"),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /approve needs an interactive terminal/);
      assert.match(error.message, /approve --yes/);
      return true;
    },
  );
});

test("the non-TTY gate passes on an interactive terminal", () => {
  const ui = createUi({
    stdout: captureStream(),
    stderr: captureStream(),
    plain: false,
    isInteractive: true,
  });
  ui.requireInteractive("approve", "use `approve --yes` to skip the prompt");
});

test("error classes carry their category name", () => {
  assert.equal(new CliError("boom").name, "CliError");
  const cancelled = new CancelledError("approve");
  assert.equal(cancelled.name, "CancelledError");
  assert.equal(cancelled.command, "approve");
  assert.equal(cancelled.message, "cancelled: approve");
});
