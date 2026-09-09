/**
 * The `echoriad images` command: list and remove Echoriad-built guest
 * images in Gondolin's store.
 *
 * Listing goes through Gondolin's public ref listing and shows only refs
 * whose name is `echoriad-build-<fingerprint>` — the references Echoriad's
 * build pipeline creates. The `authorized` marker says the consumer at
 * the current project root can reuse the image without a new approval
 * prompt: an association exists whose fingerprint and build id both match
 * the image, so a same-fingerprint rebuild (stale build id) reads as not
 * authorized, exactly like the status verdict "needs approval".
 *
 * Removal manipulates Gondolin's on-disk store directly (Gondolin 0.12.0
 * ships no removal API) and is defended: a layout probe validates the
 * expected refs/<name>/<tag>/<arch> scheme and refuses on mismatch, the
 * `echoriad-build-` name check rejects anything else, and object
 * directories are deleted only after rescanning every ref (any arch) for
 * remaining targets, so objects shared with user-created refs survive.
 */

import fs from "node:fs";
import path from "node:path";
import {
  getImageStoreDirectory,
  type LocalImageRef,
  listImageRefs,
} from "@earendil-works/gondolin";
import {
  type AuthorizationAssociation,
  authorizationFilePath,
  readAuthorizations,
} from "../authorization.ts";
import { ECHORIAD_BUILD_IMAGE_PREFIX } from "../guest-image.ts";
import { deriveConsumerIdentity } from "../identity.ts";
import { CliError, type Ui } from "./ui.ts";

/** Dependency seam for the images command; defaults read live Gondolin state. */
export interface ImagesDeps {
  /** Gondolin's public listing of the image refs in its store. */
  listRefs(): LocalImageRef[];
  /** The Gondolin image store directory (`refs/` and `objects/` under it). */
  storeDir(): string;
  /** The active authorization associations. */
  authorizations(): AuthorizationAssociation[];
  /** The canonical consumer identity of the project at cwd. */
  consumerId(): string;
}

export function defaultImagesDeps(projectRoot: string): ImagesDeps {
  return {
    listRefs: () => listImageRefs(),
    storeDir: () => getImageStoreDirectory(),
    authorizations: () => readAuthorizations(authorizationFilePath()),
    consumerId: () => deriveConsumerIdentity(projectRoot).consumerId,
  };
}

/** One Echoriad-built image: one arch target of one `echoriad-build-` ref. */
export interface EchoriadImageRow {
  /** canonical image reference (`name:tag`) */
  readonly ref: string;
  /** full hex fingerprint (the name after the build prefix) */
  readonly fingerprint: string;
  /** first 12 hex characters of the fingerprint */
  readonly abbreviatedFingerprint: string;
  /** Gondolin build id backing the image */
  readonly buildId: string;
  /** image architecture */
  readonly arch: string;
  /** last-updated timestamp (ISO 8601) */
  readonly updatedAt: string;
  /** the current consumer may reuse this image without a new prompt */
  readonly authorized: boolean;
}

/** The name shape Echoriad's build pipeline creates refs with. */
const ECHORIAD_BUILD_REF_PATTERN = new RegExp(`^${ECHORIAD_BUILD_IMAGE_PREFIX}([0-9a-f]+)$`);

/**
 * The fingerprint an image ref name carries, or undefined when the ref was
 * not created by Echoriad's build pipeline.
 */
function refFingerprint(reference: string): string | undefined {
  const colon = reference.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const match = ECHORIAD_BUILD_REF_PATTERN.exec(reference.slice(0, colon));
  return match ? match[1] : undefined;
}

/** List the Echoriad-built images, one row per ref and arch target. */
function listEchoriadImages(deps: ImagesDeps): EchoriadImageRow[] {
  const consumerId = deps.consumerId();
  const associations = deps.authorizations();
  const rows: EchoriadImageRow[] = [];
  for (const listing of deps.listRefs()) {
    const fingerprint = refFingerprint(listing.reference);
    if (!fingerprint) continue;
    for (const [arch, buildId] of Object.entries(listing.targets)) {
      if (!buildId) continue;
      rows.push({
        ref: listing.reference,
        fingerprint,
        abbreviatedFingerprint: fingerprint.slice(0, 12),
        buildId,
        arch,
        updatedAt: listing.updatedAt,
        authorized: associations.some(
          (association) =>
            association.consumer === consumerId &&
            association.fingerprint === fingerprint &&
            association.buildId === buildId,
        ),
      });
    }
  }
  rows.sort(compareRows);
  return rows;
}

function compareRows(a: EchoriadImageRow, b: EchoriadImageRow): number {
  if (a.fingerprint !== b.fingerprint) return a.fingerprint < b.fingerprint ? -1 : 1;
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  return a.arch < b.arch ? -1 : 1;
}

