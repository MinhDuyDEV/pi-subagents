import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type, type TSchema } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createTaskRuntime,
  resolveUpstreamTaskExtension,
} from "../src/orchestration/runtime.ts";
import { acquireResourceLease } from "../src/orchestration/claims.ts";
import { loadContextPack } from "../src/orchestration/context.ts";
import { getOrchestrationPaths } from "../src/orchestration/paths.ts";
import {
  createDurableRun,
  getDurableRunByDecisionId,
  listDurableRuns,
  patchDurableRun,
  putDurableRun,
} from "../src/orchestration/run-store.ts";
import { SUBAGENT_LEARNING_EVENTS_V1 } from "../src/events.ts";
import {
  makeContextAcceptedPayload,
  makeContextServedPayload,
  makeLearningClaimIntent,
  PI_EVENTS_V2,
} from "@minhduydev/pi-core";

const temporaryDirectories: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-runtime-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, ".pi"), { recursive: true });
  await writeFile(join(directory, ".pi", "task-registry.json"), "[]\n", "utf8");
  await writeFile(join(directory, ".pi", "task-session-history.json"), "[]\n", "utf8");
  return directory;
}

afterEach(async () => {
  delete process.env.PI_TASK_TOOL_DISABLED;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      // Completion chains keep writing (journal index, lock dirs) briefly after
      // the effects a test waits for become observable, so removal can race a
      // file being created and fail with ENOTEMPTY. Retry until quiescent.
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  );
});

interface FakePi {
  api: ExtensionAPI;
  tools: Map<string, ToolDefinition<TSchema, unknown>>;
  messages: unknown[];
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  eventHandlers: Map<string, Array<(payload: unknown) => unknown>>;
}

function createFakePi(): FakePi {
  const tools = new Map<string, ToolDefinition<TSchema, unknown>>();
  const messages: unknown[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const eventHandlers = new Map<string, Array<(payload: unknown) => unknown>>();
  const api = {
    registerTool(tool: ToolDefinition<TSchema, unknown>) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const values = handlers.get(event) ?? [];
      values.push(handler);
      handlers.set(event, values);
    },
    registerCommand() {},
    sendMessage(message: unknown) {
      messages.push(message);
    },
    events: {
      on(event: string, handler: (payload: unknown) => unknown) {
        const values = eventHandlers.get(event) ?? [];
        values.push(handler);
        eventHandlers.set(event, values);
        return () => {
          eventHandlers.set(
            event,
            (eventHandlers.get(event) ?? []).filter(
              (candidate) => candidate !== handler,
            ),
          );
        };
      },
      async emit(event: string, payload: unknown) {
        const results = [];
        for (const handler of eventHandlers.get(event) ?? []) {
          results.push(await handler(payload));
        }
        return results;
      },
    },
    ui: { notify() {} },
  } as unknown as ExtensionAPI;
  return { api, tools, messages, handlers, eventHandlers };
}

