import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDurableRun,
  getDurableRunByTaskId,
  listDurableRuns,
  patchDurableRun,
  putDurableRun,
} from "../src/orchestration/run-store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("durable task run store", () => {
  it("persists allocation before task identity and binds it atomically later", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runs-"));
    directories.push(directory);
    const path = join(directory, "runs.json");
    const run = createDurableRun({
      invocationId: "invocation-1",
      correlationId: "user-label",
      projectDirectory: directory,
      claims: [{ kind: "write", resource: "src", mode: "exclusive" }],
    });
    await putDurableRun(path, run);
    await patchDurableRun(path, run.invocationId, {
      taskId: "task-1",
      executionPhase: "working",
    });

    const loaded = await getDurableRunByTaskId(path, "task-1");
    expect(loaded).toMatchObject({
      invocationId: "invocation-1",
      correlationId: "user-label",
      executionPhase: "working",
    });
    expect(await listDurableRuns(path)).toHaveLength(1);
  });

  it("rejects resurrection or rewriting of a terminal execution phase", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runs-"));
    directories.push(directory);
    const path = join(directory, "runs.json");
    const run = createDurableRun({ invocationId: "terminal", projectDirectory: directory });
    await putDurableRun(path, run);
    await patchDurableRun(path, run.invocationId, { executionPhase: "working" });
    await patchDurableRun(path, run.invocationId, { executionPhase: "completed" });
    await expect(
      patchDurableRun(path, run.invocationId, { executionPhase: "working" }),
    ).rejects.toThrow(/Invalid task execution transition/u);
    await expect(
      patchDurableRun(path, run.invocationId, { executionPhase: "failed" }),
    ).rejects.toThrow(/Invalid task execution transition/u);
  });

  it("keeps runtime identity immutable across patches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runs-"));
    directories.push(directory);
    const path = join(directory, "runs.json");
    const run = createDurableRun({ invocationId: "owner", projectDirectory: directory });
    await putDurableRun(path, run);
    await patchDurableRun(path, "owner", {
      invocationId: "forged",
      verificationPhase: "failed",
      verificationIssues: ["bad evidence"],
    });
    const [loaded] = await listDurableRuns(path);
    expect(loaded?.invocationId).toBe("owner");
    expect(loaded?.verificationIssues).toEqual(["bad evidence"]);
  });
});
