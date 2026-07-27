import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContextPack, saveContextPack } from "../src/orchestration/context.ts";
import { appendOrchestrationEvent } from "../src/orchestration/telemetry.ts";
import { runOrchestrationDoctor } from "../src/orchestration/doctor.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-doctor-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
  await mkdir(join(directory, "package"), { recursive: true });
  await writeFile(
    join(directory, ".pi", "settings.json"),
    `${JSON.stringify({ packages: [] }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(directory, ".pi", "extensions", "task.ts"), "export {};\n", "utf8");
  await writeFile(
    join(directory, "package", "package.json"),
    `${JSON.stringify({ pi: { extensions: ["./dist/task-runtime.js"] } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, ".pi", "task-session-history.json"),
    "[]\n",
    "utf8",
  );
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const completeDelegationPrompt = `
Goal: Verify the task runtime.
Complete context: Current disk is authoritative.
Non-goals: Do not modify files.
Read/write policy: Strictly read-only.
Expected output: Findings with paths.
Stop condition: Every claim is adjudicated.
Verification recipe: Inspect current files and tests.
`;

describe("orchestration doctor", () => {
  it("returns stable healthy semantics for a complete contract", async () => {
    const projectDirectory = await createTemporaryProject();
    const result = await runOrchestrationDoctor({
      projectDirectory,
      delegationPrompt: completeDelegationPrompt,
      now: new Date("2026-07-19T01:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: true,
      status: "healthy",
      exitCode: 0,
      issues: [],
    });
  });

  it("accepts a governed-outcome contract without a verification recipe", async () => {
    const projectDirectory = await createTemporaryProject();
    const governedDelegationPrompt = `
Outcome: Callers observe a single lease owner per resource at all times.
Complete context: Current disk is authoritative.
Non-goals: Do not modify the store format.
Write/read policy: Strictly read-only.
Acceptance: Evidence that would convince a skeptic the invariant holds.
`;
    const result = await runOrchestrationDoctor({
      projectDirectory,
      delegationPrompt: governedDelegationPrompt,
      now: new Date("2026-07-19T01:00:00.000Z"),
    });

    expect(result).toEqual({
      ok: true,
      status: "healthy",
      exitCode: 0,
      issues: [],
    });
  });

  it("reports vague delegation, stale tasks, unresolved sessions, and valueless ceremony", async () => {
    const projectDirectory = await createTemporaryProject();
    const eventPath = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "orchestration",
      "events.jsonl",
    );
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_started",
        taskId: "task-stale",
        orchestrationId: "run-stale",
        timestamp: "2026-07-19T00:00:00.000Z",
      },
    });
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_resumed",
        taskId: "task-resumed-stale",
        orchestrationId: "run-resumed-stale",
        timestamp: "2026-07-19T00:00:00.000Z",
      },
    });
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_resumed",
        taskId: "task-retry",
        orchestrationId: "run-retry",
        timestamp: "2026-07-19T00:00:00.000Z",
        retryCount: 3,
      },
    });
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        taskId: "task-retry",
        orchestrationId: "run-retry",
        timestamp: "2026-07-19T00:01:00.000Z",
      },
    });
    await writeFile(
      join(projectDirectory, ".pi", "task-session-history.json"),
      `${JSON.stringify([
        {
          id: "task-missing-session",
          sessionName: "task-task-missing-session",
          status: "done",
        },
      ])}\n`,
      "utf8",
    );
    const staleContext = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Retain proof freshness",
        authorization: "read-only",
        evidence: [
          {
            description: "Old proof",
            reference: "command:old-check",
            recordedAt: "2026-07-18T23:00:00.000Z",
          },
        ],
        nextStep: "Refresh proof.",
      },
      now: new Date("2026-07-18T23:00:00.000Z"),
    });
    await saveContextPack({
      storeDirectory: join(
        projectDirectory,
        ".pi",
        "artifacts",
        "tasks",
        "orchestration",
        "contexts",
      ),
      key: "task-stale-evidence",
      pack: staleContext,
    });

    const result = await runOrchestrationDoctor({
      projectDirectory,
      delegationPrompt: "Goal: Do something.",
      ceremonySteps: [
        { name: "Ask for approval twice", uniqueValue: "" },
        { name: "Run focused tests", uniqueValue: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" },
      ],
      now: new Date("2026-07-19T01:00:00.000Z"),
      staleAfterMs: 30 * 60 * 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("issues");
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "delegation-contract-incomplete",
        "stale-task",
        "repeated-retries",
        "unresolved-task-session",
        "stale-evidence",
        "valueless-ceremony",
      ]),
    );
    expect(result.issues.filter((issue) => issue.code === "stale-task")).toHaveLength(
      2,
    );
  });

  it("flags ceremony steps whose uniqueValue is not a verifiable artifact or hash", async () => {
    const projectDirectory = await createTemporaryProject();
    const result = await runOrchestrationDoctor({
      projectDirectory,
      delegationPrompt: "Goal: Ship the feature.",
      ceremonySteps: [
        { name: "Descriptive only", uniqueValue: "Fresh behavior evidence" },
        { name: "Verifiable hash", uniqueValue: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" },
      ],
      now: new Date("2026-07-19T01:00:00.000Z"),
      staleAfterMs: 30 * 60 * 1_000,
    });
    const ceremony = result.issues.filter((issue) => issue.code === "valueless-ceremony");
    expect(ceremony).toHaveLength(1);
    expect(ceremony[0].severity).toBe("error");
    expect(ceremony[0].message).toContain("Descriptive only");
  });
});
