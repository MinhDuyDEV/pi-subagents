import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { acquireResourceLease } from "../src/orchestration/claims.ts";
import {
  buildContextPack,
  loadContextPack,
  saveContextPack,
} from "../src/orchestration/context.ts";
import { getOrchestrationPaths } from "../src/orchestration/paths.ts";
import { registerTaskControlTool } from "../src/orchestration/tool.ts";
import {
  appendOrchestrationEvent,
  readOrchestrationEvents,
} from "../src/orchestration/telemetry.ts";
import {
  createDurableRun,
  getDurableRunByTaskId,
  putDurableRun,
} from "../src/orchestration/run-store.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-tool-"));
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
  await writeFile(join(directory, ".pi", "task-session-history.json"), "[]\n", "utf8");
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function createTaskControlTool(
  emit?: (event: string, payload: unknown) => unknown,
): ToolDefinition<TSchema, unknown> {
  let tool: ToolDefinition<TSchema, unknown> | undefined;
  const pi = {
    registerTool(definition: ToolDefinition<TSchema, unknown>) {
      tool = definition;
    },
    ...(emit
      ? {
          events: {
            emit,
          },
        }
      : {}),
  } as unknown as ExtensionAPI;
  registerTaskControlTool(pi);
  if (!tool) {
    throw new Error("task_control tool was not registered");
  }
  return tool;
}

function createContext(projectDirectory: string): ExtensionContext {
  return {
    cwd: projectDirectory,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

async function createSessionWithFinalText(
  projectDirectory: string,
  taskId: string,
  finalText: string,
): Promise<void> {
  const sessionDirectory = join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "sessions",
    taskId,
  );
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    join(sessionDirectory, "timestamp.jsonl"),
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "tool-session-id",
        cwd: projectDirectory,
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
        },
      }),
    ].join("\n"),
    "utf8",
  );
}

