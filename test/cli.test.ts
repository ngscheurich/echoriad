import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import type { UiStream } from "../src/cli/ui.ts";
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

test("main reports an unknown command through the error convention", () => {
  const stderr = captureStream();
  const exit = main(["frobnicate"], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), 'error: unknown command "frobnicate"\n');
});

test("main reports a missing command through the error convention", () => {
  const stderr = captureStream();
  const exit = main([], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), "error: missing command\n");
});

test("main rejects unknown global options", () => {
  const stderr = captureStream();
  const exit = main(["--color", "status"], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), 'error: unknown option "--color"\n');
});

test("main reuses ConfigError messages verbatim", () => {
  const stderr = captureStream();
  const configError = new ConfigError(
    "Echoriad: invalid system config (/x/config.json): broken",
    "/x/config.json",
  );
  const exit = main(
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

test("main accepts the --plain flag before the command", () => {
  // Flags after the command name belong to the command itself; only
  // --plain is recognized before it.
  const stderr = captureStream();
  const exit = main(["--plain", "frobnicate"], testDeps({ stderr }));
  assert.equal(exit, 1);
  assert.equal(stderr.output(), 'error: unknown command "frobnicate"\n');
});
