import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { BuildConfig } from "@earendil-works/gondolin";
import {
  canonicalJson,
  computeBuildFingerprint,
  gondolinVersion,
  hashLocalInput,
  type LocalInputNode,
} from "../src/fingerprint.ts";

function makeTree(): { dir: string; p: (...parts: string[]) => string } {
  const dir = fs.mkdtempSync(path.join("/tmp", "echoriad-fp-"));
  return { dir, p: (...parts: string[]) => path.join(dir, ...parts) };
}

function baseConfig(): BuildConfig {
  return {
    arch: "aarch64",
    distro: "alpine",
    alpine: { version: "3.23.0" },
  };
}

function writeBuildConfig(dir: string, config: unknown): string {
  const configPath = path.join(dir, "build-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

test("canonicalJson sorts object keys recursively and preserves array order", () => {
  const value = { b: 1, a: { d: [2, 1], c: null } };
  assert.equal(canonicalJson(value), '{"a":{"c":null,"d":[2,1]},"b":1}');
});

test("canonicalJson is independent of key insertion order", () => {
  const a = canonicalJson({ x: { p: 1, q: 2 } });
  const b = canonicalJson({ x: { q: 2, p: 1 } });
  assert.equal(a, b);
});

test("gondolinVersion reads the installed package version", () => {
  assert.equal(gondolinVersion(), "0.12.0");
});

test("fingerprint is stable across JSON formatting and key order", () => {
  const { dir } = makeTree();
  const one = writeBuildConfig(dir, {
    arch: "aarch64",
    distro: "alpine",
    alpine: { version: "3.23.0", kernelPackage: "linux-virt" },
  });
  const parsedOne = JSON.parse(fs.readFileSync(one, "utf8"));
  const first = computeBuildFingerprint(parsedOne, dir);

  const two = writeBuildConfig(dir, {
    alpine: { kernelPackage: "linux-virt", version: "3.23.0" },
    distro: "alpine",
    arch: "aarch64",
  });
  const parsedTwo = JSON.parse(fs.readFileSync(two, "utf8"));
  const second = computeBuildFingerprint(parsedTwo, dir);

  assert.equal(first.fingerprint, second.fingerprint);
});

test("fingerprint covers recognized local inputs", () => {
  const { dir, p } = makeTree();
  fs.writeFileSync(p("init.sh"), "echo hi\n");
  fs.writeFileSync(p("helper"), "binary");
  const config: BuildConfig = {
    ...baseConfig(),
    init: { rootfsInit: "init.sh" },
    postBuild: { copy: [{ src: "helper", dest: "/usr/bin/helper" }] },
    sandboxdPath: "helper",
  };
  const result = computeBuildFingerprint(config, dir);
  assert.deepEqual(result.localInputPaths, [p("init.sh"), p("helper")]);
});

test("changing a local input changes the fingerprint (invalidation)", () => {
  const { dir, p } = makeTree();
  fs.writeFileSync(p("init.sh"), "echo one\n");
  const config: BuildConfig = {
    ...baseConfig(),
    init: { rootfsInit: "init.sh" },
  };
  const first = computeBuildFingerprint(config, dir);

  fs.writeFileSync(p("init.sh"), "echo two\n");
  const second = computeBuildFingerprint(config, dir);
  assert.notEqual(first.fingerprint, second.fingerprint);

  // File timestamps must not affect it: rewrite identical contents so mtime
  // changes but bytes do not.
  fs.writeFileSync(p("init.sh"), "echo two\n");
  const third = computeBuildFingerprint(config, dir);
  assert.equal(second.fingerprint, third.fingerprint);
});

test("file mode changes the fingerprint when it is build-relevant", () => {
  const { dir, p } = makeTree();
  const script = p("init.sh");
  fs.writeFileSync(script, "echo hi\n");
  fs.chmodSync(script, 0o755);
  const exec = computeBuildFingerprint({ ...baseConfig(), init: { rootfsInit: "init.sh" } }, dir);
  fs.chmodSync(script, 0o644);
  const nonExec = computeBuildFingerprint(
    { ...baseConfig(), init: { rootfsInit: "init.sh" } },
    dir,
  );
  assert.notEqual(exec.fingerprint, nonExec.fingerprint);
});

test("directory inputs hash entry names, contents, and symlink targets deterministically", () => {
  const { dir, p } = makeTree();
  const tree = p("tree");
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "a.txt"), "A");
  fs.mkdirSync(path.join(tree, "sub"));
  fs.writeFileSync(path.join(tree, "sub", "b.txt"), "B");
  fs.symlinkSync("a.txt", path.join(tree, "link"));

  const config: BuildConfig = {
    ...baseConfig(),
    postBuild: { copy: [{ src: "tree", dest: "/opt/tree" }] },
  };
  const first = computeBuildFingerprint(config, dir);

  // Re-create the same tree with a different creation order.
  fs.rmSync(tree, { recursive: true });
  fs.mkdirSync(tree);
  fs.symlinkSync("a.txt", path.join(tree, "link"));
  fs.mkdirSync(path.join(tree, "sub"));
  fs.writeFileSync(path.join(tree, "sub", "b.txt"), "B");
  fs.writeFileSync(path.join(tree, "a.txt"), "A");
  const second = computeBuildFingerprint(config, dir);
  assert.equal(first.fingerprint, second.fingerprint);

  // A content change inside the directory invalidates.
  fs.writeFileSync(path.join(tree, "sub", "b.txt"), "changed");
  const third = computeBuildFingerprint(config, dir);
  assert.notEqual(first.fingerprint, third.fingerprint);

  // A symlink target change invalidates.
  fs.rmSync(path.join(tree, "link"));
  fs.symlinkSync("sub", path.join(tree, "link"));
  const fourth = computeBuildFingerprint(config, dir);
  assert.notEqual(first.fingerprint, fourth.fingerprint);
});

