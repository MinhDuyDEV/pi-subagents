import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listTaskProvenance } from "../src/replay.ts";
import { getOrchestrationPaths } from "../src/orchestration/paths.ts";
import {
  createDurableRun,
  patchDurableRun,
  putDurableRun,
} from "../src/orchestration/run-store.ts";
import { taggedDigest } from "../src/learning-contract.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("task provenance replay boundary", () => {
  it("returns newest bounded task metadata without transcript or workspace paths", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "pi-task-provenance-"));
    directories.push(projectDirectory);
    const store = getOrchestrationPaths(projectDirectory).runStore;
    const older = createDurableRun({
      invocationId: "invocation-older",
      agentType: "reviewer",
      description: "Review the authentication migration",
      projectDirectory,
      startedAt: "2026-08-01T10:00:00.000Z",
    });
    const newer = createDurableRun({
      invocationId: "invocation-newer",
      agentType: "worker",
      description: `Implement bounded recall ${"x".repeat(2_000)}`,
      projectDirectory,
      startedAt: "2026-08-02T10:00:00.000Z",
    });
    await putDurableRun(store, older);
    await putDurableRun(store, newer);
    await patchDurableRun(store, older.invocationId, {
      taskId: "task-older",
      sessionReference: "/private/transcript/older.jsonl",
      executionPhase: "working",
    });
    await patchDurableRun(store, newer.invocationId, {
      taskId: "task-newer",
      sessionReference: "/private/transcript/newer.jsonl",
      executionPhase: "completed",
      reportedOutcome: "success",
      verificationPhase: "passed",
      reviewPhase: "accepted",
      resultDigest: taggedDigest({ result: "ok" }),
    });

    const entries = await listTaskProvenance({ projectDirectory, limit: 1 });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      version: 1,
      producer: "pi-subagents",
      taskId: "task-newer",
      invocationId: "invocation-newer",
      agentType: "worker",
      executionPhase: "completed",
      reportedOutcome: "success",
      verificationPhase: "passed",
      reviewPhase: "accepted",
    });
    expect(entries[0]?.description?.length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(entries[0])).not.toContain("/private/transcript");
    expect(JSON.stringify(entries[0])).not.toContain(projectDirectory);
  });

  it("excludes runs whose stored control root does not belong to the queried project", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "pi-task-provenance-owner-"));
    const foreignDirectory = await mkdtemp(join(tmpdir(), "pi-task-provenance-foreign-"));
    directories.push(projectDirectory, foreignDirectory);
    const store = getOrchestrationPaths(projectDirectory).runStore;
    await putDurableRun(store, createDurableRun({
      invocationId: "owned",
      description: "Owned task",
      projectDirectory,
    }));
    await putDurableRun(store, createDurableRun({
      invocationId: "foreign",
      description: "Injected foreign task",
      projectDirectory: foreignDirectory,
    }));

    const entries = await listTaskProvenance({ projectDirectory });

    expect(entries.map((entry) => entry.invocationId)).toEqual(["owned"]);
  });

  it("rejects unbounded query limits", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "pi-task-provenance-limit-"));
    directories.push(projectDirectory);

    await expect(listTaskProvenance({ projectDirectory, limit: 201 })).rejects.toThrow(/limit.*bounds/iu);
    await expect(listTaskProvenance({ projectDirectory, limit: 0 })).rejects.toThrow(/limit.*bounds/iu);
  });
});
