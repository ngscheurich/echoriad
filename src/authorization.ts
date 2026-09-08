/**
 * Consumer, build-config identity, and authorization metadata for
 * automatic guest image builds.
 *
 * Authorization is an association between a consumer, a build-config
 * identity, a build fingerprint, and the Gondolin build ID that the
 * fingerprint resolves to. Associations live as cache metadata under
 * `${XDG_CACHE_HOME:-$HOME/.cache}/echoriad`; deleting the cache
 * revokes them.
 *
 * Identity rules (from `.tracker/automatic-build-config/spec.md`):
 * - A Git project's consumer is the canonical common Git directory, so
 *   linked worktrees share authorization and separate clones stay
 *   separate.
 * - A non-Git project's consumer is its canonical project root (which
 *   doubles as the repository boundary for path identity).
 * - A build config inside the repository is identified by its
 *   repository-relative path; one outside is identified by its canonical
 *   absolute path.
 * - A system-selected build config has system-wide consumer scope.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Canonicalize a path: the real path with symlinks resolved when the path
 * exists, otherwise the best absolute resolution.
 */
function canonicalize(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export type GitRepository = {
	/** canonical working-tree root (the directory holding the .git entry) */
	worktreeRoot: string;
	/** canonical common Git directory shared by linked worktrees */
	commonGitDir: string;
};

/**
 * The common Git directory for a GitDir, following a `commondir` file when
 * one exists (linked worktrees keep their common dir there).
 */
function commonGitDirOf(gitDir: string): string {
	try {
		const raw = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
		if (raw !== "") return canonicalize(path.resolve(gitDir, raw));
	} catch {
		// No commondir file: the main worktree's git dir is its own common dir.
	}
	return gitDir;
}

/**
 * Discover the Git repository containing `startDir` by walking up to a
 * `.git` entry, without invoking git. Returns undefined for non-Git
 * projects.
 */
export function discoverGitRepository(startDir: string): GitRepository | undefined {
	let dir = canonicalize(startDir);
	for (;;) {
		const dotGit = path.join(dir, ".git");
		let stat: fs.Stats | undefined;
		try {
			// Follows a symlinked .git directory, matching git's behaviour.
			stat = fs.statSync(dotGit);
		} catch {
			stat = undefined;
		}
		if (stat?.isDirectory()) {
			return {
				worktreeRoot: dir,
				commonGitDir: commonGitDirOf(canonicalize(dotGit)),
			};
		}
		if (stat?.isFile()) {
			// A linked worktree keeps a `.git` file pointing at its git dir.
			let raw: string;
			try {
				raw = fs.readFileSync(dotGit, "utf8");
			} catch {
				return undefined;
			}
			const match = raw.match(/^gitdir:\s*(.+?)\s*$/m);
			if (!match) return undefined;
			const declared = match[1];
			const gitDir = canonicalize(
				path.isAbsolute(declared) ? declared : path.resolve(dir, declared),
			);
			return { worktreeRoot: dir, commonGitDir: commonGitDirOf(gitDir) };
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export type BuildIdentity = {
	/** canonical consumer identity for authorization metadata */
	consumerId: string;
	/** human-facing consumer label for the approval prompt */
	consumerLabel: string;
	/** build-config identity for authorization metadata */
	configId: string;
};

/**
 * Derive the consumer and build-config identity for one selected build
 * config, per the identity rules in the module docstring.
 */
export function deriveBuildIdentity(input: {
	origin: "project" | "system";
	projectRoot: string;
	configPath: string;
}): BuildIdentity {
	const configPath = canonicalize(input.configPath);

	// A build config selected by the system configuration has system-wide
	// consumer scope: every project shares one authorization.
	if (input.origin === "system") {
		return {
			consumerId: "system",
			consumerLabel: "system configuration",
			configId: `file:${configPath}`,
		};
	}

	const repository = discoverGitRepository(input.projectRoot);
	const consumerId = repository
		? `git:${repository.commonGitDir}`
		: `root:${canonicalize(input.projectRoot)}`;
	const consumerLabel = repository
		? `Git repository (${repository.worktreeRoot})`
		: `project (${canonicalize(input.projectRoot)})`;
	// A non-Git project root doubles as the repository boundary, so a
	// project-local build config keeps a repository-relative identity.
	const repositoryRoot = repository?.worktreeRoot ?? canonicalize(input.projectRoot);

	const configId = isInside(repositoryRoot, configPath)
		? `repo:${path.relative(repositoryRoot, configPath).split(path.sep).join(path.posix.sep)}`
		: `file:${configPath}`;
	return { consumerId, consumerLabel, configId };
}

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
				`is malformed (${(error as Error).message})` +
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
