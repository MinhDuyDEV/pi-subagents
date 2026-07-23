import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { acquireResourceLease } from "../src/orchestration/claims.ts";
import { buildContextPack, saveContextPack } from "../src/orchestration/context.ts";
import { registerHerdrTool } from "../src/orchestration/tool.ts";
import { appendOrchestrationEvent } from "../src/orchestration/telemetry.ts";

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

function createHerdrTool(): ToolDefinition<TSchema, unknown> {
  let tool: ToolDefinition<TSchema, unknown> | undefined;
  const pi = {
    registerTool(definition: ToolDefinition<TSchema, unknown>) {
      tool = definition;
    },
  } as unknown as ExtensionAPI;
  registerHerdrTool(pi);
  if (!tool) {
    throw new Error("Herdr tool was not registered");
  }
  return tool;
}

function createContext(projectDirectory: string): ExtensionContext {
  return {
    cwd: projectDirectory,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

describe("herdr orchestration tool", () => {
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

    const tool = createHerdrTool();
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

    const tool = createHerdrTool();
    const handoff = await tool.execute(
      "handoff-call",
      {
        action: "handoff",
        task_id: "task-handoff",
        handoff: {
          decisions: [{ statement: "Keep one canonical runtime." }],
          next_step: "Run parity tests.",
        },
      },
      new AbortController().signal,
      undefined,
      createContext(projectDirectory),
    );
    const release = await tool.execute(
      "release-call",
      { action: "release", lease_id: lease.id },
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

    const tool = createHerdrTool();
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
