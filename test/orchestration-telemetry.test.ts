import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendOrchestrationEvent,
  deriveOrchestrationMetrics,
  readOrchestrationEvents,
  summarizeTaskSessionUsage,
} from "../src/orchestration/telemetry.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-telemetry-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  delete process.env.PI_SUBAGENTS_NO_TELEMETRY;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("task outcome telemetry", () => {
  it("aggregates model usage from a task session JSONL", async () => {
    const directory = await createTemporaryDirectory();
    const sessionPath = join(directory, "task.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "session", name: "task-example" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "provider-a",
            model: "model-a",
            usage: {
              input: 100,
              output: 25,
              cacheRead: 50,
              cacheWrite: 10,
              cost: { total: 0.02 },
            },
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "provider-a",
            model: "model-a",
            usage: {
              input: 40,
              output: 15,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 0.01 },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    expect(await summarizeTaskSessionUsage(sessionPath)).toEqual({
      inputTokens: 140,
      outputTokens: 40,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      totalTokens: 240,
      cost: 0.03,
      provider: "provider-a",
      model: "model-a",
    });
  });

  it("persists lifecycle events and derives task outcome metrics", async () => {
    const directory = await createTemporaryDirectory();
    const eventPath = join(directory, "events.jsonl");

    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_started",
        taskId: "task-success",
        orchestrationId: "run-success",
        agentType: "general",
        timestamp: "2026-07-19T00:00:00.000Z",
      },
    });
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        taskId: "task-success",
        orchestrationId: "run-success",
        agentType: "general",
        timestamp: "2026-07-19T00:00:10.000Z",
        durationMs: 10_000,
        retryCount: 1,
        verificationPassed: true,
        evidenceCount: 2,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 25,
          cacheWriteTokens: 0,
          totalTokens: 175,
          cost: 0.04,
          provider: "provider-a",
          model: "model-a",
        },
      },
    });
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "review_completed",
        taskId: "task-review",
        orchestrationId: "run-review",
        agentType: "reviewer",
        timestamp: "2026-07-19T00:00:20.000Z",
        reviewFindings: 4,
        acceptedFindings: 3,
      },
    });
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_started",
        taskId: "task-stale",
        orchestrationId: "run-stale",
        agentType: "general",
        timestamp: "2026-07-19T00:00:00.000Z",
      },
    });
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_resumed",
        taskId: "task-resumed-stale",
        orchestrationId: "run-resumed-stale",
        agentType: "general",
        timestamp: "2026-07-19T00:00:00.000Z",
      },
    });

    const events = await readOrchestrationEvents(eventPath);
    expect(events).toHaveLength(5);
    expect(
      deriveOrchestrationMetrics({
        events,
        now: new Date("2026-07-19T01:00:00.000Z"),
        staleAfterMs: 30 * 60 * 1_000,
      }),
    ).toEqual({
      tasksStarted: 2,
      tasksCompleted: 1,
      tasksFailed: 0,
      staleTasks: 2,
      retries: 1,
      totalDurationMs: 10_000,
      averageDurationMs: 10_000,
      totalTokens: 175,
      totalCost: 0.04,
      verificationPassRate: 1,
      reviewYield: 0.75,
      taskSuccessRate: 1,
      tokensPerCompletedTask: 175,
      costPerCompletedTask: 0.04,
    });
  });

  it("deduplicates correctness events by durable idempotency key", async () => {
    const directory = await createTemporaryDirectory();
    const eventPath = join(directory, "events.jsonl");
    const first = await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        taskId: "task-once",
        orchestrationId: "invocation-once",
        idempotencyKey: "invocation-once:completed",
      },
    });
    const duplicate = await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        taskId: "task-once",
        orchestrationId: "invocation-once",
        idempotencyKey: "invocation-once:completed",
      },
    });
    expect(duplicate.id).toBe(first.id);
    expect(await readOrchestrationEvents(eventPath)).toHaveLength(1);
  });

  it("repairs a truncated tail before allocating the next sequence under the journal lock", async () => {
    const directory = await createTemporaryDirectory();
    const eventPath = join(directory, "events.jsonl");
    const first = await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        taskId: "task-first",
        orchestrationId: "invocation-first",
      },
    });
    await writeFile(eventPath, `${JSON.stringify(first)}\n{\"id\":\"truncated`, "utf8");

    const second = await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        taskId: "task-second",
        orchestrationId: "invocation-second",
      },
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect((await readOrchestrationEvents(eventPath)).map((event) => event.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("keeps correctness events while telemetry fields are opted out", async () => {
    const directory = await createTemporaryDirectory();
    const eventPath = join(directory, "events.jsonl");
    process.env.PI_SUBAGENTS_NO_TELEMETRY = "1";
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_execution_completed",
        taskId: "task-1",
        orchestrationId: "invocation-1",
        durationMs: 100,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          cost: 0.01,
        },
      },
    });
    const [event] = await readOrchestrationEvents(eventPath);
    expect(event?.type).toBe("task_execution_completed");
    expect(event?.durationMs).toBeUndefined();
    expect(event?.usage).toBeUndefined();
  });
});