/** Render the listing's human output; one line per row, columns aligned. */
function renderImagesList(rows: readonly EchoriadImageRow[]): string[] {
  if (rows.length === 0) return ["No Echoriad-built guest images."];
  const lines = [
    `${"FINGERPRINT".padEnd(12)}  ${"BUILD ID".padEnd(36)}  ${"ARCH".padEnd(7)}  ${"UPDATED".padEnd(24)}  AUTHORIZED`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.abbreviatedFingerprint}  ${row.buildId}  ${row.arch.padEnd(7)}  ` +
        `${row.updatedAt.padEnd(24)}  ${row.authorized ? "authorized" : "not authorized"}`,
    );
  }
  return lines;
}

/** Run the `echoriad images` command: list, or `remove` by reference. */
export function runImagesCommand(args: string[], ui: Ui, deps: ImagesDeps): void {
  if (args[0] === "remove") {
    runImagesRemove(args.slice(1), ui, deps);
    return;
  }
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) throw new CliError(`unknown option "${arg}" for images`);
    throw new CliError(`unknown images argument "${arg}"`);
  }
  const rows = listEchoriadImages(deps);
  if (json) {
    ui.line(JSON.stringify(rows, null, 2));
    return;
  }
  for (const line of renderImagesList(rows)) ui.line(line);
}

/** The ref layout Gondolin writes: refs/<name>/<tag>/<arch> symlinks. */
const REF_ARCHS = ["aarch64", "x86_64"];

/** Gondolin's build ids: lower-case UUIDs (version 4). */
const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The tag characters Gondolin accepts in an image reference. */
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The image ref an `images remove` argument names. */
interface RemoveTarget {
  name: string;
  tag: string;
}

function layoutError(at: string, detail: string): CliError {
  return new CliError(`unexpected image store layout at ${at}: ${detail}; refusing to remove`);
}

/** Whether `candidate` resolves strictly inside `root`. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolve the argument of `images remove`: a canonical `name:tag`, or a
 * fingerprint abbreviation that must match exactly one ref. The `name:tag`
 * form is only shape-validated here; existence is the layout probe's job.
 */
function resolveRemoveTarget(arg: string, storeDir: string): RemoveTarget {
  const colon = arg.lastIndexOf(":");
  if (colon > 0) {
    const name = arg.slice(0, colon);
    const tag = arg.slice(colon + 1);
    if (!name.startsWith(ECHORIAD_BUILD_IMAGE_PREFIX)) {
      throw new CliError(
        `"${arg}" is not an Echoriad-built image; images remove only removes ` +
          `image refs whose name starts with "${ECHORIAD_BUILD_IMAGE_PREFIX}"`,
      );
    }
    const fingerprint = name.slice(ECHORIAD_BUILD_IMAGE_PREFIX.length);
    if (!/^[0-9a-f]+$/.test(fingerprint) || !IMAGE_TAG_PATTERN.test(tag)) {
      throw new CliError(
        `"${arg}" is not an Echoriad-built image ref; expected the ` +
          `"${ECHORIAD_BUILD_IMAGE_PREFIX}<fingerprint>:<tag>" form`,
      );
    }
    return { name, tag };
  }
  if (/^[0-9a-f]+$/.test(arg)) {
    const candidates = echoriadRefCandidates(path.join(storeDir, "refs"), arg);
    if (candidates.length === 0) {
      throw new CliError(`no Echoriad-built image matches fingerprint abbreviation "${arg}"`);
    }
    if (candidates.length > 1) {
      throw new CliError(
        `fingerprint abbreviation "${arg}" matches ${candidates.length} image refs: ` +
          `${candidates.map((c) => `${c.name}:${c.tag}`).join(", ")}; ` +
          `pass the full name:tag instead`,
      );
    }
    return candidates[0];
  }
  throw new CliError(
    `"${arg}" is not an image reference; expected name:tag or a fingerprint ` +
      `abbreviation (lowercase hex)`,
  );
}

/** Every `echoriad-build-` ref (any tag) whose fingerprint starts with the abbreviation. */
function echoriadRefCandidates(refsRoot: string, abbreviation: string): RemoveTarget[] {
  if (!fs.existsSync(refsRoot)) return [];
  const candidates: RemoveTarget[] = [];
  for (const nameEntry of fs.readdirSync(refsRoot, { withFileTypes: true })) {
    if (!nameEntry.isDirectory()) continue;
    const match = ECHORIAD_BUILD_REF_PATTERN.exec(nameEntry.name);
    if (!match?.[1].startsWith(abbreviation)) continue;
    const tagRoot = path.join(refsRoot, nameEntry.name);
    for (const tagEntry of fs.readdirSync(tagRoot, { withFileTypes: true })) {
      if (tagEntry.isDirectory()) {
        candidates.push({ name: nameEntry.name, tag: tagEntry.name });
      }
    }
  }
  return candidates;
}

/**
 * Probe the layout of the ref being removed before anything is deleted:
 * the tag directory must exist and contain only arch-named symlinks that
 * target build-id-keyed directories inside the objects root. Returns the
 * object directories the ref's links point at (which may not exist — a
 * broken link is still removable).
 */
function probeRefLayout(tagDir: string, target: RemoveTarget, objectsRoot: string): string[] {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(tagDir);
  } catch {
    stat = undefined;
  }
  if (!stat) {
    throw new CliError(`no image ref "${target.name}:${target.tag}" in the Gondolin image store`);
  }
  if (!stat.isDirectory()) {
    throw layoutError(tagDir, "expected the tag path to be a directory");
  }
  const objectDirs: string[] = [];
  for (const entry of fs.readdirSync(tagDir, { withFileTypes: true })) {
    const entryPath = path.join(tagDir, entry.name);
    if (!REF_ARCHS.includes(entry.name) || !entry.isSymbolicLink()) {
      throw layoutError(entryPath, "expected an aarch64 or x86_64 symlink");
    }
    const raw = fs.readlinkSync(entryPath);
    const objectDir = path.resolve(path.dirname(entryPath), raw);
    if (!isInside(objectsRoot, objectDir) || !BUILD_ID_PATTERN.test(path.basename(objectDir))) {
      throw layoutError(
        entryPath,
        "expected a symlink into the objects directory keyed by build id",
      );
    }
    let objectStat: fs.Stats | undefined;
    try {
      objectStat = fs.lstatSync(objectDir);
    } catch {
      objectStat = undefined;
    }
    if (objectStat && !objectStat.isDirectory()) {
      throw layoutError(entryPath, "expected the ref link to target a directory");
    }
    objectDirs.push(objectDir);
  }
  return objectDirs;
}

/**
 * Delete the ref's links, then prune the now-empty name directories up to
 * the refs root (never the refs root itself).
 */
function deleteRefLinks(tagDir: string, refsRoot: string): void {
  for (const entry of fs.readdirSync(tagDir)) {
    fs.unlinkSync(path.join(tagDir, entry));
  }
  fs.rmdirSync(tagDir);
  let dir = path.dirname(tagDir);
  while (dir !== refsRoot && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

/**
 * Every object directory some ref under the refs root still targets, any
 * arch and any name — including refs Echoriad did not create. Returns
 * undefined when the scan cannot read an entry, so callers keep objects
 * rather than risk deleting one that is still referenced.
 */
function collectReferencedObjects(refsRoot: string, objectsRoot: string): Set<string> | undefined {
  const referenced = new Set<string>();
  if (!fs.existsSync(refsRoot)) return referenced;
  const queue: string[] = [refsRoot];
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      let raw: string;
      try {
        raw = fs.readlinkSync(entryPath);
      } catch {
        return undefined;
      }
      const resolved = path.resolve(path.dirname(entryPath), raw);
      if (isInside(objectsRoot, resolved)) referenced.add(resolved);
    }
  }
  return referenced;
}

function runImagesRemove(args: string[], ui: Ui, deps: ImagesDeps): void {
  const arg = args[0];
  if (arg === undefined || args.length !== 1) {
    throw new CliError(
      "images remove takes exactly one image reference: name:tag or a " +
        "fingerprint abbreviation",
    );
  }
  if (arg.startsWith("-")) {
    throw new CliError(`unknown option "${arg}" for images remove`);
  }
  const storeDir = deps.storeDir();
  const refsRoot = path.join(storeDir, "refs");
  const objectsRoot = path.join(storeDir, "objects");
  const target = resolveRemoveTarget(arg, storeDir);
  const tagDir = path.join(refsRoot, target.name, target.tag);

  const objectDirs = probeRefLayout(tagDir, target, objectsRoot);
  deleteRefLinks(tagDir, refsRoot);
  const remaining = collectReferencedObjects(refsRoot, objectsRoot);

  ui.line(`removed image ref ${target.name}:${target.tag}`);
  for (const objectDir of objectDirs) {
    const buildIdLabel = path.basename(objectDir);
    if (remaining === undefined) {
      ui.line(`kept build object ${buildIdLabel} (could not scan all refs)`);
      continue;
    }
    if (remaining.has(objectDir)) {
      ui.line(`kept build object ${buildIdLabel} (still referenced by another image ref)`);
      continue;
    }
    if (!fs.existsSync(objectDir)) continue;
    fs.rmSync(objectDir, { recursive: true });
    ui.line(`deleted build object ${buildIdLabel}`);
  }
}
