import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTaskWorktree,
  finalizeTaskWorktree,
  inspectTaskWorktree,
  mergeTaskWorktree,
  removeTaskWorktree,
} from "../src/worktree.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-worktree-test-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  return root;
}

describe("task worktree isolation", () => {
  it("retains changed worktrees with base, branch, paths, and digest provenance", async () => {
    const root = await repository();
    const handle = createTaskWorktree({ cwd: root, taskIdHint: "writer" });
    await writeFile(join(handle.path, "feature.ts"), "export const value = 1;\n");
    const result = finalizeTaskWorktree(handle);
    expect(result.retained).toBe(true);
    expect(result.changedPaths).toContain("feature.ts");
    expect(result.diffDigest).toMatch(/^sha256:/u);
    expect(existsSync(handle.path)).toBe(true);
    removeTaskWorktree(handle, true);
  });

  it("automatically removes unchanged worktrees", async () => {
    const root = await repository();
    const handle = createTaskWorktree({ cwd: root, taskIdHint: "reader" });
    const result = finalizeTaskWorktree(handle);
    expect(result.retained).toBe(false);
    expect(existsSync(handle.path)).toBe(false);
  });

  it("refuses to omit dirty source changes from an isolated base", async () => {
    const root = await repository();
    await writeFile(join(root, "README.md"), "dirty\n");
    expect(() => createTaskWorktree({ cwd: root, taskIdHint: "unsafe" })).toThrow(
      /clean source repository/u,
    );
  });

  it("retains committed child changes and merges them explicitly", async () => {
    const root = await repository();
    const handle = createTaskWorktree({ cwd: root, taskIdHint: "committer" });
    await writeFile(join(handle.path, "committed.ts"), "export const committed = true;\n");
    git(handle.path, ["add", "."]);
    git(handle.path, ["commit", "-qm", "child commit"]);

    const inspected = inspectTaskWorktree(handle);
    expect(inspected.changedPaths).toContain("committed.ts");
    const merged = mergeTaskWorktree(handle, "Merge tested child");
    expect(merged.mergeSha).toBe(git(root, ["rev-parse", "HEAD"]).trim());
    expect(existsSync(join(root, "committed.ts"))).toBe(true);
    expect(existsSync(handle.path)).toBe(false);
  });
});
