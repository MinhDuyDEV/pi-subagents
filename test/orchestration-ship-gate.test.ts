import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendOrchestrationEvent,
  readOrchestrationEvents,
} from "../src/orchestration/telemetry.ts";
import { getOrchestrationPaths } from "../src/orchestration/paths.ts";
import { registerTaskControlTool } from "../src/orchestration/tool.ts";
import {
  recordForegroundCompletion,
  type ActiveRun,
} from "../src/orchestration/completion.ts";
import { runOrchestrationDoctor } from "../src/orchestration/doctor.ts";
import {
  createDurableRun,
  putDurableRun,
} from "../src/orchestration/run-store.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const temporaryDirectories: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-ship-gate-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, ".pi"), { recursive: true });
  await writeFile(join(directory, ".pi", "task-registry.json"), "[]\n");
  await writeFile(join(directory, ".pi", "task-session-history.json"), "[]\n");
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function createControlTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  const pi = {
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
  } as unknown as ExtensionAPI;
  registerTaskControlTool(pi);
  if (!tool) throw new Error("Task control tool was not registered");
  return tool;
}

function createContext(projectDirectory: string): ExtensionContext {
  return { cwd: projectDirectory, ui: { notify() {} } } as unknown as ExtensionContext;
}

const signal = new AbortController().signal;

async function seedCompletedTask(input: {
  projectDirectory: string;
  taskId: string;
  invocationId: string;
  agentType: string;
  verifier?: { required: boolean; reviewerAgent?: string; minReviews?: number };
}): Promise<void> {
  const { projectDirectory, taskId } = input;
  const paths = getOrchestrationPaths(projectDirectory);
  const sessionDirectory = join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "sessions",
    taskId,
  );
  await mkdir(sessionDirectory, { recursive: true });
  const sessionPath = join(sessionDirectory, `${taskId}.jsonl`);
  await writeFile(
    sessionPath,
    `${JSON.stringify({ type: "session", version: 3, id: taskId, cwd: projectDirectory })}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `result ${taskId}` }] } })}\n`,
  );
  const historyPath = join(projectDirectory, ".pi", "task-session-history.json");
  const history = JSON.parse(await (await import("node:fs/promises")).readFile(historyPath, "utf8")) as unknown[];
  history.push({
    id: taskId,
    taskId,
    agentType: input.agentType,
    description: taskId,
    sessionName: `task-${taskId}`,
    sessionRef: sessionPath,
    startedAt: Date.now(),
    piDir: join(projectDirectory, ".pi"),
    dir: join(projectDirectory, ".pi", "artifacts", "tasks"),
    status: "done",
    background: false,
  });
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);

  const run = createDurableRun({
    invocationId: input.invocationId,
    projectDirectory,
    agentType: input.agentType,
    verifier: input.verifier,
  });
  run.taskId = taskId;
  run.executionPhase = "completed";
  run.verificationPhase = "passed";
  run.reviewPhase = input.verifier?.required ? "awaiting" : "not-required";
  run.sessionReference = sessionPath;
  await putDurableRun(paths.runStore, run);
  await appendOrchestrationEvent({
    eventPath: paths.eventLog,
    event: {
      type: "task_execution_completed",
      orchestrationId: input.invocationId,
      taskId,
    },
  });
}

describe("independent ship gate", () => {
  it("blocks ship when there are zero independent reviews", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-subject",
      invocationId: "subject-invocation",
      agentType: "general",
      verifier: { required: true, reviewerAgent: "reviewer" },
    });

    const result = await tool.execute(
      "ship",
      { action: "ship", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(result.content[0]?.text).toContain("Pending independent review (0/1)");
    expect(result.details?.shipped).toBe(false);
  });

  it("ships only after a completed reviewer task reviews the current subject digest", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-subject",
      invocationId: "subject-invocation",
      agentType: "general",
      verifier: { required: true, reviewerAgent: "reviewer" },
    });
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-reviewer",
      invocationId: "reviewer-invocation",
      agentType: "reviewer",
    });

    await tool.execute(
      "review",
      {
        action: "review",
        task_id: "task-subject",
        reviewer_task_id: "task-reviewer",
        verdict: "approved",
      },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    const result = await tool.execute(
      "ship",
      { action: "ship", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(result.details?.shipped).toBe(true);
    const paths = getOrchestrationPaths(projectDirectory);
    const events = await readOrchestrationEvents(paths.eventLog);
    const review = events.find((event) => event.type === "task_reviewed");
    expect(review?.reviewerTaskId).toBe("task-reviewer");
    expect(review?.reviewerInvocationId).toBe("reviewer-invocation");
    expect(review?.subjectDigest).toMatch(/^sha256:/u);
  });

  it("rejects self-review and wrong reviewer profiles", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-subject",
      invocationId: "subject-invocation",
      agentType: "general",
      verifier: { required: true, reviewerAgent: "reviewer" },
    });

    await expect(
      tool.execute(
        "review",
        {
          action: "review",
          task_id: "task-subject",
          reviewer_task_id: "task-subject",
          verdict: "approved",
        },
        signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow(/cannot independently review itself/u);
  });

  it("records awaiting-review separately from execution and verification", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const durable = createDurableRun({
      invocationId: "foreground-invocation",
      projectDirectory,
      verifier: { required: true },
    });
    durable.taskId = "task-foreground";
    await putDurableRun(paths.runStore, durable);
    const run: ActiveRun = {
      invocationId: durable.invocationId,
      orchestrationId: durable.invocationId,
      taskId: "task-foreground",
      startedAt: new Date().toISOString(),
      projectDirectory,
      verifier: { required: true },
    };

    const proof = await recordForegroundCompletion(run, paths, {
      details: { phase: "done" },
    });
    expect(proof).toBeUndefined();
    const events = await readOrchestrationEvents(paths.eventLog);
    expect(events.some((event) => event.type === "task_execution_completed")).toBe(true);
    expect(events.some((event) => event.type === "task_awaiting_review")).toBe(true);
    expect(events.some((event) => event.type === "task_failed")).toBe(false);
  });

  it("doctor reports unverified ship state", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: "task_ship_blocked",
        orchestrationId: "subject-invocation",
        taskId: "task-subject",
        reason: "Pending independent review (0/1)",
      },
    });
    const result = await runOrchestrationDoctor({ projectDirectory });
    expect(result.issues.some((issue) => issue.code === "unverified-ship")).toBe(true);
  });
});
