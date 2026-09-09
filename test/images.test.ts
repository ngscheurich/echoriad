import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import type { ImagesDeps } from "../src/cli/images.ts";
import { main } from "../src/cli/index.ts";
import type { UiStream } from "../src/cli/ui.ts";

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

/** A valid Gondolin build id distinct per call (UUID shape, version 4). */
function buildId(n: number): string {
  return `0000000a-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
}

/** A 64-hex fingerprint with the given prefix. */
function fingerprint(prefix: string): string {
  return `${prefix}${"0".repeat(64 - prefix.length)}`;
}

function echoriadName(fp: string): string {
  return `echoriad-build-${fp}`;
}

/** Image-ref listing shape as Gondolin's public API reports it. */
function refListing(
  reference: string,
  targets: Record<string, string>,
  updatedAt: string,
): { reference: string; targets: Record<string, string>; updatedAt: string } {
  return { reference, targets, updatedAt };
}

function imagesDeps(overrides: Partial<ImagesDeps> = {}): ImagesDeps {
  return {
    listRefs: () => [],
    storeDir: () => "/nonexistent-store",
    authorizations: () => [],
    consumerId: () => "test:consumer",
    ...overrides,
  };
}

interface TestRun {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runCli(argv: string[], overrides: Record<string, unknown> = {}): Promise<TestRun> {
  const stdout = captureStream();
  const stderr = captureStream();
  const deps = {
    stdout,
    stderr,
    env: {},
    isInteractive: false,
    loadSystemConfig: () => ({}),
    imagesDeps: imagesDeps(),
    ...overrides,
  };
  const exit = await main(argv, deps);
  return { exit, stdout: stdout.output(), stderr: stderr.output() };
}

test("images prints a friendly line when no Echoriad-built guest images exist", async () => {
  const run = await runCli(["images"]);
  assert.equal(run.exit, 0);
  assert.equal(run.stdout, "No Echoriad-built guest images.\n");
});

test("images lists only Echoriad-built refs, one row per arch target", async () => {
  const deps = imagesDeps({
    listRefs: () => [
      refListing(
        `${echoriadName(fingerprint("a1"))}:latest`,
        { x86_64: buildId(1) },
        "2025-09-08T12:00:00.000Z",
      ),
      refListing(
        `${echoriadName(fingerprint("b2"))}:latest`,
        { x86_64: buildId(3), aarch64: buildId(2) },
        "2025-09-08T13:00:00.000Z",
      ),
      refListing("alpine-base:latest", { x86_64: buildId(4) }, "2025-09-08T14:00:00.000Z"),
      refListing(
        "echoriad-build-not-hex:latest",
        { x86_64: buildId(5) },
        "2025-09-08T15:00:00.000Z",
      ),
    ],
  });
  const run = await runCli(["images"], { imagesDeps: deps });
  assert.equal(run.exit, 0);
  const lines = run.stdout.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^FINGERPRINT\s+BUILD ID\s+ARCH\s+UPDATED\s+AUTHORIZED$/);
  // Sorted by fingerprint, then arch: a1 before b2, aarch64 before x86_64.
  assert.ok(lines[1]?.startsWith("a10000000000"));
  assert.ok(lines[1]?.includes(buildId(1)));
  assert.ok(lines[2]?.startsWith("b20000000000"));
  assert.ok(lines[2]?.includes("aarch64"));
  assert.ok(lines[2]?.includes(buildId(2)));
  assert.ok(lines[3]?.includes("x86_64"));
  assert.ok(lines[3]?.includes(buildId(3)));
});

test("authorized marks only the current consumer's matching association", async () => {
  const deps = imagesDeps({
    listRefs: () => [
      refListing(
        `${echoriadName(fingerprint("a1"))}:latest`,
        { x86_64: buildId(1) },
        "2025-09-08T12:00:00.000Z",
      ),
      refListing(
        `${echoriadName(fingerprint("b2"))}:latest`,
        { x86_64: buildId(2) },
        "2025-09-08T12:00:00.000Z",
      ),
      refListing(
        `${echoriadName(fingerprint("c3"))}:latest`,
        { x86_64: buildId(3) },
        "2025-09-08T12:00:00.000Z",
      ),
    ],
    authorizations: () => [
      {
        consumer: "test:consumer",
        config: "repo:bc.json",
        fingerprint: fingerprint("a1"),
        buildId: buildId(1),
      },
      // Same-fingerprint rebuild: the association's build id is stale.
      {
        consumer: "test:consumer",
        config: "repo:bc.json",
        fingerprint: fingerprint("b2"),
        buildId: buildId(99),
      },
      {
        consumer: "other:consumer",
        config: "repo:bc.json",
        fingerprint: fingerprint("c3"),
        buildId: buildId(3),
      },
    ],
  });
  const run = await runCli(["images"], { imagesDeps: deps });
  assert.equal(run.exit, 0);
  const lines = run.stdout.split("\n").filter((line) => line !== "");
  assert.ok(lines[1]?.endsWith("authorized"));
  assert.ok(lines[2]?.endsWith("not authorized"));
  assert.ok(lines[3]?.endsWith("not authorized"));
});

test("images --json carries every field including the full fingerprint", async () => {
  const fp = fingerprint("a1");
  const deps = imagesDeps({
    listRefs: () => [
      refListing(`${echoriadName(fp)}:latest`, { x86_64: buildId(1) }, "2025-09-08T12:00:00.000Z"),
      refListing("alpine-base:latest", { x86_64: buildId(4) }, "2025-09-08T14:00:00.000Z"),
    ],
    authorizations: () => [
      { consumer: "test:consumer", config: "repo:bc.json", fingerprint: fp, buildId: buildId(1) },
    ],
  });
  const run = await runCli(["images", "--json"], { imagesDeps: deps });
  assert.equal(run.exit, 0);
  assert.deepEqual(JSON.parse(run.stdout), [
    {
      ref: `${echoriadName(fp)}:latest`,
      fingerprint: fp,
      abbreviatedFingerprint: fp.slice(0, 12),
      buildId: buildId(1),
      arch: "x86_64",
      updatedAt: "2025-09-08T12:00:00.000Z",
      authorized: true,
    },
  ]);
});

test("images --json prints an empty array when no images exist", async () => {
  const run = await runCli(["images", "--json"]);
  assert.equal(run.exit, 0);
  assert.equal(run.stdout, "[]\n");
});

/**
 * A Gondolin image store fixture: refs/<name>/<tag>/<arch> symlinks into
 * objects/<buildId> directories, mirroring the layout Gondolin writes.
 */
function makeStore(t: TestContext): {
  storeDir: string;
  addRef(opts: {
    name: string;
    tag?: string;
    arch?: string;
    buildId: string;
    /** false leaves the object directory absent (a broken ref link) */
    object?: boolean;
  }): void;
  exists(p: string): boolean;
} {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-images-store-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const exists = (p: string) => fs.existsSync(path.join(storeDir, p));
  return {
    storeDir,
    exists,
    addRef({ name, tag = "latest", arch = "x86_64", buildId, object = true }) {
      if (object) {
        const objectDir = path.join(storeDir, "objects", buildId);
        fs.mkdirSync(objectDir, { recursive: true });
        fs.writeFileSync(
          path.join(objectDir, "manifest.json"),
          JSON.stringify({ buildId, config: { arch } }),
        );
      }
      const linkDir = path.join(storeDir, "refs", name, tag);
      fs.mkdirSync(linkDir, { recursive: true });
      fs.symlinkSync(
        path.relative(linkDir, path.join(storeDir, "objects", buildId)),
        path.join(linkDir, arch),
        "dir",
      );
    },
  };
}

test("images remove takes exactly one image reference", async () => {
  const none = await runCli(["images", "remove"]);
  assert.equal(none.exit, 1);
  assert.match(none.stderr, /error: images remove takes exactly one image reference/);

  const two = await runCli(["images", "remove", "a", "b"]);
  assert.equal(two.exit, 1);
  assert.match(two.stderr, /error: images remove takes exactly one image reference/);

  const flag = await runCli(["images", "remove", "--all"]);
  assert.equal(flag.exit, 1);
  assert.equal(flag.stderr, 'error: unknown option "--all" for images remove\n');
});

test("images remove refuses refs outside the echoriad-build prefix", async () => {
  const run = await runCli(["images", "remove", "alpine-base:latest"]);
  assert.equal(run.exit, 1);
  assert.match(run.stderr, /error: "alpine-base:latest" is not an Echoriad-built image/);
  assert.match(run.stderr, /echoriad-build-/);
});

test("images remove refuses arguments in neither accepted form", async () => {
  const notHex = await runCli(["images", "remove", "zzz"]);
  assert.equal(notHex.exit, 1);
  assert.match(notHex.stderr, /error: "zzz" is not an image reference/);

  const badRemainder = await runCli(["images", "remove", "echoriad-build-not-hex:latest"]);
  assert.equal(badRemainder.exit, 1);
  assert.match(
    badRemainder.stderr,
    /error: "echoriad-build-not-hex:latest" is not an Echoriad-built image ref/,
  );
});

test("images remove deletes the ref links and the unreferenced object", async (t) => {
  const store = makeStore(t);
  const fp = fingerprint("a1");
  const other = echoriadName(fingerprint("c3"));
  store.addRef({ name: echoriadName(fp), buildId: buildId(1) });
  store.addRef({ name: other, buildId: buildId(2) });

  const run = await runCli(["images", "remove", `${echoriadName(fp)}:latest`], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 0);
  // The ref's name directory is pruned once its last tag is gone.
  assert.ok(!store.exists(path.join("refs", echoriadName(fp))));
  assert.ok(!store.exists(path.join("objects", buildId(1))));
  // The other image is untouched.
  assert.ok(store.exists(path.join("refs", other, "latest", "x86_64")));
  assert.ok(store.exists(path.join("objects", buildId(2))));
  assert.equal(
    run.stdout,
    `removed image ref ${echoriadName(fp)}:latest\ndeleted build object ${buildId(1)}\n`,
  );
});

test("images remove resolves a fingerprint abbreviation that matches one ref", async (t) => {
  const store = makeStore(t);
  const fpA = fingerprint("a1");
  const fpB = fingerprint("b2");
  store.addRef({ name: echoriadName(fpA), buildId: buildId(1) });
  store.addRef({ name: echoriadName(fpB), buildId: buildId(2) });

  // The full fingerprint without a tag resolves through the abbreviation path.
  const run = await runCli(["images", "remove", fpA], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 0);
  assert.ok(!store.exists(path.join("refs", echoriadName(fpA))));
  assert.ok(!store.exists(path.join("objects", buildId(1))));
  assert.ok(store.exists(path.join("refs", echoriadName(fpB))));
});

test("images remove rejects ambiguous and unmatched fingerprint abbreviations", async (t) => {
  const store = makeStore(t);
  const fpA = fingerprint("ab1");
  const fpB = fingerprint("ab2");
  store.addRef({ name: echoriadName(fpA), buildId: buildId(1) });
  store.addRef({ name: echoriadName(fpB), buildId: buildId(2) });
  const deps = { imagesDeps: imagesDeps({ storeDir: () => store.storeDir }) };

  const ambiguous = await runCli(["images", "remove", "ab"], deps);
  assert.equal(ambiguous.exit, 1);
  assert.match(ambiguous.stderr, /error: fingerprint abbreviation "ab" matches 2 image refs/);
  assert.match(ambiguous.stderr, /pass the full name:tag instead/);
  assert.ok(store.exists(path.join("refs", echoriadName(fpA), "latest", "x86_64")));

  const none = await runCli(["images", "remove", "ff"], deps);
  assert.equal(none.exit, 1);
  assert.match(none.stderr, /error: no Echoriad-built image matches fingerprint abbreviation "ff"/);
});

test("images remove deletes links for the named tag only", async (t) => {
  const store = makeStore(t);
  const fp = fingerprint("a1");
  store.addRef({ name: echoriadName(fp), tag: "latest", buildId: buildId(1) });
  store.addRef({ name: echoriadName(fp), tag: "v2", buildId: buildId(2) });

  const run = await runCli(["images", "remove", `${echoriadName(fp)}:latest`], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 0);
  assert.ok(!store.exists(path.join("refs", echoriadName(fp), "latest")));
  assert.ok(store.exists(path.join("refs", echoriadName(fp), "v2", "x86_64")));
  assert.ok(!store.exists(path.join("objects", buildId(1))));
  assert.ok(store.exists(path.join("objects", buildId(2))));
});

test("images remove deletes every arch link of the named tag", async (t) => {
  const store = makeStore(t);
  const fp = fingerprint("a1");
  store.addRef({ name: echoriadName(fp), arch: "aarch64", buildId: buildId(1) });
  store.addRef({ name: echoriadName(fp), arch: "x86_64", buildId: buildId(2) });

  const run = await runCli(["images", "remove", fp], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 0);
  assert.ok(!store.exists(path.join("refs", echoriadName(fp))));
  assert.ok(!store.exists(path.join("objects", buildId(1))));
  assert.ok(!store.exists(path.join("objects", buildId(2))));
});

test("images remove keeps objects another ref still targets", async (t) => {
  const store = makeStore(t);
  const fp = fingerprint("a1");
  store.addRef({ name: echoriadName(fp), buildId: buildId(1) });
  // A user-created ref targets the same object: the object must survive.
  store.addRef({ name: "my-image", buildId: buildId(1) });

  const run = await runCli(["images", "remove", `${echoriadName(fp)}:latest`], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 0);
  assert.ok(!store.exists(path.join("refs", echoriadName(fp))));
  assert.ok(store.exists(path.join("refs", "my-image", "latest", "x86_64")));
  assert.ok(store.exists(path.join("objects", buildId(1))));
  assert.match(run.stdout, /kept build object \S+ \(still referenced by another image ref\)/);
});

test("images remove removes a ref whose object is already gone", async (t) => {
  const store = makeStore(t);
  const fp = fingerprint("a1");
  store.addRef({ name: echoriadName(fp), buildId: buildId(1), object: false });

  const run = await runCli(["images", "remove", fp], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 0);
  assert.ok(!store.exists(path.join("refs", echoriadName(fp))));
  assert.equal(run.stdout, `removed image ref ${echoriadName(fp)}:latest\n`);
});

test("images remove reports a missing ref", async (t) => {
  const store = makeStore(t);
  const run = await runCli(["images", "remove", `${echoriadName(fingerprint("a1"))}:latest`], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 1);
  assert.match(
    run.stderr,
    /error: no image ref "echoriad-build-a1[0]*:latest" in the Gondolin image store/,
  );
});

test("images remove refuses and deletes nothing when the layout probe fails", async (t) => {
  const store = makeStore(t);
  const fp = fingerprint("a1");
  store.addRef({ name: echoriadName(fp), buildId: buildId(1) });
  // A regular file where an arch symlink belongs.
  fs.writeFileSync(path.join(store.storeDir, "refs", echoriadName(fp), "latest", "junk"), "stray");

  const run = await runCli(["images", "remove", `${echoriadName(fp)}:latest`], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 1);
  assert.match(run.stderr, /error: unexpected image store layout/);
  assert.match(run.stderr, /refusing to remove/);
  assert.ok(store.exists(path.join("refs", echoriadName(fp), "latest", "x86_64")));
  assert.ok(store.exists(path.join("objects", buildId(1))));
});

test("images remove refuses ref links that escape the objects directory", async (t) => {
  const store = makeStore(t);
  const fp = fingerprint("a1");
  store.addRef({ name: echoriadName(fp), buildId: buildId(1) });
  const outside = path.join(store.storeDir, "elsewhere");
  fs.mkdirSync(outside);
  const linkDir = path.join(store.storeDir, "refs", echoriadName(fp), "latest");
  fs.rmSync(path.join(linkDir, "x86_64"));
  fs.symlinkSync(path.relative(linkDir, outside), path.join(linkDir, "x86_64"), "dir");

  const run = await runCli(["images", "remove", `${echoriadName(fp)}:latest`], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 1);
  assert.match(run.stderr, /error: unexpected image store layout/);
  assert.ok(store.exists(path.join("refs", echoriadName(fp), "latest", "x86_64")));
});

test("images remove refuses when the tag path is not a directory", async (t) => {
  const store = makeStore(t);
  const fp = fingerprint("a1");
  fs.mkdirSync(path.join(store.storeDir, "refs", echoriadName(fp)), { recursive: true });
  fs.writeFileSync(path.join(store.storeDir, "refs", echoriadName(fp), "latest"), "stray");

  const run = await runCli(["images", "remove", `${echoriadName(fp)}:latest`], {
    imagesDeps: imagesDeps({ storeDir: () => store.storeDir }),
  });
  assert.equal(run.exit, 1);
  assert.match(run.stderr, /error: unexpected image store layout/);
  assert.ok(store.exists(path.join("refs", echoriadName(fp), "latest")));
});

test("images rejects unknown subcommands and options", async () => {
  const run = await runCli(["images", "frobnicate"]);
  assert.equal(run.exit, 1);
  assert.equal(run.stderr, 'error: unknown images argument "frobnicate"\n');

  const runFlag = await runCli(["images", "--all"]);
  assert.equal(runFlag.exit, 1);
  assert.equal(runFlag.stderr, 'error: unknown option "--all" for images\n');
});