function createContext(projectDirectory: string): ExtensionContext {
  return {
    cwd: projectDirectory,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

describe("orchestrated task runtime", () => {
  it("scopes multi-repo claims and context to cwd while retaining control state", async () => {
    const controlDirectory = await createTemporaryProject();
    const executionDirectory = await createTemporaryProject();
    await mkdir(join(executionDirectory, "src"), { recursive: true });
    await writeFile(join(executionDirectory, "src", "target.ts"), "export {};\n", "utf8");
    const fakePi = createFakePi();
    const upstreamCalls: Array<Record<string, unknown>> = [];
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Multi-repo upstream",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          cwd: Type.Optional(Type.String()),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, params) {
          upstreamCalls.push(params as Record<string, unknown>);
          return {
            content: [{ type: "text" as const, text: "Started task task-multi." }],
            details: { taskId: "task-multi", phase: "running" },
          };
        },
      });
    })(fakePi.api);

    await fakePi.tools.get("task")?.execute(
      "multi-repo",
      {
        agent_type: "general",
        prompt: "Inspect the target repository.",
        description: "Multi repo task",
        cwd: executionDirectory,
        background: true,
        orchestration: {
          claims: [{ kind: "write", resource: "src", mode: "exclusive" }],
          context: {
            goal: "Update the target repository",
            authorization: "write-approved",
            references: [{ path: "src/target.ts" }],
            next_step: "Inspect the target",
          },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(controlDirectory),
    );

    expect(upstreamCalls[0]?.cwd).toBe(executionDirectory);
    const paths = getOrchestrationPaths(controlDirectory);
    const runs = await listDurableRuns(paths.runStore);
    const canonicalExecutionDirectory = await realpath(executionDirectory);
    expect(runs[0]).toMatchObject({
      projectDirectory: controlDirectory,
      workspaceDirectory: canonicalExecutionDirectory,
      executionDirectory: canonicalExecutionDirectory,
    });
    expect(runs[0]?.contextPack?.references[0]?.path).toBe("src/target.ts");
    const leases = JSON.parse(await readFile(paths.leaseStore, "utf8")) as {
      leases: Array<{ scope?: string }>;
    };
    expect(leases.leases[0]?.scope).toBe(canonicalExecutionDirectory);
  });

  it("resolves the upstream extension from an ESM module boundary", () => {
    const upstream = () => undefined;
    expect(resolveUpstreamTaskExtension({ default: upstream })).toBe(upstream);
    expect(() => resolveUpstreamTaskExtension({ default: "invalid" })).toThrow(
      /valid default extension/u,
    );
  });

  it("preserves upstream required fields across a plain JSON-schema boundary", () => {
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Plain-schema upstream task",
        parameters: {
          type: "object",
          required: ["agent_type", "prompt", "description"],
          properties: {
            agent_type: { type: "string" },
            prompt: { type: "string" },
            description: { type: "string" },
            task_id: { type: "string" },
            conversation_id: { type: "string" },
            background: { type: "boolean", default: true },
          },
          additionalProperties: false,
        },
        async execute() {
          return {
            content: [{ type: "text" as const, text: "unused" }],
            details: {},
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    const parameters = fakePi.tools.get("task")?.parameters as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(parameters.required).toEqual(["agent_type", "prompt", "description"]);
    expect(parameters.properties).toHaveProperty("orchestration");
    expect(parameters.properties).not.toHaveProperty(
      "__pi_subagents_invocation_id",
    );
  });

  it("extends task calls with claims and a Context Pack without leaking wrapper fields upstream", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstreamCalls: Array<Record<string, unknown>> = [];
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
          task_id: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
          upstreamCalls.push(params);
          return {
            content: [
              {
                type: "text" as const,
                text: "⿻ Started task task-one.\nSubagent session: /synthetic/task-one.jsonl",
              },
            ],
            details: { taskId: "task-one", phase: "running" },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    const task = fakePi.tools.get("task");
    expect(task).toBeDefined();
    expect(task?.description).toContain("resource ownership");
    expect(task?.description).toContain("Context Pack");
    expect(
      "orchestration" in
        ((task?.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
    ).toBe(true);

    const result = await task?.execute(
      "call-one",
      {
        agent_type: "general",
        prompt: "Goal: implement the lifecycle fix.",
        description: "Implement lifecycle",
        background: true,
        orchestration: {
          claims: [
            { kind: "write", resource: "package/src", mode: "exclusive" },
          ],
          context: {
            goal: "Implement lifecycle parity",
            authorization: "write-approved",
            known_facts: [
              { statement: "Current disk wins.", source: "repository" },
            ],
            next_step: "Resolve the nested session.",
          },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]).not.toHaveProperty("orchestration");
    expect(upstreamCalls[0]?.prompt).toContain("## Context Pack");
    expect(upstreamCalls[0]?.prompt).toContain("[repository] Current disk wins.");
    expect(result?.content[0]).toMatchObject({
      type: "text",
      text: expect.not.stringContaining("/synthetic/task-one.jsonl"),
    });

    const leaseStore = JSON.parse(
      await readFile(
        join(
          projectDirectory,
          ".pi",
          "artifacts",
          "tasks",
          "orchestration",
          "leases.json",
        ),
        "utf8",
      ),
    ) as { leases: Array<{ owner: string }> };
    expect(leaseStore.leases).toHaveLength(1);

    await expect(
      task?.execute(
        "call-two",
        {
          agent_type: "general",
          prompt: "Conflicting implementation",
          description: "Conflict",
          background: true,
          orchestration: {
            claims: [
              {
                kind: "write",
                resource: "package/src/orchestration/runtime.ts",
                mode: "exclusive",
              },
            ],
          },
        },
        new AbortController().signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow(/conflicts with/u);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("persists asynchronously served learning context, binding, and usage receipts", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstreamCalls: Array<Record<string, unknown>> = [];
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, params) {
          upstreamCalls.push(params as Record<string, unknown>);
          return {
            content: [{ type: "text" as const, text: "Started." }],
            details: {
              taskId: "task-learning-context",
              phase: "running",
              reported_status: "unknown",
              session: "/synthetic/task-learning-context.jsonl",
            },
          };
        },
      });
    };
    const intent = makeLearningClaimIntent({
      version: 2,
      kind: "discovery",
      statement: "Use the project learning handshake",
      applicability: "pi-subagents runtime",
    });
    const digest = `sha256:v1:${"a".repeat(64)}`;
    fakePi.api.events.on(PI_EVENTS_V2.SUBAGENT_CONTEXT_REQUEST, (value) => {
      const request = value as Parameters<typeof makeContextAcceptedPayload>[0];
      setTimeout(() => {
        fakePi.api.events.emit(
          PI_EVENTS_V2.LEARNING_CONTEXT_ACCEPTED,
          makeContextAcceptedPayload(request),
        );
        setTimeout(() => {
          fakePi.api.events.emit(
            PI_EVENTS_V2.LEARNING_CONTEXT_SERVED,
            makeContextServedPayload({
              request,
              projectId: "project-learning",
              trustEpoch: "trust-learning",
              sessionGeneration: "generation-learning",
              context: {
                version: 1,
                facts: [{
                  domain: "workflow",
                  summary: "Learning context arrived asynchronously",
                  confidence: "high",
                  evidenceDigest: "b".repeat(64),
                }],
                usageReceipts: [{
                  version: 1,
                  usageId: digest,
                  projectId: "project-learning",
                  trustEpoch: "trust-learning",
                  sessionGeneration: "generation-learning",
                  consumer: { kind: "subagent", id: "task-learning-context" },
                  correlationId: request.correlationId,
                  requestDigest: request.requestDigest,
                  queryDigest: digest,
                  learningId: "learning-context-1",
                  learningRevision: 1,
                  learningDigest: digest,
                  returnedAt: "2026-08-06T00:00:00.000Z",
                }],
              },
            }),
          );
        }, 10);
      }, 10);
    });

    createTaskRuntime(upstream)(fakePi.api);
    const task = fakePi.tools.get("task");
    await task?.execute(
      "learning-context",
      {
        agent_type: "general",
        prompt: "Inspect the learning integration",
        description: "Inspect learning context",
        background: true,
        orchestration: {
          context: {
            goal: "Inspect learning context",
            authorization: "read-only",
            learning_claims: [intent],
            next_step: "Report findings",
          },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(upstreamCalls[0]?.prompt).toContain("Learning context arrived asynchronously");
    const runs = await listDurableRuns(getOrchestrationPaths(projectDirectory).runStore);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.learningBinding).toEqual({
      projectId: "project-learning",
      trustEpoch: "trust-learning",
      sessionGeneration: "generation-learning",
    });
    expect(runs[0]?.usageBindings).toHaveLength(1);
  });

  it("surfaces foreground evidence-only proof failures in the task result", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Claimed completion." }],
            details: {
              taskId: "task-foreground-proof",
              phase: "completed",
              reported_status: "success",
            },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    await expect(
      fakePi.tools.get("task")?.execute(
        "foreground-proof",
        {
          agent_type: "reviewer",
          prompt: "Verify evidence only.",
          description: "Foreground proof",
          background: false,
          orchestration: {
            proof: { mode: "evidence-only", max_evidence_age_ms: 60_000 },
          },
        },
        new AbortController().signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow(/Evidence-only review failed/u);
  });

  it("emits a canonical settlement for foreground tasks", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const settled: unknown[] = [];
    fakePi.api.events.on("pi-subagents:task-settled", (payload) => {
      settled.push(payload);
    });
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Foreground lifecycle upstream",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Completed." }],
            details: {
              taskId: "task-foreground-lifecycle",
              phase: "completed",
              reported_status: "success",
            },
          };
        },
      });
    })(fakePi.api);

    await fakePi.tools.get("task")?.execute(
      "foreground-lifecycle",
      {
        agent_type: "general",
        prompt: "Complete now.",
        description: "Foreground lifecycle",
        background: false,
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(settled).toEqual([
      expect.objectContaining({
        protocolVersion: 1,
        taskId: "task-foreground-lifecycle",
        terminalOutcome: "success",
        reportedOutcome: "success",
        executionPhase: "completed",
        awaitingReview: false,
      }),
    ]);
  });

  it("emits review-pending background settlement without claiming verification failure", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const settled: Array<Record<string, unknown>> = [];
    fakePi.api.events.on("pi-subagents:task-settled", (payload) => {
      settled.push(payload as Record<string, unknown>);
    });
    let upstreamPi: ExtensionAPI | undefined;
    createTaskRuntime((pi) => {
      upstreamPi = pi;
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Review-pending lifecycle upstream",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Started." }],
            details: { taskId: "task-review-pending", phase: "running" },
          };
        },
      });
    })(fakePi.api);
    await fakePi.tools.get("task")?.execute(
      "review-pending-lifecycle",
      {
        agent_type: "general",
        prompt: "Complete for review.",
        description: "Review pending lifecycle",
        background: true,
        orchestration: {
          verifier: { required: true, reviewer_agent: "reviewer" },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    upstreamPi?.sendMessage(
      {
        customType: "task-complete",
        content: "Completed and awaiting review.",
        display: true,
        details: {
          task_id: "task-review-pending",
          phase: "done",
          execution_phase: "done",
          reported_status: "success",
        },
      },
      { triggerTurn: false },
    );

    await vi.waitFor(() => {
      expect(settled).toEqual([
        expect.objectContaining({
          taskId: "task-review-pending",
          terminalOutcome: "unknown",
          reportedOutcome: "success",
          executionPhase: "completed",
          awaitingReview: true,
        }),
      ]);
    });
    expect(settled[0]).not.toHaveProperty("verificationPassed");
  });

  it("defaults write-approved tasks to evidence-only proof when no proof is passed", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Claimed completion." }],
            details: {
              taskId: "task-write-default-proof",
              phase: "completed",
              reported_status: "success",
            },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    // No explicit `proof` is passed; the curriculum default for write-approved
    // tasks must still run validateEvidenceOnlyProof, which fails on no evidence.
    await expect(
      fakePi.tools.get("task")?.execute(
        "write-default-proof",
        {
          agent_type: "reviewer",
          prompt: "Verify evidence only.",
          description: "Write default proof",
          background: false,
          orchestration: {
            context: {
              goal: "Ship the change.",
              authorization: "write-approved",
              next_step: "Run the build.",
            },
          },
        },
        new AbortController().signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow(/Evidence-only review failed/u);
  });

  it("fails the evidence-only proof gate for write claims without context authorization", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Claimed completion." }],
            details: {
              taskId: "task-claims-only-proof",
              phase: "completed",
              reported_status: "success",
            },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    // Write/test claims alone (no `orchestration.context` authorization at all,
    // exactly as an RPC caller can send after sanitization) must still count as
    // write authorization: no explicit proof was passed, so the runtime must
    // default to evidence-only proof and FAIL on this successful task output
    // because no runtime evidence exists.
    await expect(
      fakePi.tools.get("task")?.execute(
        "claims-only-proof",
        {
          agent_type: "general",
          prompt: "Ship the change.",
          description: "Claims-only proof",
          background: false,
          orchestration: {
            claims: [{ kind: "write", resource: "src", mode: "exclusive" }],
          },
        },
        new AbortController().signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow(/Evidence-only review failed/u);
  });

  it("rejects read-only authorization combined with write claims at admission", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          throw new Error("upstream must not run for a contradictory admission");
        },
      });
    })(fakePi.api);

    const result = await fakePi.tools.get("task")?.execute(
      "read-only-write-claims",
      {
        agent_type: "general",
        prompt: "Inspect only.",
        description: "Read-only with write claims",
        background: true,
        orchestration: {
          claims: [{ kind: "write", resource: "src", mode: "exclusive" }],
          context: {
            goal: "Inspect the code.",
            authorization: "read-only",
            next_step: "Report findings.",
          },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    // The contradiction is rejected at admission: no lease is acquired and the
    // upstream task tool never runs.
    expect(result?.isError).toBe(true);
    expect(result?.details).toMatchObject({
      error: "read-only authorization cannot be combined with write or test claims",
    });
  });

  it("rejects read-only authorization combined with test claims at admission", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          throw new Error("upstream must not run for a contradictory admission");
        },
      });
    })(fakePi.api);

    const result = await fakePi.tools.get("task")?.execute(
      "read-only-test-claims",
      {
        agent_type: "general",
        prompt: "Inspect only.",
        description: "Read-only with test claims",
        background: true,
        orchestration: {
          claims: [{ kind: "test", resource: "src/**", mode: "shared" }],
          context: {
            goal: "Inspect the code.",
            authorization: "read-only",
            next_step: "Report findings.",
          },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    // The contradiction is rejected at admission: no lease is acquired and the
    // upstream task tool never runs.
    expect(result?.isError).toBe(true);
    expect(result?.details).toMatchObject({
      error: "read-only authorization cannot be combined with write or test claims",
    });
  });

  it("rejects read-only authorization with write claims before a schedule is persisted", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    let upstreamCalls = 0;
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          upstreamCalls += 1;
          return {
            content: [{ type: "text" as const, text: "Scheduled." }],
            details: { taskId: "task-scheduled", phase: "running" },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    const result = await fakePi.tools.get("task")?.execute(
      "schedule-read-only-write",
      {
        agent_type: "general",
        prompt: "Inspect only.",
        description: "Read-only scheduled with write claims",
        background: true,
        orchestration: {
          schedule: { cron: "0 0 * * *" },
          claims: [{ kind: "write", resource: "src", mode: "exclusive" }],
          context: {
            goal: "Inspect the code.",
            authorization: "read-only",
            next_step: "Report findings.",
          },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    // The contradiction must be rejected at admission — before the schedule is
    // persisted — so no schedule file exists, no Cron job is installed, and the
    // upstream task tool never runs.
    expect(result?.isError).toBe(true);
    expect(result?.details).toMatchObject({
      error: "read-only authorization cannot be combined with write or test claims",
    });
    expect(upstreamCalls).toBe(0);
    const schedulePath = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "orchestration",
      "schedules.json",
    );
    let schedules: { schedules: unknown[] } | undefined;
    try {
      schedules = JSON.parse(await readFile(schedulePath, "utf8"));
    } catch {
      // Absent file is the expected no-side-effect state.
    }
    expect(schedules?.schedules ?? []).toEqual([]);
  });

  it("allows read-only authorization with evidence-only claims", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Read-only evidence findings." }],
            details: {
              taskId: "task-read-only-evidence",
              phase: "completed",
              reported_status: "success",
            },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    const result = await fakePi.tools.get("task")?.execute(
      "read-only-evidence",
      {
        agent_type: "general",
        prompt: "Verify evidence only.",
        description: "Read-only evidence claims",
        background: false,
        orchestration: {
          claims: [{ kind: "evidence", resource: "build.log", mode: "shared" }],
          context: {
            goal: "Verify the build log.",
            authorization: "read-only",
            next_step: "Report findings.",
          },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    // Evidence claims are not write claims: read-only admission stays legal and
    // no evidence-only proof gate is imposed on the raw read result.
    expect(result?.content[0]?.text).toBe("Read-only evidence findings.");
  });

  it("does not default non-write tasks to evidence-only proof", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Read-only findings." }],
            details: {
              taskId: "task-read-only-no-proof",
              phase: "completed",
              reported_status: "success",
            },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    const result = await fakePi.tools.get("task")?.execute(
      "read-only-no-proof",
      {
        agent_type: "reviewer",
        prompt: "Read-only review.",
        description: "Read-only no proof",
        background: false,
        orchestration: {
          context: {
            goal: "Inspect the code.",
            authorization: "read-only",
            next_step: "Report findings.",
          },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    // Non-write tasks keep the existing behavior: the raw subagent result is
    // returned without an evidence-only proof gate.
    expect(result?.content[0]?.text).toBe("Read-only findings.");
  });

  it("does not let PI_SUBAGENTS_NO_PROOF silently disable the default proof for write-approved tasks", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Claimed completion." }],
            details: {
              taskId: "task-write-env-proof",
              phase: "completed",
              reported_status: "success",
            },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    const previous = process.env.PI_SUBAGENTS_NO_PROOF;
    process.env.PI_SUBAGENTS_NO_PROOF = "1";
    try {
      // The env-var escape hatch must not silently disable the curriculum
      // default for write-approved tasks that did not pass an explicit proof.
      await expect(
        fakePi.tools.get("task")?.execute(
          "write-env-proof",
          {
            agent_type: "reviewer",
            prompt: "Verify evidence only.",
            description: "Write env proof",
            background: false,
            orchestration: {
              context: {
                goal: "Ship the change.",
                authorization: "write-approved",
                next_step: "Run the build.",
              },
            },
          },
          new AbortController().signal,
          undefined,
          createContext(projectDirectory),
        ),
      ).rejects.toThrow(/Evidence-only review failed/u);
    } finally {
      if (previous === undefined) {
        delete process.env.PI_SUBAGENTS_NO_PROOF;
      } else {
        process.env.PI_SUBAGENTS_NO_PROOF = previous;
      }
    }
  });

  it("does not lose a completion emitted before task registration finishes", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Racing upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          pi.sendMessage(
            {
              customType: "task-complete",
              content: "Finished immediately",
              display: true,
              details: {
                task_id: "task-race",
                duration_ms: 1,
                phase: "done",
                execution_phase: "done",
                reported_status: "success",
              },
            },
            { triggerTurn: false },
          );
          return {
            content: [{ type: "text" as const, text: "Started task task-race." }],
            details: { taskId: "task-race", phase: "running" },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    await fakePi.tools.get("task")?.execute(
      "race-call",
      {
        agent_type: "general",
        prompt: "Finish immediately.",
        description: "Completion registration race",
        background: true,
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    await vi.waitFor(() => {
      expect(fakePi.messages).toEqual([
        expect.objectContaining({
          customType: "task-complete",
          content: "Finished immediately",
        }),
      ]);
    });
    const paths = getOrchestrationPaths(projectDirectory);
    const runs = JSON.parse(await readFile(paths.runStore, "utf8")) as {
      runs: Array<{ taskId?: string; executionPhase: string }>;
    };
    expect(runs.runs).toEqual([
      expect.objectContaining({ taskId: "task-race", executionPhase: "completed" }),
    ]);
  });

  it("records background evidence-only proof failures as task failures", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    let upstreamPi: ExtensionAPI | undefined;
    const upstream = (pi: ExtensionAPI) => {
      upstreamPi = pi;
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Started task task-proof-fail." }],
            details: { taskId: "task-proof-fail", phase: "running" },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    await fakePi.tools.get("task")?.execute(
      "proof-fail-call",
      {
        agent_type: "reviewer",
        prompt: "Verify evidence only.",
        description: "Proof failure",
        background: true,
        orchestration: {
          proof: { mode: "evidence-only", max_evidence_age_ms: 60_000 },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    upstreamPi?.sendMessage(
      {
        customType: "task-complete",
        content: "Unproven completion",
        display: true,
        details: {
          task_id: "task-proof-fail",
          duration_ms: 1_000,
          evidence: "claimed command",
          phase: "done",
          execution_phase: "done",
          reported_status: "success",
        },
      },
      { triggerTurn: false },
    );

    const eventPath = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "orchestration",
      "events.jsonl",
    );
    await vi.waitFor(async () => {
      const events = (await readFile(eventPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; taskId?: string });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "task_execution_completed", taskId: "task-proof-fail" }),
          expect.objectContaining({ type: "proof_failed", taskId: "task-proof-fail" }),
        ]),
      );
      expect(events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "task_completed", taskId: "task-proof-fail" }),
        ]),
      );
    });
  });

  it("describes child-reported review failures as blocking findings with a retrievable result", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    let upstreamPi: ExtensionAPI | undefined;
    const upstream = (pi: ExtensionAPI) => {
      upstreamPi = pi;
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Started task task-review-failure." }],
            details: { taskId: "task-review-failure", phase: "running" },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    await fakePi.tools.get("task")?.execute(
      "review-failure-call",
      {
        agent_type: "reviewer",
        prompt: "Review the change.",
        description: "Blocking review",
        background: true,
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    upstreamPi?.sendMessage(
      {
        customType: "task-complete",
        content: "Do not ship: path traversal is still possible.",
        display: true,
        details: {
          task_id: "task-review-failure",
          duration_ms: 1_000,
          phase: "done",
          execution_phase: "done",
          reported_status: "failure",
        },
      },
      { triggerTurn: false },
    );

    await vi.waitFor(() => {
      expect(fakePi.messages).toEqual([
        expect.objectContaining({
          customType: "task-complete",
          content: expect.stringContaining(
            "completed with blocking findings; retrieve the review with task_control result",
          ),
        }),
      ]);
    });
  });

  it("releases background claims and records proof-aware completion events", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    let upstreamPi: ExtensionAPI | undefined;
    const upstream = (pi: ExtensionAPI) => {
      upstreamPi = pi;
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Started task task-proof." }],
            details: { taskId: "task-proof", phase: "running" },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    const task = fakePi.tools.get("task");
    await task?.execute(
      "proof-call",
      {
        agent_type: "reviewer",
        prompt: "Verify evidence only.",
        description: "Proof audit",
        background: true,
        orchestration: {
          claims: [
            { kind: "evidence", resource: "proof-output", mode: "exclusive" },
          ],
          proof: { mode: "evidence-only", max_evidence_age_ms: 60_000 },
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    const taskSessionDirectory = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "sessions",
      "task-proof",
    );
    await mkdir(taskSessionDirectory, { recursive: true });
    await writeFile(
      join(taskSessionDirectory, "proof-session.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "proof-session-id",
          cwd: projectDirectory,
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "proof-command",
                name: "bash",
                arguments: {
                  command: "npm test",
                  cwd: projectDirectory,
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "proof-command",
            toolName: "bash",
            isError: false,
            details: { exitCode: 0 },
            content: [{ type: "text", text: "all tests passed" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "provider-a",
            model: "model-a",
            content: [{ type: "text", text: "proof result" }],
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 0.001 },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    upstreamPi?.sendMessage(
      {
        customType: "task-complete",
        content: "Proof complete",
        display: true,
        details: {
          task_id: "task-proof",
          duration_ms: 2_000,
          evidence: "npm test passed",
          phase: "done",
          execution_phase: "done",
          reported_status: "success",
        },
      },
      { triggerTurn: false },
    );

    const root = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "orchestration",
    );
    await vi.waitFor(async () => {
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; taskId?: string });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "task_completed", taskId: "task-proof" }),
          expect.objectContaining({ type: "proof_passed", taskId: "task-proof" }),
          expect.objectContaining({ type: "claim_released" }),
        ]),
      );
      const leases = JSON.parse(
        await readFile(join(root, "leases.json"), "utf8"),
      ) as { leases: unknown[] };
      expect(leases.leases).toEqual([]);
      const history = JSON.parse(
        await readFile(
          join(projectDirectory, ".pi", "task-session-history.json"),
          "utf8",
        ),
      ) as Array<{ id: string; sessionRef?: string }>;
      expect(history.find((entry) => entry.id === "task-proof")?.sessionRef).toContain(
        "proof-session.jsonl",
      );
    });
  });

  it("retains the canonical task ID when post-launch processing fails", async () => {
    const projectDirectory = await createTemporaryProject();
    const orchestrationDirectory = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "orchestration",
    );
    await mkdir(orchestrationDirectory, { recursive: true });
    await writeFile(join(orchestrationDirectory, "contexts"), "not a directory\n", "utf8");

    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Started task task-post-launch." }],
            details: { taskId: "task-post-launch", phase: "running" },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    await expect(
      fakePi.tools.get("task")?.execute(
        "post-launch-failure",
        {
          agent_type: "general",
          prompt: "Create context.",
          description: "Post-launch failure",
          orchestration: {
            context: {
              goal: "Preserve task ID",
              authorization: "write-approved",
              next_step: "Persist context.",
            },
          },
        },
        new AbortController().signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow();

    const events = (await readFile(join(orchestrationDirectory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; taskId?: string });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task_failed",
          taskId: "task-post-launch",
        }),
      ]),
    );
  });

  it("settles a canonical background launch failure without waiting for a completion hook", async () => {
    const projectDirectory = await createTemporaryProject();
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Failing upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute() {
          return {
            content: [{ type: "text" as const, text: "Could not launch task task-launch-failed." }],
            details: {
              task_id: "task-launch-failed",
              phase: "failed",
              error: "backend unavailable",
            },
            isError: true,
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    const result = await fakePi.tools.get("task")?.execute(
      "launch-failed",
      {
        agent_type: "general",
        prompt: "Fail at launch.",
        description: "Canonical launch failure",
        background: true,
        orchestration: {
          claims: [{ kind: "write", resource: "src", mode: "exclusive" }],
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    expect((result as { isError?: boolean }).isError).toBe(true);

    const paths = getOrchestrationPaths(projectDirectory);
    const document = JSON.parse(await readFile(paths.runStore, "utf8")) as {
      runs: Array<{ taskId?: string; executionPhase: string }>;
    };
    expect(document.runs).toEqual([
      expect.objectContaining({
        taskId: "task-launch-failed",
        executionPhase: "failed",
      }),
    ]);
    const leases = JSON.parse(await readFile(paths.leaseStore, "utf8")) as {
      leases: unknown[];
    };
    expect(leases.leases).toEqual([]);
  });

  it("recovers an allocating background run from the durable task registry", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const startedAt = new Date().toISOString();
    await putDurableRun(
      paths.runStore,
      createDurableRun({
        invocationId: "recover-invocation",
        agentType: "general",
        description: "Recover me",
        projectDirectory,
        startedAt,
      }),
    );
    await writeFile(
      join(projectDirectory, ".pi", "task-registry.json"),
      `${JSON.stringify([
        {
          id: "task-recovered",
          agentType: "general",
          description: "Recover me",
          sessionName: "task-task-recovered",
          startedAt: Date.parse(startedAt) + 10,
          piDir: join(projectDirectory, ".pi"),
          dir: join(projectDirectory, ".pi", "artifacts", "tasks"),
        },
      ])}\n`,
      "utf8",
    );
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Recovery upstream",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text" as const, text: "unused" }], details: {} };
        },
      });
    };
    createTaskRuntime(upstream)(fakePi.api);
    const sessionStart = fakePi.handlers.get("session_start")?.[0];
    await sessionStart?.({}, createContext(projectDirectory));

    const document = JSON.parse(await readFile(paths.runStore, "utf8")) as {
      runs: Array<{ taskId?: string; executionPhase: string }>;
    };
    expect(document.runs).toEqual([
      expect.objectContaining({
        taskId: "task-recovered",
        executionPhase: "working",
      }),
    ]);
  });

  it("reconciles terminal JSONL completion after a parent restart", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const run = createDurableRun({
      invocationId: "restart-invocation",
      agentType: "general",
      description: "Restarted task",
      projectDirectory,
    });
    await putDurableRun(paths.runStore, run);
    await patchDurableRun(paths.runStore, run.invocationId, {
      taskId: "task-restart",
      executionPhase: "working",
    });
    const sessionDirectory = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "sessions",
      "task-restart",
    );
    const sessionPath = join(sessionDirectory, "restart.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "session_info", name: "task-task-restart" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: [
                  "<status>success</status>",
                  "<summary>Recovered final result</summary>",
                  "<findings>Recovered after restart.</findings>",
                  "<evidence></evidence>",
                  "<files></files>",
                  "<caveats></caveats>",
                  "<next_steps></next_steps>",
                  "<confidence>high</confidence>",
                ].join("\n"),
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(projectDirectory, ".pi", "task-session-history.json"),
      `${JSON.stringify([
        {
          id: "task-restart",
          status: "done",
          sessionName: "task-task-restart",
          sessionRef: sessionPath,
        },
      ])}\n`,
      "utf8",
    );

    const fakePi = createFakePi();
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Recovery upstream",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text" as const, text: "unused" }], details: {} };
        },
      });
    })(fakePi.api);
    await fakePi.handlers
      .get("session_start")?.[0]
      ?.({}, createContext(projectDirectory));

    expect(fakePi.messages).toEqual([
      expect.objectContaining({
        customType: "task-complete",
        content: expect.stringContaining("Recovered final result"),
      }),
    ]);
    const document = JSON.parse(await readFile(paths.runStore, "utf8")) as {
      runs: Array<{ executionPhase: string }>;
    };
    expect(document.runs[0]?.executionPhase).toBe("completed");
  });

  it("seeds a canonical session reference before resuming a completed task", async () => {
    const projectDirectory = await createTemporaryProject();
    const taskId = "task-completed";
    const sessionName = `task-${taskId}`;
    const sessionDirectory = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "sessions",
      taskId,
    );
    const sessionPath = join(sessionDirectory, "timestamp-session.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "resume-session-id",
          cwd: projectDirectory,
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "completed result" }],
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

    const fakePi = createFakePi();
    let seededReference: string | undefined;
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Fake upstream task",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          task_id: Type.Optional(Type.String()),
        }),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
          const registry = JSON.parse(
            await readFile(join(ctx.cwd, ".pi", "task-registry.json"), "utf8"),
          ) as Array<{ id: string; sessionRef?: string }>;
          seededReference = registry.find((entry) => entry.id === taskId)?.sessionRef;
          return {
            content: [{ type: "text" as const, text: "Resumed task." }],
            details: { taskId, phase: "completed" },
          };
        },
      });
    };

    createTaskRuntime(upstream)(fakePi.api);
    const task = fakePi.tools.get("task");
    await task?.execute(
      "resume-call",
      {
        agent_type: "general",
        prompt: "Continue from the completed session.",
        description: "Resume",
        task_id: taskId,
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(seededReference).toBe(sessionPath);
    const repairedHistory = JSON.parse(
      await readFile(
        join(projectDirectory, ".pi", "task-session-history.json"),
        "utf8",
      ),
    ) as Array<{ id: string; sessionRef?: string }>;
    expect(repairedHistory.find((entry) => entry.id === taskId)?.sessionRef).toBe(
      sessionPath,
    );
  });

  it("resumes a durable decision once and clears the matching Herdr blocker", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const original = createDurableRun({
      invocationId: "decision-original",
      projectDirectory,
      agentType: "general",
      description: "Continue after a choice",
      startedAt: "2026-07-27T00:00:00.000Z",
    });
    original.taskId = "task-decision";
    original.executionPhase = "completed";
    original.reportedOutcome = "awaiting-decision";
    original.decisionRequest = {
      id: "decision-runtime-1",
      question: "Which implementation?",
      options: [{ id: "safe", label: "Safe path" }],
      requestedAt: "2026-07-27T00:01:00.000Z",
      requestDigest: `sha256:v1:${"a".repeat(64)}`,
      status: "pending",
    };
    await putDurableRun(paths.runStore, original);

    const fakePi = createFakePi();
    let upstreamCalls = 0;
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Decision resume upstream",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          task_id: Type.Optional(Type.String()),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, parameters) {
          upstreamCalls += 1;
          expect((parameters as Record<string, unknown>).task_id).toBe(
            "task-decision",
          );
          return {
            content: [{ type: "text" as const, text: "Resumed." }],
            details: { taskId: "task-decision", phase: "working" },
          };
        },
      });
    })(fakePi.api);
    const blockers: unknown[] = [];
    fakePi.api.events.on("herdr:blocked", (payload) => {
      blockers.push(payload);
    });
    await fakePi.handlers
      .get("session_start")?.[0]
      ?.({}, createContext(projectDirectory));

    const control = fakePi.tools.get("task_control");
    const input = {
      action: "respond" as const,
      task_id: "task-decision",
      decision_id: "decision-runtime-1",
      decision_option_id: "safe",
      decision_response: "Use the safe path.",
    };
    const first = await control?.execute(
      "respond-runtime-1",
      input,
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    const duplicate = await control?.execute(
      "respond-runtime-2",
      input,
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );

    expect(first?.details?.status).toBe("resolved");
    expect(duplicate?.details?.status).toBe("already-resolved");
    expect(upstreamCalls).toBe(1);
    const decisionRun = await getDurableRunByDecisionId(
      paths.runStore,
      "task-decision",
      "decision-runtime-1",
    );
    expect(decisionRun?.decisionRequest?.response).toMatchObject({
      resumeState: "started",
      resumedInvocationId: expect.any(String),
    });
    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          active: true,
          blockerId: "decision-runtime-1",
        }),
        expect.objectContaining({
          active: false,
          blockerId: "decision-runtime-1",
        }),
      ]),
    );
    await fakePi.handlers.get("session_shutdown")?.[0]?.();
  });

  it("recovers a decision dispatch from its correlated durable resume without relaunching", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    const decisionId = "decision-crash-1";
    const response = "Keep the existing implementation.";
    const responseDigest = `sha256:v1:${createHash("sha256")
      .update(
        JSON.stringify({
          decisionId,
          optionId: null,
          response,
        }),
      )
      .digest("hex")}` as const;
    const resumeCorrelationId =
      "decision-resume:decision-crash-original:decision-crash-1";
    const original = createDurableRun({
      invocationId: "decision-crash-original",
      projectDirectory,
      agentType: "general",
      startedAt: "2026-07-27T00:00:00.000Z",
    });
    original.taskId = "task-crash-resume";
    original.executionPhase = "completed";
    original.reportedOutcome = "awaiting-decision";
    original.decisionRequest = {
      id: decisionId,
      question: "Proceed?",
      options: [],
      requestedAt: "2026-07-27T00:01:00.000Z",
      requestDigest: `sha256:v1:${"b".repeat(64)}`,
      status: "resolved",
      response: {
        response,
        respondedAt: "2026-07-27T00:02:00.000Z",
        responseDigest,
        resumeCorrelationId,
        resumeState: "dispatching",
        resumeAttemptId: "attempt-before-crash",
        resumeDispatchStartedAt: "2026-07-27T00:02:00.000Z",
      },
    };
    await putDurableRun(paths.runStore, original);
    const correlated = createDurableRun({
      invocationId: "resume-already-durable",
      correlationId: resumeCorrelationId,
      projectDirectory,
      startedAt: "2026-07-27T00:03:00.000Z",
    });
    correlated.taskId = "task-crash-resume";
    correlated.executionPhase = "working";
    await putDurableRun(paths.runStore, correlated);

    const fakePi = createFakePi();
    let upstreamCalls = 0;
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Must not relaunch",
        parameters: Type.Object({}),
        async execute() {
          upstreamCalls += 1;
          return { content: [], details: {} };
        },
      });
    })(fakePi.api);
    await fakePi.handlers
      .get("session_start")?.[0]
      ?.({}, createContext(projectDirectory));

    expect(upstreamCalls).toBe(0);
    const recovered = await getDurableRunByDecisionId(
      paths.runStore,
      "task-crash-resume",
      decisionId,
    );
    expect(recovered?.decisionRequest?.response).toMatchObject({
      resumeState: "started",
      resumedInvocationId: "resume-already-durable",
    });
    await fakePi.handlers.get("session_shutdown")?.[0]?.();
  });

  it("resumes blind-first disclosure after a restart between orientation and continuation", async () => {
    const projectDirectory = await createTemporaryProject();
    const taskId = "task-blind-restart";
    const firstPi = createFakePi();
    let firstRuntimeCalls = 0;
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Blind restart fixture",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          task_id: Type.Optional(Type.String()),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, parameters) {
          firstRuntimeCalls += 1;
          const prompt = String((parameters as Record<string, unknown>).prompt);
          if (firstRuntimeCalls === 1) {
            expect(prompt).toContain("Blind-first orientation turn");
            expect(prompt).not.toContain("Sealed repository fact");
            return {
              content: [{ type: "text" as const, text: "Independent orientation" }],
              details: { taskId, phase: "completed" },
            };
          }
          expect(prompt).toContain("Sealed repository fact");
          throw new Error("simulated process exit before continuation launch");
        },
      });
    })(firstPi.api);
    await firstPi.handlers
      .get("session_start")?.[0]
      ?.({}, createContext(projectDirectory));
    await expect(
      firstPi.tools.get("task")?.execute(
        "blind-first",
        {
          agent_type: "general",
          prompt: "Investigate independently.",
          description: "Blind task",
          background: true,
          orchestration: {
            context: {
              goal: "Resolve the hidden issue",
              authorization: "read-only",
              known_facts: [{ statement: "Sealed repository fact", source: "repository" }],
              next_step: "Inspect the boundary",
              disclosure: "blind-first",
            },
          },
        },
        new AbortController().signal,
        undefined,
        createContext(projectDirectory),
      ),
    ).rejects.toThrow(/simulated process exit/u);
    await firstPi.handlers.get("session_shutdown")?.[0]?.();

    const paths = getOrchestrationPaths(projectDirectory);
    const interrupted = await loadContextPack({
      storeDirectory: paths.contextStore,
      key: taskId,
    });
    expect(interrupted?.blindDisclosure?.phase).toBe("continuation-dispatching");

    const secondPi = createFakePi();
    let resumedCalls = 0;
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "Blind restart recovery",
        parameters: Type.Object({
          agent_type: Type.String(),
          prompt: Type.String(),
          description: Type.String(),
          task_id: Type.Optional(Type.String()),
          background: Type.Optional(Type.Boolean()),
        }),
        async execute(_id, parameters) {
          resumedCalls += 1;
          expect((parameters as Record<string, unknown>).task_id).toBe(taskId);
          expect(String((parameters as Record<string, unknown>).prompt)).toContain(
            "Sealed repository fact",
          );
          return {
            content: [{ type: "text" as const, text: "Continuation launched" }],
            details: { taskId, phase: "working" },
          };
        },
      });
    })(secondPi.api);
    await secondPi.handlers
      .get("session_start")?.[0]
      ?.({}, createContext(projectDirectory));
    await secondPi.tools.get("task")?.execute(
      "blind-resume",
      {
        agent_type: "general",
        task_id: taskId,
        prompt: "Resume.",
        description: "Blind task",
        background: true,
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    expect(resumedCalls).toBe(1);
    const recovered = await loadContextPack({
      storeDirectory: paths.contextStore,
      key: taskId,
    });
    expect(recovered?.blindDisclosure).toMatchObject({
      phase: "continuation-started",
      continuedInvocationId: expect.any(String),
    });
    await secondPi.handlers.get("session_shutdown")?.[0]?.();
  });

  it("does not register the parent control plane inside child Pi processes", () => {
    process.env.PI_TASK_TOOL_DISABLED = "1";
    const fakePi = createFakePi();
    const upstream = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "child-marker",
        label: "Child marker",
        description: "marker",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      });
    };
    createTaskRuntime(upstream)(fakePi.api);
    expect(fakePi.tools.has("child-marker")).toBe(true);
    expect(fakePi.tools.has("task_control")).toBe(false);
    expect(fakePi.handlers.has("tool_call")).toBe(false);
  });

  it("guards real Pi built-in writes through the tool_call event", async () => {
    const projectDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(projectDirectory);
    await acquireResourceLease({
      storePath: paths.leaseStore,
      owner: "task-owner",
      claims: [{ kind: "write", resource: "src", mode: "exclusive" }],
    });
    const fakePi = createFakePi();
    createTaskRuntime(() => undefined)(fakePi.api);
    const handler = fakePi.handlers.get("tool_call")?.[0];
    expect(handler).toBeDefined();
    const blocked = await handler?.(
      { type: "tool_call", toolName: "edit", input: { path: "src/a.ts" } },
      createContext(projectDirectory),
    );
    expect(blocked).toMatchObject({ block: true });
  });

  it("guards writes against the matching multi-repo lease scope", async () => {
    const controlDirectory = await createTemporaryProject();
    const executionDirectory = await createTemporaryProject();
    const paths = getOrchestrationPaths(controlDirectory);
    await acquireResourceLease({
      storePath: paths.leaseStore,
      owner: "task-owner",
      scope: await realpath(executionDirectory),
      claims: [{ kind: "write", resource: "src", mode: "exclusive" }],
    });
    const fakePi = createFakePi();
    createTaskRuntime(() => undefined)(fakePi.api);
    const handler = fakePi.handlers.get("tool_call")?.[0];
    expect(handler).toBeDefined();

    const unclaimed = await handler?.(
      {
        type: "tool_call",
        toolName: "edit",
        input: { path: join(executionDirectory, "docs", "readme.md") },
      },
      createContext(controlDirectory),
    );
    expect(unclaimed).toBeUndefined();

    const blocked = await handler?.(
      {
        type: "tool_call",
        toolName: "edit",
        input: { path: join(executionDirectory, "src", "a.ts") },
      },
      createContext(controlDirectory),
    );
    expect(blocked).toMatchObject({ block: true });
  });
});