describe("task_control orchestration tool", () => {
  it("atomically resolves a decision so duplicate responses cannot resume twice", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const run = createDurableRun({
      invocationId: "decision-invocation",
      projectDirectory,
      description: "Wait for a parent decision",
    });
    run.taskId = "task-decision";
    run.executionPhase = "completed";
    run.reportedOutcome = "awaiting-decision";
    run.decisionRequest = {
      id: "decision-1",
      question: "Which path?",
      options: [
        { id: "a", label: "Path A" },
        { id: "b", label: "Path B" },
      ],
      requestedAt: "2026-07-27T00:00:00.000Z",
      requestDigest: `sha256:v1:${"a".repeat(64)}`,
      status: "pending",
    };
    await putDurableRun(paths.runStore, run);

    const emitted: string[] = [];
    const tool = createTaskControlTool((event) => {
      emitted.push(event);
    });
    const input = {
      action: "respond" as const,
      task_id: "task-decision",
      decision_id: "decision-1",
      decision_option_id: "a",
      decision_response: "Choose path A.",
    };
    const [first, duplicate] = await Promise.all([
      tool.execute("respond-1", input, new AbortController().signal, undefined, createContext(projectDirectory)),
      tool.execute("respond-2", input, new AbortController().signal, undefined, createContext(projectDirectory)),
    ]);

    expect([first.details?.status, duplicate.details?.status].sort()).toEqual([
      "already-resolved",
      "resolved",
    ]);
    const events = await readOrchestrationEvents(paths.eventLog);
    expect(events.filter((event) => event.type === "decision_responded")).toHaveLength(1);
    expect(
      emitted.filter((event) => event === "pi-subagents:decision-response"),
    ).toHaveLength(1);
    const stored = await getDurableRunByTaskId(paths.runStore, "task-decision");
    expect(stored?.decisionRequest).toMatchObject({
      status: "resolved",
      response: { optionId: "a", response: "Choose path A." },
    });
  });

  it("retries the durable decision outbox after a resume listener failure", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const run = createDurableRun({
      invocationId: "decision-retry-invocation",
      projectDirectory,
    });
    run.taskId = "task-decision-retry";
    run.executionPhase = "completed";
    run.reportedOutcome = "awaiting-decision";
    run.decisionRequest = {
      id: "decision-retry",
      question: "Retry dispatch?",
      options: [{ id: "yes", label: "Yes" }],
      requestedAt: "2026-07-27T00:00:00.000Z",
      requestDigest: `sha256:v1:${"c".repeat(64)}`,
      status: "pending",
    };
    await putDurableRun(paths.runStore, run);

    let resumeAttempts = 0;
    const tool = createTaskControlTool((event) => {
      if (event !== "pi-subagents:decision-response") return;
      resumeAttempts += 1;
      if (resumeAttempts === 1) {
        throw new Error("injected listener failure");
      }
    });
    const input = {
      action: "respond" as const,
      task_id: "task-decision-retry",
      decision_id: "decision-retry",
      decision_option_id: "yes",
      decision_response: "Retry safely.",
    };

    await expect(
      tool.execute(
        "respond-failing",
        input,
        new AbortController().signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow(/recorded, but its task resume failed/u);
    expect(
      (
        await getDurableRunByTaskId(
          paths.runStore,
          "task-decision-retry",
        )
      )?.decisionRequest?.response,
    ).toMatchObject({
      resumeState: "failed",
      resumeError: "injected listener failure",
    });

    const retried = await tool.execute(
      "respond-retry",
      input,
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    expect(retried.details?.status).toBe("resolved");
    expect(resumeAttempts).toBe(2);
    const events = await readOrchestrationEvents(paths.eventLog);
    expect(
      events.filter((event) => event.type === "decision_responded"),
    ).toHaveLength(1);
  });

  it("never takes over an in-flight dispatch merely because thirty seconds elapsed", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const decisionId = "decision-still-dispatching";
    const response = "Continue exactly once.";
    const responseDigest = `sha256:v1:${createHash("sha256")
      .update(JSON.stringify({ decisionId, optionId: null, response }))
      .digest("hex")}` as const;
    const run = createDurableRun({
      invocationId: "decision-stale-window",
      projectDirectory,
    });
    run.taskId = "task-stale-window";
    run.executionPhase = "completed";
    run.reportedOutcome = "awaiting-decision";
    run.decisionRequest = {
      id: decisionId,
      question: "Continue?",
      options: [],
      requestedAt: "2026-07-27T00:00:00.000Z",
      requestDigest: `sha256:v1:${"d".repeat(64)}`,
      status: "resolved",
      response: {
        response,
        respondedAt: "2026-07-27T00:01:00.000Z",
        responseDigest,
        resumeCorrelationId: `decision-resume:${run.invocationId}:${decisionId}`,
        resumeState: "dispatching",
        resumeAttemptId: "still-owned",
        resumeDispatchStartedAt: "2026-07-27T00:01:00.000Z",
      },
    };
    await putDurableRun(paths.runStore, run);
    const emitted: string[] = [];
    const tool = createTaskControlTool((event) => emitted.push(event));
    const result = await tool.execute(
      "respond-stale-window",
      {
        action: "respond",
        task_id: run.taskId,
        decision_id: decisionId,
        decision_response: response,
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    expect(result.details?.status).toBe("already-resolved");
    expect(emitted).not.toContain("pi-subagents:decision-response");
  });

  it("keeps caller-recorded evidence distinct from runtime receipts", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const run = createDurableRun({
      invocationId: "receipt-invocation",
      projectDirectory,
      description: "Receipt subject",
      claims: [{ kind: "evidence", resource: "focused-test", mode: "exclusive" }],
    });
    run.taskId = "task-receipt";
    run.executionPhase = "working";
    await putDurableRun(paths.runStore, run);
    await writeFile(join(projectDirectory, "test.log"), "all tests passed\n", "utf8");

    const result = await createTaskControlTool().execute(
      "record-receipt",
      {
        action: "record_evidence",
        task_id: "task-receipt",
        evidence_kind: "test",
        evidence_description: "Focused tests pass",
        evidence_reference: "test.log",
        evidence_claim: "Focused tests pass",
        evidence_exit_code: 0,
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Recorded immutable evidence"),
    });
    const pack = await loadContextPack({
      storeDirectory: paths.contextStore,
      key: "task-receipt",
    });
    expect(pack?.evidence[0]).toMatchObject({
      reference: "test.log",
      source: "declared",
      receiptKind: "test",
      exitCode: 0,
      receiptId: expect.any(String),
      sha256: expect.stringMatching(/^sha256:/u),
    });
  });

  it("returns canonical status and final result for a completed task", async () => {
    const projectDirectory = await createTemporaryProject();
    const taskId = "task-complete";
    const sessionName = `task-${taskId}`;
    const sessionDirectory = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "sessions",
      taskId,
    );
    const sessionPath = join(sessionDirectory, "timestamp.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "tool-session-id",
          cwd: projectDirectory,
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "verified final result" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectDirectory, ".pi", "task-session-history.json"),
      `${JSON.stringify([
        { id: taskId, sessionName, status: "completed", description: "Done" },
      ])}\n`,
      "utf8",
    );

    const tool = createTaskControlTool();
    const status = await tool.execute(
      "status-call",
      { action: "status", task_id: taskId },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    const result = await tool.execute(
      "result-call",
      { action: "result", task_id: taskId },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(status.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Status: completed"),
    });
    expect(status.content[0]).toMatchObject({
      text: expect.stringContaining(sessionPath),
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "verified final result",
    });
  });

  it("surfaces a claim-not-proven message for write-approved tasks when evidence-only proof fails", async () => {
    const projectDirectory = await createTemporaryProject();
    const taskId = "task-write-claim-unproven";
    const sessionName = `task-${taskId}`;
    const paths = getOrchestrationPaths(projectDirectory);
    const completedAt = new Date("2026-07-19T01:00:00.000Z");

    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Ship the change.",
        authorization: "write-approved",
        nextStep: "Run the build.",
      },
    });
    await saveContextPack({
      storeDirectory: paths.contextStore,
      key: taskId,
      pack,
    });
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: "task_completed",
        taskId,
        orchestrationId: "orch-write-claim-unproven",
        timestamp: completedAt.toISOString(),
      },
    });
    await createSessionWithFinalText(
      projectDirectory,
      taskId,
      "Claimed completion.",
    );
    await writeFile(
      join(projectDirectory, ".pi", "task-session-history.json"),
      `${JSON.stringify([
        { id: taskId, sessionName, status: "completed", description: "Done" },
      ])}\n`,
      "utf8",
    );

    const tool = createTaskControlTool();
    const result = await tool.execute(
      "result-call",
      { action: "result", task_id: taskId },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Claim not proven by evidence"),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("No completion evidence was provided"),
    });
  });

  it("returns a child-reported failure result without applying the success proof gate", async () => {
    const projectDirectory = await createTemporaryProject();
    const taskId = "task-review-findings";
    const sessionName = `task-${taskId}`;
    const paths = getOrchestrationPaths(projectDirectory);
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Review the change.",
        authorization: "read-only",
        nextStep: "Report blocking findings.",
      },
    });
    await saveContextPack({ storeDirectory: paths.contextStore, key: taskId, pack });
    const run = createDurableRun({
      invocationId: "review-findings-invocation",
      projectDirectory,
      contextPack: pack,
    });
    run.taskId = taskId;
    run.executionPhase = "completed";
    run.reportedOutcome = "failure";
    run.verificationPhase = "failed";
    run.verificationIssues = ["Child reported non-success outcome: failure"];
    await putDurableRun(paths.runStore, run);
    await createSessionWithFinalText(
      projectDirectory,
      taskId,
      "Do not ship: path traversal is still possible.",
    );
    await writeFile(
      join(projectDirectory, ".pi", "task-session-history.json"),
      `${JSON.stringify([
        { id: taskId, sessionName, status: "completed", description: "Review done" },
      ])}\n`,
      "utf8",
    );

    const result = await createTaskControlTool().execute(
      "result-call",
      { action: "result", task_id: taskId },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Do not ship: path traversal is still possible.",
    });
  });

  it("does not accept a session-authored artifact as runtime proof", async () => {
    const projectDirectory = await createTemporaryProject();
    const taskId = "task-write-claim-proven";
    const sessionName = `task-${taskId}`;
    const paths = getOrchestrationPaths(projectDirectory);
    const completedAt = new Date("2026-07-19T01:00:00.000Z");

    // Evidence references an existing file and is fresh relative to completion.
    await writeFile(join(projectDirectory, "build.log"), "build passed\n", "utf8");
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Ship the change.",
        authorization: "write-approved",
        nextStep: "Run the build.",
        evidence: [
          {
            description: "Build log confirms the change compiles.",
            reference: "build.log",
            recordedAt: completedAt.toISOString(),
            source: "runtime-session",
          },
        ],
      },
    });
    await saveContextPack({
      storeDirectory: paths.contextStore,
      key: taskId,
      pack,
    });
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: "task_completed",
        taskId,
        orchestrationId: "orch-write-claim-proven",
        timestamp: completedAt.toISOString(),
      },
    });
    await createSessionWithFinalText(
      projectDirectory,
      taskId,
      "verified final result",
    );
    await writeFile(
      join(projectDirectory, ".pi", "task-session-history.json"),
      `${JSON.stringify([
        { id: taskId, sessionName, status: "completed", description: "Done" },
      ])}\n`,
      "utf8",
    );

    const tool = createTaskControlTool();
    const result = await tool.execute(
      "result-call",
      { action: "result", task_id: taskId },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Claim not proven by evidence"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("runtime-generated receipt"),
    });
  });

  it("updates handoff state and releases a resource lease", async () => {
    const projectDirectory = await createTemporaryProject();
    const root = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "orchestration",
    );
    const contextStore = join(root, "contexts");
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Finish the runtime",
        authorization: "write-approved",
        nextStep: "Wire the tool.",
      },
    });
    await saveContextPack({ storeDirectory: contextStore, key: "task-handoff", pack });
    const lease = await acquireResourceLease({
      storePath: join(root, "leases.json"),
      owner: "task-handoff",
      claims: [{ kind: "write", resource: "package/src", mode: "exclusive" }],
    });
    const run = createDurableRun({
      invocationId: "handoff-invocation",
      projectDirectory,
      lease,
      contextPack: pack,
    });
    run.taskId = "task-handoff";
    run.executionPhase = "working";
    await putDurableRun(getOrchestrationPaths(projectDirectory).runStore, run);

    const tool = createTaskControlTool();
    const handoff = await tool.execute(
      "handoff-call",
      {
        action: "handoff",
        task_id: "task-handoff",
        handoff: {
          version: 1,
          kind: "handoff",
          recordId: "handoff-runtime-1",
          title: "Runtime handoff",
          receiver: "agent",
          goal: "Finish the runtime",
          currentState: "The canonical runtime is wired.",
          verified: ["The orchestration context is durable."],
          unknowns: ["Whether parity tests expose another edge case."],
          realConstraints: ["Keep one canonical runtime."],
          relevantFiles: ["src/orchestration/runtime.ts"],
          closedDecisions: ["Use the canonical runtime."],
          openDecisions: ["None."],
          existingEvidence: ["Typecheck passes."],
          expectedDeliverable: "A verified runtime.",
          permissions: ["May edit pi-subagents."],
          antiPatterns: ["Do not fork another runtime."],
          nextStep: "Run parity tests.",
          resumeKeys: { taskId: "task-handoff" },
          recordedAt: "2026-07-27T00:00:00.000Z",
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    const release = await tool.execute(
      "release-call",
      { action: "release", task_id: "task-handoff", lease_id: lease.id },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(handoff.content[0]).toMatchObject({
      text: expect.stringContaining("revision 2"),
    });
    expect(release.content[0]).toEqual({
      type: "text",
      text: `Released lease ${lease.id}.`,
    });
  });

  it("reports local metrics and doctor findings with stable details", async () => {
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
        taskId: "task-one",
        orchestrationId: "run-one",
        timestamp: "2026-07-19T00:00:00.000Z",
      },
    });
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        taskId: "task-one",
        orchestrationId: "run-one",
        timestamp: "2026-07-19T00:00:05.000Z",
        durationMs: 5_000,
      },
    });

    const tool = createTaskControlTool();
    await tool.execute(
      "review-call",
      {
        action: "record_review",
        task_id: "task-one",
        review_findings: 4,
        accepted_findings: 3,
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    const metrics = await tool.execute(
      "metrics-call",
      { action: "metrics" },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    const doctor = await tool.execute(
      "doctor-call",
      {
        action: "doctor",
        delegation_prompt: "Goal: incomplete",
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(metrics.content[0]).toMatchObject({
      text: expect.stringContaining("Completed tasks: 1"),
    });
    expect(metrics.content[0]).toMatchObject({
      text: expect.stringContaining("Review yield: 0.75"),
    });
    expect(doctor.details).toMatchObject({ status: "issues", exitCode: 1 });
  });
});
