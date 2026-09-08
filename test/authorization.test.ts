import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deriveBuildIdentity } from "../src/authorization.ts";

/**
 * Isolated git environment for tests: a private HOME (git refuses to run
 * some commands without one on some systems, and the test host may have no
 * usable HOME), no system config, and a fixed commit identity.
 */
function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-home-")),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Echoriad Test",
		GIT_AUTHOR_EMAIL: "echoriad-test@example.com",
		GIT_COMMITTER_NAME: "Echoriad Test",
		GIT_COMMITTER_EMAIL: "echoriad-test@example.com",
	};
}

const ENV = gitEnv();

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-repo-"));
	git(dir, ["init", "--initial-branch=main"]);
	fs.writeFileSync(path.join(dir, "file.txt"), "content\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "init"]);
	return dir;
}

test("a Git project's consumer identity is the canonical common git directory", () => {
	const repo = makeRepo();
	fs.writeFileSync(path.join(repo, "build-config.json"), "{}");
	const identity = deriveBuildIdentity({
		origin: "project",
		projectRoot: repo,
		configPath: path.join(repo, "build-config.json"),
	});
	const commonGitDir = fs.realpathSync(path.join(fs.realpathSync(repo), ".git"));
	assert.equal(identity.consumerId, `git:${commonGitDir}`);
	assert.equal(identity.configId, "repo:build-config.json");
});

test("a build config inside the repository is identified by repository-relative path", () => {
	const repo = makeRepo();
	fs.mkdirSync(path.join(repo, "configs"));
	fs.writeFileSync(path.join(repo, "configs", "guest.json"), "{}");
	// The project root may be a subdirectory of the repository; identity is
	// still relative to the repository (working-tree) root.
	const sub = path.join(repo, "sub");
	fs.mkdirSync(sub);
	const identity = deriveBuildIdentity({
		origin: "project",
		projectRoot: sub,
		configPath: path.join(repo, "configs", "guest.json"),
	});
	assert.equal(identity.configId, "repo:configs/guest.json");
	assert.match(identity.consumerLabel, /Git repository/);
});

test("linked worktrees share one consumer identity", () => {
	const main = makeRepo();
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-wt-"));
	git(main, ["worktree", "add", worktree, "-b", "linked"]);

	fs.writeFileSync(path.join(main, "build-config.json"), "{}");
	fs.writeFileSync(path.join(worktree, "build-config.json"), "{}");
	const fromMain = deriveBuildIdentity({
		origin: "project",
		projectRoot: main,
		configPath: path.join(main, "build-config.json"),
	});
	const fromWorktree = deriveBuildIdentity({
		origin: "project",
		projectRoot: worktree,
		configPath: path.join(worktree, "build-config.json"),
	});
	// The common git directory is shared, so authorization carries over.
	assert.equal(fromWorktree.consumerId, fromMain.consumerId);
	assert.equal(fromWorktree.configId, fromMain.configId);
});

test("separate clones remain separate consumers", () => {
	const main = makeRepo();
	const cloneA = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-clone-"));
	const cloneB = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-clone-"));
	git(main, ["clone", "--quiet", main, cloneA]);
	git(main, ["clone", "--quiet", main, cloneB]);
	fs.writeFileSync(path.join(cloneA, "build-config.json"), "{}");
	fs.writeFileSync(path.join(cloneB, "build-config.json"), "{}");
	const a = deriveBuildIdentity({
		origin: "project",
		projectRoot: cloneA,
		configPath: path.join(cloneA, "build-config.json"),
	});
	const b = deriveBuildIdentity({
		origin: "project",
		projectRoot: cloneB,
		configPath: path.join(cloneB, "build-config.json"),
	});
	assert.notEqual(a.consumerId, b.consumerId);
	// Same relative config path, but each clone authorizes independently.
	assert.equal(a.configId, b.configId);
});

test("a non-Git project's consumer identity is its canonical project root", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-proj-"));
	fs.writeFileSync(path.join(project, "build-config.json"), "{}");
	const identity = deriveBuildIdentity({
		origin: "project",
		projectRoot: project,
		configPath: path.join(project, "build-config.json"),
	});
	assert.equal(identity.consumerId, `root:${fs.realpathSync(project)}`);
	assert.equal(identity.configId, "repo:build-config.json");
	assert.match(identity.consumerLabel, /project/);
});

