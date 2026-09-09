import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, type TestContext, test } from "node:test";
import { deriveBuildIdentity, deriveConsumerIdentity } from "../src/identity.ts";

/**
 * Isolated git environment for tests: a private HOME (git refuses to run
 * some commands without one on some systems, and the test host may have no
 * usable HOME), no system config, and a fixed commit identity.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-home-"));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME,
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

function makeRepo(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-repo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "--initial-branch=main"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "content\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

test("deriveConsumerIdentity carries the consumer half of build identity", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-root-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "build-config.json"), "{}");

  const consumer = deriveConsumerIdentity(dir);
  const identity = deriveBuildIdentity({
    origin: "project",
    projectRoot: dir,
    configPath: path.join(dir, "build-config.json"),
  });
  assert.equal(consumer.consumerId, identity.consumerId);
  assert.equal(consumer.consumerLabel, identity.consumerLabel);
  assert.equal(consumer.consumerId, `root:${fs.realpathSync(dir)}`);
});

test("a Git project's consumer identity is the canonical common git directory", (t) => {
  const repo = makeRepo(t);
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

test("a build config inside the repository is identified by repository-relative path", (t) => {
  const repo = makeRepo(t);
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

test("linked worktrees share one consumer identity", (t) => {
  const main = makeRepo(t);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-wt-"));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
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

test("separate clones remain separate consumers", (t) => {
  const main = makeRepo(t);
  const cloneA = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-clone-"));
  t.after(() => fs.rmSync(cloneA, { recursive: true, force: true }));
  const cloneB = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-clone-"));
  t.after(() => fs.rmSync(cloneB, { recursive: true, force: true }));
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

test("deriveConsumerIdentity identifies a Git project by its common git directory", (t) => {
  const repo = makeRepo(t);
  const identity = deriveConsumerIdentity(repo);
  const commonGitDir = fs.realpathSync(path.join(fs.realpathSync(repo), ".git"));
  assert.equal(identity.consumerId, `git:${commonGitDir}`);
  assert.match(identity.consumerLabel, /Git repository/);
});

test("deriveConsumerIdentity identifies a non-Git project by its canonical root", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-proj-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const identity = deriveConsumerIdentity(project);
  assert.equal(identity.consumerId, `root:${fs.realpathSync(project)}`);
  assert.match(identity.consumerLabel, /project/);
});

test("a non-Git project's consumer identity is its canonical project root", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-proj-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
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

test("a build config outside the repository is identified by canonical absolute path", (t) => {
  const repo = makeRepo(t);
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "echoriad-auth-ext-"));
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
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
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const identity2 = deriveBuildIdentity({
    origin: "project",
    projectRoot: project,
    configPath: externalConfig,
  });
  assert.equal(identity2.configId, `file:${fs.realpathSync(externalConfig)}`);
});

test("a system-selected build config is a system-wide consumer", (t) => {
  const repo = makeRepo(t);
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
  t.after(() => fs.rmSync(otherProject, { recursive: true, force: true }));
  const identity2 = deriveBuildIdentity({
    origin: "system",
    projectRoot: otherProject,
    configPath,
  });
  assert.deepEqual(identity2, identity);
});
