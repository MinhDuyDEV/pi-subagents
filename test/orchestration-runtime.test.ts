import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { getOrchestrationPaths } from "../src/orchestration/paths.ts";
import {
  createDurableRun,
  patchDurableRun,
  putDurableRun,
} from "../src/orchestration/run-store.ts";

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
}

function createFakePi(): FakePi {
  const tools = new Map<string, ToolDefinition<TSchema, unknown>>();
  const messages: unknown[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
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
    events: { on() { return () => undefined; }, emit() {} },
    ui: { notify() {} },
  } as unknown as ExtensionAPI;
  return { api, tools, messages, handlers };
}

function createContext(projectDirectory: string): ExtensionContext {
  return {
    cwd: projectDirectory,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

describe("orchestrated task runtime", () => {
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
            details: { taskId: "task-foreground-proof", phase: "completed" },
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
            details: { taskId: "task-write-default-proof", phase: "completed" },
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
            details: { taskId: "task-read-only-no-proof", phase: "completed" },
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
            details: { taskId: "task-write-env-proof", phase: "completed" },
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
              details: { task_id: "task-race", duration_ms: 1 },
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
            content: [{ type: "text", text: "Recovered final result" }],
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
});