test("a build config outside the repository is identified by canonical absolute path", () => {
	const repo = makeRepo();
	const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-ext-"));
	const externalConfig = path.join(externalDir, "guest.json");
	fs.writeFileSync(externalConfig, "{}");
	const identity = deriveBuildIdentity({
		origin: "project",
		projectRoot: repo,
		configPath: externalConfig,
	});
	assert.equal(identity.configId, `file:${fs.realpathSync(externalConfig)}`);

	// Same for a config outside a non-Git project root.
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-proj-"));
	const identity2 = deriveBuildIdentity({
		origin: "project",
		projectRoot: project,
		configPath: externalConfig,
	});
	assert.equal(identity2.configId, `file:${fs.realpathSync(externalConfig)}`);
});

test("a system-selected build config is a system-wide consumer", () => {
	const repo = makeRepo();
	const configPath = path.join(repo, "build-config.json");
	fs.writeFileSync(configPath, "{}");
	const identity = deriveBuildIdentity({
		origin: "system",
		projectRoot: repo,
		configPath,
	});
	assert.equal(identity.consumerId, "system");
	assert.match(identity.consumerLabel, /system/);
	// A system-selected config keeps one identity regardless of the project.
	const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-x-"));
	const identity2 = deriveBuildIdentity({
		origin: "system",
		projectRoot: otherProject,
		configPath,
	});
	assert.deepEqual(identity2, identity);
});

// ---------------------------------------------------------------------------
// Authorization metadata store
// ---------------------------------------------------------------------------

import {
	type AuthorizationAssociation,
	authorizationFilePath,
	findAuthorizedAssociation,
	readAuthorizations,
	saveAssociation,
	saveAssociations,
	writeFileAtomically,
} from "../src/authorization.ts";

function tempCacheFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-cache-"));
	return path.join(dir, "image-authorizations.json");
}

function sampleAssociation(
	overrides: Partial<AuthorizationAssociation> = {},
): AuthorizationAssociation {
	return {
		consumer: "git:/repo/.git",
		config: "repo:build-config.json",
		fingerprint: "f".repeat(64),
		buildId: "build-1",
		...overrides,
	};
}

test("the authorization file lives under the Echoriad cache directory", () => {
	const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-xdg-"));
	const previous = process.env.XDG_CACHE_HOME;
	try {
		process.env.XDG_CACHE_HOME = xdg;
		assert.equal(authorizationFilePath(), path.join(xdg, "echoriad", "image-authorizations.json"));
	} finally {
		if (previous === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = previous;
	}
});

test("a deleted or missing cache file reads as an empty authorization state", () => {
	const file = tempCacheFile();
	assert.deepEqual(readAuthorizations(file), []);
});

test("saved associations round-trip and replace their own key", () => {
	const file = tempCacheFile();
	const first = sampleAssociation();
	const otherConsumer = sampleAssociation({ consumer: "git:/other/.git" });
	saveAssociation(file, first);
	saveAssociation(file, otherConsumer);
	assert.deepEqual(readAuthorizations(file), [first, otherConsumer]);

	// Re-saving the same (consumer, config, fingerprint) key replaces the
	// entry instead of duplicating it.
	const rebuilt = sampleAssociation({ buildId: "build-2" });
	saveAssociation(file, rebuilt);
	assert.deepEqual(readAuthorizations(file), [otherConsumer, rebuilt]);
});

test("findAuthorizedAssociation matches consumer, config, and fingerprint", () => {
	const assoc = sampleAssociation();
	const otherFingerprint = sampleAssociation({ fingerprint: "a".repeat(64) });
	const all = [assoc, otherFingerprint];
	assert.equal(
		findAuthorizedAssociation(all, "git:/repo/.git", "repo:build-config.json", "f".repeat(64)),
		assoc,
	);
	assert.equal(
		findAuthorizedAssociation(all, "git:/other/.git", "repo:build-config.json", "f".repeat(64)),
		undefined,
	);
	assert.equal(
		findAuthorizedAssociation(all, "git:/repo/.git", "file:/etc/guest.json", "f".repeat(64)),
		undefined,
	);
});

test("malformed metadata is moved aside with a warning and treated as empty", () => {
	const file = tempCacheFile();
	fs.writeFileSync(file, "{ not json");
	const warnings: string[] = [];
	const associations = readAuthorizations(file, (message) => warnings.push(message));
	assert.deepEqual(associations, []);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /malformed/);
	assert.match(warnings[0]!, /moved aside/);
	// The malformed file no longer sits at the active path.
	assert.equal(fs.existsSync(file), false);
	const movedAside = fs
		.readdirSync(path.dirname(file))
		.filter((name) => name.startsWith("image-authorizations.json.invalid-"));
	assert.equal(movedAside.length, 1);
	assert.equal(
		fs.readFileSync(path.join(path.dirname(file), movedAside[0]!), "utf8"),
		"{ not json",
	);
	// The store keeps working afterwards.
	const assoc = sampleAssociation();
	saveAssociation(file, assoc, () => {});
	assert.deepEqual(readAuthorizations(file), [assoc]);
});

