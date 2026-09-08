import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { runGondolinBuild } from "../src/guest-image.ts";

const command = {
  cliPath: path.resolve("test/fixtures/build-child.mjs"),
  configPath: "success",
  outputDir: "/unused",
  imageRef: "fixture:latest",
};

test("an already cancelled build never starts a child", async () => {
  const output: string[] = [];
  await assert.rejects(runGondolinBuild(command, (s) => output.push(s), undefined,
    AbortSignal.abort()), /cancelled/);
  assert.deepEqual(output, []);
});

test("cancellation terminates descendants even when the leader exits on TERM", async () => {
  const controller = new AbortController();
  let pid = 0;
  await assert.rejects(runGondolinBuild({ ...command, configPath: "tree" }, (s) => {
    const match = /descendant:(\d+)/.exec(s);
    if (match) {
      pid = Number(match[1]);
      controller.abort();
    }
  }, undefined, controller.signal), /cancelled/);
  assert.ok(pid);
  // A killed orphan can briefly remain a zombie until the host reaps it.
  const { execFileSync } = await import("node:child_process");
  const processes = execFileSync("ps", ["-o", "pid,stat"], { encoding: "utf8" });
  const state = processes.split("\n").map((line) => line.trim().split(/\s+/))
    .find(([id]) => Number(id) === pid)?.[1];
  assert.ok(!state || state.startsWith("Z"), `descendant still running: ${state}`);
});

test("stdout and stderr stream to diagnostics and failure tails stay out of errors", async () => {
  let output = "";
  let tail = "";
  await assert.rejects(runGondolinBuild({ ...command, configPath: "failure" },
    (s) => { output += s; }, (s) => { tail = s; }), (error: Error) => {
      assert.match(error.message, /code 3/);
      assert.doesNotMatch(error.message, /fixture/);
      return true;
    });
  for (const text of ["stdout fixture", "stderr fixture"]) {
    assert.ok(output.includes(text));
    assert.ok(tail.includes(text));
  }
});

test("builds inherit host variables without guest environment filtering", async () => {
  const previous = process.env.ECHORIAD_BUILD_FIXTURE;
  process.env.ECHORIAD_BUILD_FIXTURE = "host-only-value";
  try {
    let output = "";
    await runGondolinBuild({ ...command, configPath: "environment" }, (s) => { output += s; });
    assert.match(output, /inherited:host-only-value/);
  } finally {
    if (previous === undefined) delete process.env.ECHORIAD_BUILD_FIXTURE;
    else process.env.ECHORIAD_BUILD_FIXTURE = previous;
  }
});