test("special filesystem nodes are rejected with actionable errors", () => {
  const { dir, p } = makeTree();
  const fifo = p("pipe");
  let created = false;
  try {
    execSync(`mkfifo ${JSON.stringify(fifo)}`);
    created = fs.existsSync(fifo);
  } catch {
    created = false;
  }
  if (!created) return; // platform cannot create FIFOs; rejection covered by unit shapes
  const config: BuildConfig = {
    ...baseConfig(),
    postBuild: { copy: [{ src: "pipe", dest: "/x" }] },
  };
  assert.throws(() => computeBuildFingerprint(config, dir), /unsupported FIFO/);
});

test("missing local inputs are rejected with the declared and resolved path", () => {
  const { dir, p } = makeTree();
  const config: BuildConfig = {
    ...baseConfig(),
    init: { rootfsInit: "does-not-exist.sh" },
  };
  assert.throws(
    () => computeBuildFingerprint(config, dir),
    (error: Error) =>
      /does not exist/.test(error.message) &&
      error.message.includes("does-not-exist.sh") &&
      error.message.includes(p("does-not-exist.sh")),
  );
});

test("fingerprint includes the gondolin version and schema version", () => {
  const { dir } = makeTree();
  const config = baseConfig();
  const result = computeBuildFingerprint(config, dir);
  // Recompute the expected digest from the documented payload.
  const expected = crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        schema: 1,
        gondolinVersion: gondolinVersion(),
        config,
        inputs: {},
      }),
    )
    .digest("hex");
  assert.equal(result.fingerprint, expected);
  assert.equal(result.abbreviated, expected.slice(0, 12));
});

test("directory traversal includes node types (directory vs file differ)", () => {
  const { dir, p } = makeTree();
  const a = p("thing");
  fs.writeFileSync(a, "x");
  const fileConfig: BuildConfig = {
    ...baseConfig(),
    postBuild: { copy: [{ src: "thing", dest: "/x" }] },
  };
  const asFile = computeBuildFingerprint(fileConfig, dir);
  fs.rmSync(a);
  fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, "x"), "x");
  const asDir = computeBuildFingerprint(fileConfig, dir);
  assert.notEqual(asFile.fingerprint, asDir.fingerprint);
});

test("input node shapes cover file, symlink, and directory", () => {
  const { dir, p } = makeTree();
  fs.writeFileSync(p("f"), "content");
  fs.symlinkSync("f", p("l"));
  fs.mkdirSync(p("d"));
  const file = hashLocalInput(dir, "f").node as Extract<LocalInputNode, { type: "file" }>;
  assert.equal(file.sha256, crypto.createHash("sha256").update("content").digest("hex"));
  assert.equal(file.mode, fs.statSync(p("f")).mode & 0o7777);
  const link = hashLocalInput(dir, "l").node as Extract<LocalInputNode, { type: "symlink" }>;
  assert.equal(link.target, "f");
  const directory = hashLocalInput(dir, "d").node as Extract<LocalInputNode, { type: "directory" }>;
  assert.deepEqual(directory.entries, {});
});