test("structurally invalid metadata is moved aside too", () => {
	const file = tempCacheFile();
	fs.writeFileSync(file, JSON.stringify({ version: 1, associations: [{ consumer: 42 }] }));
	const warnings: string[] = [];
	assert.deepEqual(
		readAuthorizations(file, (message) => warnings.push(message)),
		[],
	);
	assert.equal(warnings.length, 1);
	assert.equal(fs.existsSync(file), false);
});

test("atomic writes use a restrictive exclusive temporary file and clean it up", () => {
	const file = tempCacheFile();
	const tempPaths: string[] = [];
	writeFileAtomically(file, "first", {
		onTempCreated: (tempPath) => {
			tempPaths.push(tempPath);
			// The temporary sibling is restrictive and uniquely named.
			const mode = fs.statSync(tempPath).mode & 0o777;
			assert.equal(mode, 0o600);
			assert.notEqual(tempPath, file);
			assert.equal(path.dirname(tempPath), path.dirname(file));
		},
	});
	assert.equal(tempPaths.length, 1);
	assert.equal(fs.readFileSync(file, "utf8"), "first");
	// No temporary file remains after a successful write.
	assert.equal(fs.readdirSync(path.dirname(file)).length, 1);

	writeFileAtomically(file, "second");
	assert.equal(fs.readFileSync(file, "utf8"), "second");
});

test("an interrupted write leaves the destination intact and removes only its own temporary file", () => {
	const file = tempCacheFile();
	writeFileAtomically(file, "original");
	// A crashed writer left a temporary file behind.
	const strayTemp = `${file}.tmp-crashed-1234`;
	fs.writeFileSync(strayTemp, "garbage");

	// This write dies between creating its temporary file and the rename.
	assert.throws(() =>
		writeFileAtomically(file, "interrupted", {
			onTempCreated: () => {
				throw new Error("simulated crash before rename");
			},
		}),
	);
	// The destination still holds the last complete write.
	assert.equal(fs.readFileSync(file, "utf8"), "original");
	// The writer cleaned its own temporary file, leaving only the crashed
	// writer's file behind (which this writer never scans or removes)...
	const remaining = fs.readdirSync(path.dirname(file));
	assert.deepEqual(
		remaining.filter(
			(name) =>
				name.startsWith("image-authorizations.json.tmp-") && name !== path.basename(strayTemp),
		),
		[],
	);
	// ...including the one left behind by the crashed writer.
	assert.ok(remaining.includes(path.basename(strayTemp)));
});

test("concurrent writers may lose each other's updates without corrupting the file", () => {
	const file = tempCacheFile();
	const assocA = sampleAssociation({ consumer: "git:/a/.git", buildId: "a" });
	const assocB = sampleAssociation({ consumer: "git:/b/.git", buildId: "b" });
	// Both writers snapshot the same (empty) state before either writes.
	const snapshotA = readAuthorizations(file);
	const snapshotB = readAuthorizations(file);
	// Writer A commits first; writer B commits from its stale snapshot, and
	// the last atomic rename wins: A's association is lost (the accepted
	// fail-closed lost update; a lost update can only cause a later prompt).
	saveAssociations(file, [...snapshotA, assocA]);
	saveAssociations(file, [...snapshotB, assocB]);
	const final = readAuthorizations(file);
	assert.deepEqual(final, [assocB]);
});
