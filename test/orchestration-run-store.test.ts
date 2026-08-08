import { afterEach, describe, expect, it } from "vitest";
import { ORCHESTRATION_REASON_MAX_CHARS } from "../src/orchestration/reason-codes.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  completeDurableRun,
  createDurableRun,
  getDurableRunByTaskId,
  listDurableRuns,
  patchDurableRun,
  putDurableRun,
} from "../src/orchestration/run-store.ts";
import { taggedDigest } from "../src/learning-contract.ts";

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

  it("round-trips a bounded, redacted optional blocked reason code while accepting legacy runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runs-reason-code-"));
    directories.push(directory);
    const path = join(directory, "runs.json");
    const run = createDurableRun({ invocationId: "blocked", projectDirectory: directory });
    const blockedReason = `secret=super-secret ${"z".repeat(5_000)}`;
    await putDurableRun(path, run);
    await patchDurableRun(path, run.invocationId, {
      executionPhase: "blocked",
      blockedReason,
      blockedReasonCode: "CLAIM_LEASE_LOST",
    });

    const [stored] = await listDurableRuns(path);
    expect(stored).toEqual(
      expect.objectContaining({
        blockedReasonCode: "CLAIM_LEASE_LOST",
      }),
    );
    expect(stored?.blockedReason).toHaveLength(ORCHESTRATION_REASON_MAX_CHARS);
    expect(stored?.blockedReason).toContain("secret=[REDACTED]");
    expect(stored?.blockedReason).not.toContain("super-secret");
  });

  it("normalizes legacy single-repo runs to their control project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runs-legacy-workspace-"));
    directories.push(directory);
    const path = join(directory, "runs.json");
    const legacy = structuredClone(
      createDurableRun({ invocationId: "legacy-workspace", projectDirectory: directory }),
    ) as Record<string, unknown>;
    delete legacy.workspaceDirectory;
    await writeFile(path, JSON.stringify({ version: 1, runs: [legacy] }));

    const [loaded] = await listDurableRuns(path);

    expect(loaded?.workspaceDirectory).toBe(directory);
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

  it("claims terminal completion once and permits only an identical replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runs-"));
    directories.push(directory);
    const path = join(directory, "runs.json");
    const run = createDurableRun({ invocationId: "completion-cas", projectDirectory: directory });
    await putDurableRun(path, run);
    await patchDurableRun(path, run.invocationId, { executionPhase: "working" });
    const digest = taggedDigest({ outcome: "success" });
    const first = await completeDurableRun(path, run.invocationId, digest, {
      executionPhase: "completed",
      reportedOutcome: "success",
    });
    const replay = await completeDurableRun(path, run.invocationId, digest, {
      executionPhase: "completed",
      reportedOutcome: "success",
    });
    expect(replay).toEqual(first);
    await expect(
      completeDurableRun(path, run.invocationId, taggedDigest({ outcome: "failure" }), {
        executionPhase: "failed",
        reportedOutcome: "failure",
      }),
    ).rejects.toThrow(/Conflicting terminal result/u);
    await expect(putDurableRun(path, run)).rejects.toThrow(/Cannot overwrite terminal/u);
  });

  it("allows only one durable invocation for a decision-resume correlation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runs-"));
    directories.push(directory);
    const path = join(directory, "runs.json");
    const first = createDurableRun({
      invocationId: "resume-1",
      correlationId: "decision-resume:subject:decision",
      projectDirectory: directory,
    });
    const second = createDurableRun({
      invocationId: "resume-2",
      correlationId: first.correlationId,
      projectDirectory: directory,
    });
    await putDurableRun(path, first);
    await expect(putDurableRun(path, second)).rejects.toThrow(
      /already has a durable invocation/u,
    );
  });

  it("does not create or re-expose the legacy persisted semantic secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-runs-"));
    directories.push(directory);
    const path = join(directory, "runs.json");
    const run = createDurableRun({
      invocationId: "legacy-secret",
      projectDirectory: directory,
    });
    expect("semanticBindingKey" in run).toBe(false);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        runs: [{ ...run, semanticBindingKey: "must-not-leak" }],
      }),
      "utf8",
    );
    const [loaded] = await listDurableRuns(path);
    expect(loaded).toBeDefined();
    expect("semanticBindingKey" in (loaded as object)).toBe(false);
  });
});
