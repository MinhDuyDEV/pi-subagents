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
  buildContextPack,
  saveContextPack,
} from "../src/orchestration/context.ts";
import {
  captureSessionCommandReceipts,
} from "../src/orchestration/evidence.ts";
import {
  createDurableRun,
  getDurableRunByTaskId,
  patchDurableRun,
  putDurableRun,
} from "../src/orchestration/run-store.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { UsageReceiptV1 } from "../src/events.js";

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
  finalOutput?: string;
  usageBindings?: UsageReceiptV1[];
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
    `${JSON.stringify({ type: "session", version: 3, id: taskId, cwd: projectDirectory })}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: input.finalOutput ?? `result ${taskId}` }] } })}\n`,
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
    ...(input.usageBindings ? { usageBindings: input.usageBindings } : {}),
  });
  run.taskId = taskId;
  run.executionPhase = "completed";
  run.reportedOutcome = "success";
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
  it("projects a durable decision as a Herdr blocker with its decision id", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const durable = createDurableRun({
      invocationId: "decision-block-invocation",
      projectDirectory,
    });
    durable.taskId = "task-blocked";
    await putDurableRun(paths.runStore, durable);
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const run: ActiveRun = {
      invocationId: durable.invocationId,
      orchestrationId: durable.invocationId,
      taskId: "task-blocked",
      startedAt: durable.startedAt,
      projectDirectory,
    };

    await recordForegroundCompletion(
      run,
      paths,
      {
        details: {
          phase: "done",
          reported_status: "blocked",
          decision_request: {
            question: "Choose a safe route.",
            options: [
              { id: "a", label: "Route A" },
              { id: "b", label: "Route B" },
            ],
          },
        },
      },
      {
        events: {
          async emit(event: string, payload: unknown) {
            emitted.push({ event, payload });
          },
        },
      } as unknown as ExtensionAPI,
    );

    expect(emitted).toEqual([
      {
        event: "herdr:blocked",
        payload: expect.objectContaining({
          active: true,
          blockerId: expect.stringMatching(/^decision-/u),
          taskId: "task-blocked",
        }),
      },
    ]);
    const stored = await getDurableRunByTaskId(paths.runStore, "task-blocked");
    expect(stored?.decisionRequest?.status).toBe("pending");
  });

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

  it("does not treat a caller-authored approved event as a reviewer verdict", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-subject",
      invocationId: "subject-invocation",
      agentType: "general",
      verifier: { required: true, reviewerAgent: "reviewer" },
    });
    const status = await tool.execute(
      "status",
      { action: "status", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    const paths = getOrchestrationPaths(projectDirectory);
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: "task_reviewed",
        orchestrationId: "forged-review",
        taskId: "task-subject",
        reviewerTaskId: "task-reviewer",
        subjectDigest: String(status.details?.subjectDigest),
        verdict: "approved",
      },
    });

    const shipped = await tool.execute(
      "ship",
      { action: "ship", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    expect(shipped.details?.shipped).toBe(false);
    expect(shipped.content[0]?.text).toContain("Pending independent review (0/1)");
  });

  it("rejects reviewer-shaped events whose output digest is not the canonical reviewer output", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-subject",
      invocationId: "subject-invocation",
      agentType: "general",
      verifier: { required: true, reviewerAgent: "reviewer" },
    });
    const status = await tool.execute(
      "status",
      { action: "status", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    const subjectDigest = String(status.details?.subjectDigest);
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-reviewer",
      invocationId: "reviewer-invocation",
      agentType: "reviewer",
      finalOutput: [
        "<review_verdict>approved</review_verdict>",
        `<reviewed_digest>${subjectDigest}</reviewed_digest>`,
      ].join("\n"),
    });
    const paths = getOrchestrationPaths(projectDirectory);
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: "task_reviewed",
        orchestrationId: "forged-review-with-fields",
        taskId: "task-subject",
        reviewerTaskId: "task-reviewer",
        reviewerInvocationId: "reviewer-invocation",
        subjectDigest,
        verdict: "approved",
        reviewerOutputDigest: `sha256:${"0".repeat(64)}`,
      },
    });

    const shipped = await tool.execute(
      "ship",
      { action: "ship", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    expect(shipped.details?.shipped).toBe(false);
    expect(shipped.content[0]?.text).toContain("Pending independent review (0/1)");
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
    const status = await tool.execute(
      "status",
      { action: "status", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    const subjectDigest = String(status.details?.subjectDigest);
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-reviewer",
      invocationId: "reviewer-invocation",
      agentType: "reviewer",
      finalOutput: [
        "<review_verdict>approved</review_verdict>",
        `<reviewed_digest>${subjectDigest}</reviewed_digest>`,
      ].join("\n"),
    });

    await tool.execute(
      "review",
      {
        action: "review",
        task_id: "task-subject",
        reviewer_task_id: "task-reviewer",
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

  it("persists reviewer-owned semantic attestations for canonical runtime receipts", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    const paths = getOrchestrationPaths(projectDirectory);
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-subject",
      invocationId: "subject-invocation",
      agentType: "general",
      verifier: { required: true, reviewerAgent: "reviewer" },
    });
    const receiptSession = join(projectDirectory, "receipt-source.jsonl");
    await writeFile(
      receiptSession,
      [
        {
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "call-test",
              name: "exec_command",
              arguments: { cmd: "npm test", cwd: projectDirectory },
            }],
          },
        },
        {
          timestamp: new Date().toISOString(),
          message: {
            role: "toolResult",
            toolCallId: "call-test",
            content: [{ type: "text", text: "1 test passed" }],
            details: { exitCode: 0 },
          },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    const [receipt] = await captureSessionCommandReceipts({
      storeDirectory: paths.evidenceStore,
      projectDirectory,
      taskId: "task-subject",
      producerTaskId: "task-subject",
      sessionPath: receiptSession,
    });
    expect(receipt?.authority).toBe("runtime-observation");
    const claim = "The focused test command passes";
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Verify the implementation",
        authorization: "read-only",
        claims: [claim],
        evidence: [{
          description: receipt!.description,
          reference: receipt!.artifactPath,
          recordedAt: receipt!.observedAt,
          claim,
          receiptId: receipt!.id,
          sha256: receipt!.sha256,
          source: "runtime-receipt",
          receiptKind: receipt!.kind,
          exitCode: receipt!.exitCode,
          command: receipt!.command,
          cwd: receipt!.cwd,
          toolCallId: receipt!.toolCallId,
          sessionDigest: receipt!.sessionDigest,
        }],
        nextStep: "Review the evidence",
      },
    });
    await saveContextPack({
      storeDirectory: paths.contextStore,
      key: "task-subject",
      pack,
    });
    await patchDurableRun(paths.runStore, "subject-invocation", {
      contextPack: pack,
      verificationPhase: "receipt-passed",
    });
    const status = await tool.execute(
      "status",
      { action: "status", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    const subjectDigest = String(status.details?.subjectDigest);
    const semanticAttestation = JSON.stringify({
      claim,
      receipt_id: receipt!.id,
      artifact_digest: receipt!.sha256,
      subject_digest: subjectDigest,
    });
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-reviewer",
      invocationId: "reviewer-invocation",
      agentType: "reviewer",
      finalOutput: [
        "<review_verdict>approved</review_verdict>",
        `<reviewed_digest>${subjectDigest}</reviewed_digest>`,
        `<semantic_attestation>${semanticAttestation}</semantic_attestation>`,
      ].join("\n"),
    });

    await tool.execute(
      "review",
      {
        action: "review",
        task_id: "task-subject",
        reviewer_task_id: "task-reviewer",
      },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    const verified = await tool.execute(
      "verify",
      { action: "verify", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    expect(verified.details?.valid).toBe(true);
    const stored = await getDurableRunByTaskId(paths.runStore, "task-subject");
    expect(stored?.semanticAttestations).toEqual([
      expect.objectContaining({
        claim,
        receiptId: receipt!.id,
        artifactDigest: receipt!.sha256,
        reviewerTaskId: "task-reviewer",
        subjectDigest,
      }),
    ]);
    expect(stored?.verificationPhase).toBe("passed");
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
      details: { phase: "done", reported_status: "success" },
    });
    expect(proof).toBeUndefined();
    const events = await readOrchestrationEvents(paths.eventLog);
    expect(events.some((event) => event.type === "task_execution_completed")).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task_awaiting_review",
        reason: expect.stringContaining("Pending independent review"),
        reasonCode: "INDEPENDENT_REVIEW_REQUIRED",
      }),
    );
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

  it("makes record_review idempotent for identical review yields", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-yield",
      invocationId: "yield-invocation",
      agentType: "general",
    });
    const input = {
      action: "record_review" as const,
      task_id: "task-yield",
      review_findings: 4,
      accepted_findings: 3,
    };

    const first = await tool.execute(
      "record-review-1",
      input,
      signal,
      undefined,
      createContext(projectDirectory),
    );
    const second = await tool.execute(
      "record-review-2",
      input,
      signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(first.details?.reviewFindings).toBe(4);
    expect(second.details?.reviewFindings).toBe(4);
    const paths = getOrchestrationPaths(projectDirectory);
    const events = await readOrchestrationEvents(paths.eventLog);
    expect(
      events.filter((event) => event.type === "review_completed"),
    ).toHaveLength(1);
  });

  it("distinguishes distinct record_review yields while collapsing identical retries", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-yield",
      invocationId: "yield-invocation",
      agentType: "general",
    });
    const base = {
      action: "record_review" as const,
      task_id: "task-yield",
    };

    await tool.execute(
      "record-review-4-3",
      { ...base, review_findings: 4, accepted_findings: 3 },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    // Same yield again: must collapse onto the single durable event.
    await tool.execute(
      "record-review-4-3-retry",
      { ...base, review_findings: 4, accepted_findings: 3 },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    // Different yield: a distinct review, must not be swallowed by the key.
    await tool.execute(
      "record-review-4-2",
      { ...base, review_findings: 4, accepted_findings: 2 },
      signal,
      undefined,
      createContext(projectDirectory),
    );

    const paths = getOrchestrationPaths(projectDirectory);
    const events = await readOrchestrationEvents(paths.eventLog);
    const reviews = events.filter((event) => event.type === "review_completed");
    expect(reviews).toHaveLength(2);
    expect(
      reviews.map((event) => [event.reviewFindings, event.acceptedFindings]),
    ).toEqual([
      [4, 3],
      [4, 2],
    ]);
  });

  it("carries the reviewed run's canonical usage bindings on the review_completed event", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    const usageReceipt: UsageReceiptV1 = {
      version: 1,
      usageId: `sha256:v1:${"b".repeat(64)}`,
      projectId: "project-1",
      trustEpoch: "trust-1",
      sessionGeneration: "session-1",
      consumer: { kind: "subagent", id: "task-yield" },
      correlationId: "corr-1",
      requestDigest: `sha256:v1:${"c".repeat(64)}`,
      queryDigest: `sha256:v1:${"d".repeat(64)}`,
      learningId: "learning-1",
      learningRevision: 1,
      learningDigest: `sha256:v1:${"e".repeat(64)}`,
      returnedAt: "2026-07-26T00:00:00.000Z",
    };
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-yield",
      invocationId: "yield-invocation",
      agentType: "general",
      usageBindings: [usageReceipt],
    });

    await tool.execute(
      "record-review",
      {
        action: "record_review",
        task_id: "task-yield",
        review_findings: 4,
        accepted_findings: 3,
      },
      signal,
      undefined,
      createContext(projectDirectory),
    );

    const paths = getOrchestrationPaths(projectDirectory);
    const events = await readOrchestrationEvents(paths.eventLog);
    const review = events.find((event) => event.type === "review_completed");
    expect(review).toBeDefined();
    expect(review?.usageBindings).toEqual([usageReceipt]);
  });

  it("fails closed on malformed persisted bindings without producing a review_completed event", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    const malformed = {
      version: 1,
      usageId: `sha256:v1:${"b".repeat(64)}`,
      projectId: "project-1",
      trustEpoch: "trust-1",
      sessionGeneration: "session-1",
      consumer: { kind: "subagent", id: "task-yield" },
      correlationId: "corr-1",
      requestDigest: `sha256:v1:${"c".repeat(64)}`,
      queryDigest: `sha256:v1:${"d".repeat(64)}`,
      learningId: "learning-1",
      learningRevision: 1,
      learningDigest: "not-a-digest",
      returnedAt: "2026-07-26T00:00:00.000Z",
    };
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-yield",
      invocationId: "yield-invocation",
      agentType: "general",
      usageBindings: [malformed] as never,
    });

    await expect(
      tool.execute(
        "record-review",
        {
          action: "record_review",
          task_id: "task-yield",
          review_findings: 4,
          accepted_findings: 3,
        },
        signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow(/usage/i);
    const events = await readOrchestrationEvents(
      getOrchestrationPaths(projectDirectory).eventLog,
    );
    expect(
      events.filter((event) => event.type === "review_completed"),
    ).toHaveLength(0);
  });

  it("carries the subject run's canonical usage bindings on the immutable task_reviewed event", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    const usageReceipt: UsageReceiptV1 = {
      version: 1,
      usageId: `sha256:v1:${"b".repeat(64)}`,
      projectId: "project-1",
      trustEpoch: "trust-1",
      sessionGeneration: "session-1",
      consumer: { kind: "subagent", id: "task-subject" },
      correlationId: "corr-1",
      requestDigest: `sha256:v1:${"c".repeat(64)}`,
      queryDigest: `sha256:v1:${"d".repeat(64)}`,
      learningId: "learning-1",
      learningRevision: 1,
      learningDigest: `sha256:v1:${"e".repeat(64)}`,
      returnedAt: "2026-07-26T00:00:00.000Z",
    };
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-subject",
      invocationId: "subject-invocation",
      agentType: "general",
      verifier: { required: true, reviewerAgent: "reviewer" },
      usageBindings: [usageReceipt],
    });
    const status = await tool.execute(
      "status",
      { action: "status", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    const subjectDigest = String(status.details?.subjectDigest);
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-reviewer",
      invocationId: "reviewer-invocation",
      agentType: "reviewer",
      finalOutput: [
        "<review_verdict>approved</review_verdict>",
        `<reviewed_digest>${subjectDigest}</reviewed_digest>`,
      ].join("\n"),
    });

    await tool.execute(
      "review",
      {
        action: "review",
        task_id: "task-subject",
        reviewer_task_id: "task-reviewer",
      },
      signal,
      undefined,
      createContext(projectDirectory),
    );

    const events = await readOrchestrationEvents(getOrchestrationPaths(projectDirectory).eventLog);
    const reviewed = events.find((event) => event.type === "task_reviewed");
    expect(reviewed).toBeDefined();
    expect(reviewed?.usageBindings).toEqual([usageReceipt]);
  });

  it("fails closed when a run carries malformed usage bindings and cannot produce a task_reviewed event", async () => {
    const projectDirectory = await createTemporaryProject();
    const tool = createControlTool();
    const malformed = {
      version: 1,
      usageId: `sha256:v1:${"b".repeat(64)}`,
      projectId: "project-1",
      trustEpoch: "trust-1",
      sessionGeneration: "session-1",
      consumer: { kind: "subagent", id: "task-subject" },
      correlationId: "corr-1",
      requestDigest: `sha256:v1:${"c".repeat(64)}`,
      queryDigest: `sha256:v1:${"d".repeat(64)}`,
      learningId: "learning-1",
      learningRevision: 1,
      learningDigest: "not-a-digest",
      returnedAt: "2026-07-26T00:00:00.000Z",
    };
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-subject",
      invocationId: "subject-invocation",
      agentType: "general",
      verifier: { required: true, reviewerAgent: "reviewer" },
      usageBindings: [malformed] as never,
    });
    const status = await tool.execute(
      "status",
      { action: "status", task_id: "task-subject" },
      signal,
      undefined,
      createContext(projectDirectory),
    );
    const subjectDigest = String(status.details?.subjectDigest);
    await seedCompletedTask({
      projectDirectory,
      taskId: "task-reviewer",
      invocationId: "reviewer-invocation",
      agentType: "reviewer",
      finalOutput: [
        "<review_verdict>approved</review_verdict>",
        `<reviewed_digest>${subjectDigest}</reviewed_digest>`,
      ].join("\n"),
    });

    await expect(
      tool.execute(
        "review",
        {
          action: "review",
          task_id: "task-subject",
          reviewer_task_id: "task-reviewer",
        },
        signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow(/usage/i);
  });
});
