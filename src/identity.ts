/**
 * Consumer and build-config identity for automatic guest image builds.
 *
 * An authorization associates a consumer, a build-config identity, and a
 * build fingerprint. Identity rules (from
 * `.tracker/automatic-build-config/spec.md`):
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

import fs from "node:fs";
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

export type ConsumerIdentity = {
  /** canonical consumer identity for authorization metadata */
  consumerId: string;
  /** human-facing consumer label for the approval prompt */
  consumerLabel: string;
};

/**
 * The consumer identity of one project root, without a selected build
 * config: the canonical common Git directory for Git projects, the
 * canonical project root otherwise. This is the fallback consumer when
 * no build config is selected but prior associations still exist.
 */
export function deriveConsumerIdentity(projectRoot: string): ConsumerIdentity {
  const repository = discoverGitRepository(projectRoot);
  if (repository) {
    return {
      consumerId: `git:${repository.commonGitDir}`,
      consumerLabel: `Git repository (${repository.worktreeRoot})`,
    };
  }
  const root = canonicalize(projectRoot);
  return {
    consumerId: `root:${root}`,
    consumerLabel: `project (${root})`,
  };
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
  const { consumerId, consumerLabel } = deriveConsumerIdentity(input.projectRoot);
  // A non-Git project root doubles as the repository boundary, so a
  // project-local build config keeps a repository-relative identity.
  const repositoryRoot = repository?.worktreeRoot ?? canonicalize(input.projectRoot);
  const configId = isInside(repositoryRoot, configPath)
    ? `repo:${path.relative(repositoryRoot, configPath).split(path.sep).join(path.posix.sep)}`
    : `file:${configPath}`;
  return { consumerId, consumerLabel, configId };
}
