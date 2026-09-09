/**
 * Integration coverage for the images command's default wiring: a real
 * Gondolin-written store (via importImageFromDirectory and setImageRef)
 * and the real authorization file, driven through `main` with no injected
 * deps. The store and cache roots are redirected through the environment
 * variables the defaults read.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { importImageFromDirectory, setImageRef } from "@earendil-works/gondolin";
import { authorizationFilePath, saveAssociations } from "../src/authorization.ts";
import { main } from "../src/cli/index.ts";
import type { UiStream } from "../src/cli/ui.ts";
import { deriveConsumerIdentity } from "../src/identity.ts";

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

async function run(argv: string[]): Promise<{ exit: number; stdout: string }> {
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await main(argv, {
    stdout,
    stderr,
    env: {},
    isInteractive: false,
    loadSystemConfig: () => ({}),
  });
  return { exit, stdout: stdout.output() };
}

/** Minimal guest-asset directory Gondolin accepts for import. */
function makeAssets(): string {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-assets-"));
  for (const name of ["kernel", "initramfs", "rootfs"]) {
    fs.writeFileSync(path.join(assets, name), name);
  }
  fs.writeFileSync(
    path.join(assets, "manifest.json"),
    JSON.stringify({
      buildId: "12345678-1234-4abc-9abc-123456789012",
      config: { arch: "x86_64" },
      assets: { kernel: "kernel", initramfs: "initramfs", rootfs: "rootfs" },
    }),
  );
  return assets;
}

test("the default wiring lists and removes a real Gondolin store image", async (t) => {
  const previousStore = process.env.GONDOLIN_IMAGE_STORE;
  const previousCache = process.env.XDG_CACHE_HOME;
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-store-"));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-cache-"));
  process.env.GONDOLIN_IMAGE_STORE = storeDir;
  process.env.XDG_CACHE_HOME = cacheDir;
  const assets = makeAssets();
  t.after(() => {
    process.env.GONDOLIN_IMAGE_STORE = previousStore;
    process.env.XDG_CACHE_HOME = previousCache;
    for (const dir of [storeDir, cacheDir, assets]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const fingerprint = `ab${"c".repeat(62)}`;
  const imported = importImageFromDirectory(assets);
  setImageRef(`echoriad-build-${fingerprint}:latest`, imported.buildId, "x86_64");

  // Authorize the image for the consumer at cwd, as a real approval would.
  saveAssociations(authorizationFilePath(), [
    {
      consumer: deriveConsumerIdentity(process.cwd()).consumerId,
      config: "repo:build-config.json",
      fingerprint,
      buildId: imported.buildId,
    },
  ]);

  const listed = await run(["images", "--json"]);
  assert.equal(listed.exit, 0);
  const rows = JSON.parse(listed.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fingerprint, fingerprint);
  assert.equal(rows[0].buildId, imported.buildId);
  assert.equal(rows[0].authorized, true);

  const removed = await run(["images", "remove", "ab"]);
  assert.equal(removed.exit, 0);
  assert.match(removed.stdout, /removed image ref echoriad-build-ab[c]+:latest/);
  assert.match(removed.stdout, new RegExp(`deleted build object ${imported.buildId}`));

  const empty = await run(["images"]);
  assert.equal(empty.exit, 0);
  assert.equal(empty.stdout, "No Echoriad-built guest images.\n");
});
