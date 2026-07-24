import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface WorktreeHandle {
  repositoryRoot: string;
  path: string;
  branch: string;
  baseSha: string;
  createdAt: string;
}

export interface WorktreeResult extends WorktreeHandle {
  changedPaths: string[];
  diffDigest: string;
  retained: boolean;
}

export function createTaskWorktree(input: {
  cwd: string;
  taskIdHint?: string;
  base?: string;
}): WorktreeHandle {
  const repositoryRoot = git(input.cwd, ["rev-parse", "--show-toplevel"]).trim();
  if (!repositoryRoot) {
    throw new Error("Worktree isolation requires a Git repository");
  }
  const dirty = git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty.trim()) {
    throw new Error(
      "Worktree isolation requires a clean source repository; commit or stash local changes first",
    );
  }
  const baseSha = git(repositoryRoot, [
    "rev-parse",
    "--verify",
    input.base ?? "HEAD",
  ]).trim();
  if (!baseSha) {
    throw new Error("Worktree isolation requires at least one Git commit");
  }

  const suffix = sanitize(input.taskIdHint ?? randomUUID()).slice(0, 32);
  const unique = randomUUID().slice(0, 8);
  const branch = `pi-subagents/${suffix || "task"}-${unique}`;
  const worktreeRoot = resolve(
    dirname(repositoryRoot),
    ".pi-subagents-worktrees",
    basename(repositoryRoot),
  );
  const path = join(worktreeRoot, `${suffix || "task"}-${unique}`);
  mkdirSync(worktreeRoot, { recursive: true });

  try {
    git(repositoryRoot, ["worktree", "add", "-b", branch, path, baseSha]);
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw new Error(
      `Could not create isolated Git worktree: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return {
    repositoryRoot,
    path,
    branch,
    baseSha,
    createdAt: new Date().toISOString(),
  };
}

export function inspectTaskWorktree(handle: WorktreeHandle): WorktreeResult {
  if (!existsSync(handle.path)) {
    throw new Error(`Task worktree no longer exists: ${handle.path}`);
  }
  const workingPaths = parseStatus(
    git(handle.path, ["status", "--porcelain=v1", "--untracked-files=all"]),
  );
  const committedPaths = git(handle.path, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--name-only",
    handle.baseSha,
    "--",
  ])
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter(Boolean);
  const changedPaths = [...new Set([...workingPaths, ...committedPaths])].sort();
  const hash = createHash("sha256");
  hash.update(handle.baseSha);
  hash.update("\0");
  hash.update(
    git(handle.path, ["diff", "--binary", "--no-ext-diff", handle.baseSha, "--"]),
  );
  for (const path of changedPaths) {
    hash.update("\0");
    hash.update(path);
    const absolutePath = join(handle.path, path);
    try {
      const stats = lstatSync(absolutePath);
      hash.update(stats.isSymbolicLink() ? readlinkSync(absolutePath) : readFileSync(absolutePath));
    } catch {
      hash.update("<deleted-or-unreadable>");
    }
  }
  return {
    ...handle,
    changedPaths,
    diffDigest: `sha256:${hash.digest("hex")}`,
    retained: changedPaths.length > 0,
  };
}

export function finalizeTaskWorktree(handle: WorktreeHandle): WorktreeResult {
  const result = inspectTaskWorktree(handle);
  if (result.changedPaths.length === 0) {
    removeTaskWorktree(handle, false);
    return { ...result, retained: false };
  }
  return { ...result, retained: true };
}

export function mergeTaskWorktree(
  handle: WorktreeHandle,
  message = `Merge delegated task ${handle.branch}`,
  expectedDiffDigest?: string,
): { commitSha: string; mergeSha: string; result: WorktreeResult } {
  let result = inspectTaskWorktree(handle);
  if (expectedDiffDigest && result.diffDigest !== expectedDiffDigest) {
    throw new Error("Worktree changed after its approved verification snapshot");
  }
  if (result.changedPaths.length === 0) {
    throw new Error("Cannot merge a worktree with no changed paths");
  }
  const sourceDirty = git(handle.repositoryRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (sourceDirty.trim()) {
    throw new Error(
      "Cannot merge while the source repository has uncommitted changes",
    );
  }
  const worktreeDirty = git(handle.path, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]).trim();
  if (worktreeDirty) {
    git(handle.path, ["add", "--all"]);
    git(handle.path, [
      "-c",
      "user.name=pi-subagents",
      "-c",
      "user.email=pi-subagents@localhost",
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
    ]);
  }
  const commitSha = git(handle.path, ["rev-parse", "HEAD"]).trim();
  result = inspectTaskWorktree(handle);
  if (expectedDiffDigest && result.diffDigest !== expectedDiffDigest) {
    throw new Error("Worktree changed while preparing its approved merge commit");
  }
  try {
    git(handle.repositoryRoot, [
      "-c",
      "user.name=pi-subagents",
      "-c",
      "user.email=pi-subagents@localhost",
      "merge",
      "--no-ff",
      "--no-gpg-sign",
      "-m",
      message,
      commitSha,
    ]);
  } catch (error) {
    try {
      git(handle.repositoryRoot, ["merge", "--abort"]);
    } catch {
      // Preserve the original merge error and retained task branch.
    }
    throw error;
  }
  const mergeSha = git(handle.repositoryRoot, ["rev-parse", "HEAD"]).trim();
  removeTaskWorktree(handle, true);
  return { commitSha, mergeSha, result: { ...result, retained: false } };
}

export function removeTaskWorktree(
  handle: WorktreeHandle,
  force = false,
): void {
  if (existsSync(handle.path)) {
    git(handle.repositoryRoot, [
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      handle.path,
    ]);
  }
  try {
    git(handle.repositoryRoot, ["branch", "-D", handle.branch]);
  } catch (error) {
    if (!force) throw error;
  }
  try {
    git(handle.repositoryRoot, ["worktree", "prune"]);
  } catch {
    // Pruning is best-effort after the owned worktree was removed.
  }
}

function parseStatus(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.length >= 4)
    .map((line) => {
      const raw = line.slice(3);
      const arrow = raw.lastIndexOf(" -> ");
      return (arrow === -1 ? raw : raw.slice(arrow + 4))
        .replace(/^"|"$/gu, "")
        .replaceAll("\\", "/");
    })
    .filter(Boolean)
    .sort();
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { stderr?: unknown };
  return typeof details.stderr === "string" && details.stderr.trim()
    ? details.stderr.trim()
    : error.message;
}
