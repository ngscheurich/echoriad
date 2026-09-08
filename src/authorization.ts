/**
 * Build-approval associations for automatic guest image builds.
 *
 * Authorization is an association between a consumer, a build-config
 * identity, a build fingerprint, and the Gondolin build ID that the
 * fingerprint resolves to. Associations live as cache metadata under
 * `${XDG_CACHE_HOME:-$HOME/.cache}/echoriad`; deleting the cache
 * revokes them. The identities themselves are derived in `identity.ts`.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Authorization metadata store
// ---------------------------------------------------------------------------
/** One stored authorization association. */
export type AuthorizationAssociation = {
  /** canonical consumer identity */
  consumer: string;
  /** build-config identity */
  config: string;
  /** full hex build fingerprint */
  fingerprint: string;
  /** Gondolin build ID the fingerprint resolved to */
  buildId: string;
};

const AUTHORIZATION_SCHEMA_VERSION = 1;

/** Echoriad cache directory: `${XDG_CACHE_HOME:-$HOME/.cache}/echoriad`. */
export function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.trim() !== "" && path.isAbsolute(xdg)) {
    return path.join(xdg, "echoriad");
  }
  return path.join(os.homedir(), ".cache", "echoriad");
}

/** Active authorization metadata file under the Echoriad cache directory. */
export function authorizationFilePath(): string {
  return path.join(cacheDir(), "image-authorizations.json");
}

function isAssociation(value: unknown): value is AuthorizationAssociation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.consumer === "string" &&
    typeof candidate.config === "string" &&
    typeof candidate.fingerprint === "string" &&
    typeof candidate.buildId === "string"
  );
}

/**
 * Parse the active metadata file. Throws on anything malformed so the
 * caller can move the file aside and continue with an empty state.
 */
function parseAuthorizations(raw: string): AuthorizationAssociation[] {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadata is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== AUTHORIZATION_SCHEMA_VERSION) {
    throw new Error(`unsupported metadata schema version ${String(record.version)}`);
  }
  if (!Array.isArray(record.associations)) {
    throw new Error('metadata field "associations" is not an array');
  }
  for (const entry of record.associations) {
    if (!isAssociation(entry)) {
      throw new Error("metadata contains a malformed association");
    }
  }
  return record.associations as AuthorizationAssociation[];
}

function serializeAuthorizations(associations: AuthorizationAssociation[]): string {
  return `${JSON.stringify({ version: AUTHORIZATION_SCHEMA_VERSION, associations }, null, 2)}\n`;
}

/**
 * Read the active authorization metadata.
 *
 * A missing file (for example after cache deletion) reads as empty without
 * a warning: deleting the cache revokes associations and causes later
 * approval prompts. Malformed metadata is moved aside with a warning and
 * also treated as empty.
 */
export function readAuthorizations(
  filePath: string,
  onWarning?: (message: string) => void,
): AuthorizationAssociation[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  try {
    return parseAuthorizations(raw);
  } catch (error) {
    const movedAside = `${filePath}.invalid-${Date.now()}`;
    let moved = false;
    try {
      fs.renameSync(filePath, movedAside);
      moved = true;
    } catch {
      // Keeping the malformed file in place still fails closed: the state
      // is treated as empty for this session.
    }
    onWarning?.(
      `Echoriad: the image build authorization metadata at ${filePath} ` +
        `is malformed (${error instanceof Error ? error.message : String(error)})` +
        (moved ? ` and has been moved aside to ${movedAside}` : " and could not be moved aside") +
        `; previous build approvals are treated as absent and will be ` +
        `requested again.`,
    );
    return [];
  }
}

export type AtomicWriteHooks = {
  /** Test seam: called with the temporary path after it is written. */
  onTempCreated?: (tempPath: string) => void;
};

/**
 * Replace `destPath` atomically. The replacement is a uniquely named
 * sibling file created exclusively with restrictive permissions, written
 * and closed, then renamed over the destination. Each writer removes only
 * its own temporary file (in a finally block); temporary files left behind
 * by crashed writers are never scanned or removed.
 */
export function writeFileAtomically(
  destPath: string,
  content: string,
  hooks?: AtomicWriteHooks,
): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(tempPath, "wx", 0o600);
  let closed = false;
  try {
    fs.writeFileSync(fd, content);
    fs.closeSync(fd);
    closed = true;
    hooks?.onTempCreated?.(tempPath);
    fs.renameSync(tempPath, destPath);
  } finally {
    if (!closed) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed or the descriptor is unusable; nothing to do.
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort: a leftover temporary file is inert.
    }
  }
}

/** Replace the whole authorization state with one atomic write. */
export function saveAssociations(filePath: string, associations: AuthorizationAssociation[]): void {
  writeFileAtomically(filePath, serializeAuthorizations(associations));
}

/**
 * Record one association, replacing any entry with the same consumer,
 * build-config identity, and fingerprint.
 *
 * The internal read-modify-write races with concurrent writers; the last
 * rename wins and may discard a newer association. That lost update is
 * accepted: it can cause a later approval prompt but never grants
 * authorization.
 */
export function saveAssociation(
  filePath: string,
  association: AuthorizationAssociation,
  onWarning?: (message: string) => void,
): void {
  const existing = readAuthorizations(filePath, onWarning);
  const kept = existing.filter(
    (entry) =>
      !(
        entry.consumer === association.consumer &&
        entry.config === association.config &&
        entry.fingerprint === association.fingerprint
      ),
  );
  saveAssociations(filePath, [...kept, association]);
}

/** The association matching one consumer, config, and fingerprint, if any. */
export function findAuthorizedAssociation(
  associations: AuthorizationAssociation[],
  consumerId: string,
  configId: string,
  fingerprint: string,
): AuthorizationAssociation | undefined {
  return associations.find(
    (entry) =>
      entry.consumer === consumerId &&
      entry.config === configId &&
      entry.fingerprint === fingerprint,
  );
}
