import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireResourceLease,
  type ResourceLease,
} from "../src/orchestration/claims.ts";
import {
  auditWriteClaims,
  changedPathsInRepository,
} from "../src/orchestration/write-claims.ts";
import { getOrchestrationPaths } from "../src/orchestration/paths.ts";
import {
  appendOrchestrationEvent,
  readOrchestrationEvents,
} from "../src/orchestration/telemetry.ts";
import {
  recordForegroundCompletion,
  type ActiveRun,
} from "../src/orchestration/completion.ts";
import { runOrchestrationDoctor } from "../src/orchestration/doctor.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-write-claims-"));
  temporaryDirectories.push(directory);
  return directory;
}

function initGitRepository(projectDirectory: string): void {
  execFileSync("git", ["init"], { cwd: projectDirectory, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: projectDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: projectDirectory,
    stdio: "ignore",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function acquireWriteLease(
  storePath: string,
  owner: string,
  resource: string,
): Promise<ResourceLease> {
  return acquireResourceLease({
    storePath,
    owner,
    claims: [{ kind: "write", resource, mode: "exclusive" }],
  });
}

describe("post-hoc write-claims audit", () => {
  it("flags a changed path outside the declared claims", async () => {
    const projectDirectory = await createTemporaryProject();
    initGitRepository(projectDirectory);
    const paths = getOrchestrationPaths(projectDirectory);
    const lease = await acquireWriteLease(
      paths.leaseStore,
      "orch-write-1",
      "claimed",
    );
    await mkdir(join(projectDirectory, "unclaimed"), { recursive: true });
    await writeFile(
      join(projectDirectory, "unclaimed", "b.ts"),
      "export const y = 2;\n",
      "utf8",
    );

    const audit = auditWriteClaims(lease, projectDirectory);

    expect(audit.valid).toBe(false);
    expect(audit.uncoveredPaths).toContain("unclaimed/b.ts");
    expect(audit.issues).toContain(
      "Write outside declared claims: unclaimed/b.ts",
    );
  });

  it("accepts a changed path inside the declared claims", async () => {
    const projectDirectory = await createTemporaryProject();
    initGitRepository(projectDirectory);
    const paths = getOrchestrationPaths(projectDirectory);
    const lease = await acquireWriteLease(
      paths.leaseStore,
      "orch-write-2",
      "claimed",
    );
    await mkdir(join(projectDirectory, "claimed"), { recursive: true });
    await writeFile(
      join(projectDirectory, "claimed", "a.ts"),
      "export const x = 1;\n",
      "utf8",
    );

    const audit = auditWriteClaims(lease, projectDirectory);

    expect(audit.valid).toBe(true);
    expect(audit.uncoveredPaths).toEqual([]);
  });

  it("returns valid when the project is not a git repository", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const lease = await acquireWriteLease(
      paths.leaseStore,
      "orch-write-3",
      "claimed",
    );

    const audit = auditWriteClaims(lease, projectDirectory);

    expect(audit.valid).toBe(true);
    expect(audit.uncoveredPaths).toEqual([]);
  });

  it("changedPathsInRepository lists untracked working-tree paths", async () => {
    const projectDirectory = await createTemporaryProject();
    initGitRepository(projectDirectory);
    await mkdir(join(projectDirectory, "src"), { recursive: true });
    await writeFile(
      join(projectDirectory, "src", "a.ts"),
      "export const a = 1;\n",
      "utf8",
    );

    const paths = changedPathsInRepository(projectDirectory);

    expect(paths).toContain("src/a.ts");
  });
});

describe("write-claims audit in foreground completion", () => {
  it("blocks completion when a write falls outside the lease claims", async () => {
    const projectDirectory = await createTemporaryProject();
    initGitRepository(projectDirectory);
    const paths = getOrchestrationPaths(projectDirectory);
    const lease = await acquireWriteLease(
      paths.leaseStore,
      "orch-comp-write",
      "claimed",
    );
    await mkdir(join(projectDirectory, "unclaimed"), { recursive: true });
    await writeFile(
      join(projectDirectory, "unclaimed", "b.ts"),
      "export const y = 2;\n",
      "utf8",
    );

    const run: ActiveRun = {
      orchestrationId: "orch-comp-write",
      taskId: "task-comp-write",
      startedAt: new Date().toISOString(),
      projectDirectory,
      lease,
    };

    const result = await recordForegroundCompletion(run, paths, {
      details: {
        phase: "done",
        worktree: { changedPaths: ["unclaimed/b.ts"] },
      },
    });

    expect(result?.valid).toBe(false);
    expect(result?.issues).toContain(
      "Write outside declared claims: unclaimed/b.ts",
    );

    const events = await readOrchestrationEvents(paths.eventLog);
    expect(
      events.some(
        (event) => event.type === "proof_failed" && event.taskId === run.taskId,
      ),
    ).toBe(true);
  });

  it("allows completion when writes stay inside the lease claims", async () => {
    const projectDirectory = await createTemporaryProject();
    initGitRepository(projectDirectory);
    const paths = getOrchestrationPaths(projectDirectory);
    const lease = await acquireWriteLease(
      paths.leaseStore,
      "orch-comp-ok",
      "claimed",
    );
    await mkdir(join(projectDirectory, "claimed"), { recursive: true });
    await writeFile(
      join(projectDirectory, "claimed", "a.ts"),
      "export const x = 1;\n",
      "utf8",
    );

    const run: ActiveRun = {
      orchestrationId: "orch-comp-ok",
      taskId: "task-comp-ok",
      startedAt: new Date().toISOString(),
      projectDirectory,
      lease,
    };

    const result = await recordForegroundCompletion(run, paths, {
      details: {
        phase: "done",
        worktree: { changedPaths: ["claimed/a.ts"] },
      },
    });

    expect(result).toBeUndefined();

    const events = await readOrchestrationEvents(paths.eventLog);
    expect(
      events.some(
        (event) =>
          event.type === "task_completed" && event.taskId === run.taskId,
      ),
    ).toBe(true);
  });
});

describe("doctor avoids shared-working-tree attribution", () => {
  it("does not blame one task for unrelated global dirty paths", async () => {
    const projectDirectory = await createTemporaryProject();
    initGitRepository(projectDirectory);
    const paths = getOrchestrationPaths(projectDirectory);
    const orchestrationId = "orch-doctor-write";
    const taskId = "task-doctor-write";
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: { type: "task_started", orchestrationId, taskId, prompt: "doctor" },
    });
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: { type: "task_completed", orchestrationId, taskId },
    });
    await acquireWriteLease(paths.leaseStore, orchestrationId, "claimed");
    await mkdir(join(projectDirectory, "unclaimed"), { recursive: true });
    await writeFile(
      join(projectDirectory, "unclaimed", "c.ts"),
      "export const z = 3;\n",
      "utf8",
    );

    const result = await runOrchestrationDoctor({ projectDirectory });

    const finding = result.issues.find(
      (issue) => issue.code === "unclaimed-write",
    );
    expect(finding).toBeUndefined();
  });
});