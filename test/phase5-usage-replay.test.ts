import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateLearningContext,
  type UsageReceiptV1,
} from "../src/events.js";
import { createOrchestrationReplayPort } from "../src/replay.js";
import { appendOrchestrationEvent } from "../src/orchestration/telemetry.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const tagged = (character: string) => `sha256:v1:${character.repeat(64)}` as const;
const usageReceipt: UsageReceiptV1 = {
  version: 1,
  usageId: tagged("a"),
  projectId: "project-1",
  trustEpoch: "trust-1",
  sessionGeneration: "session-1",
  consumer: { kind: "subagent", id: "task-1" },
  correlationId: "corr-1",
  requestDigest: tagged("b"),
  queryDigest: tagged("c"),
  learningId: "learning-1",
  learningRevision: 1,
  learningDigest: tagged("d"),
  returnedAt: "2026-07-26T00:00:00.000Z",
};

describe("Phase 5 usage bindings and replay", () => {
  it("accepts only complete usage receipts in returned learning context", () => {
    expect(validateLearningContext({
      version: 1,
      facts: [{ domain: "testing", summary: "Use bounded replay", confidence: "high" }],
      usageReceipts: [usageReceipt],
    })?.usageReceipts).toEqual([usageReceipt]);
    expect(validateLearningContext({
      version: 1,
      facts: [{ domain: "testing", summary: "Use bounded replay", confidence: "high" }],
      usageReceipts: [{ ...usageReceipt, learningDigest: "bad" }],
    })).toBeUndefined();
  });

  it("fails closed when the persisted review journal is replaced or truncated behind its cursor", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "phase5-subagents-replay-rewind-"));
    directories.push(projectDirectory);
    const eventPath = join(projectDirectory, ".pi", "artifacts", "tasks", "orchestration", "events.jsonl");
    await mkdir(join(eventPath, ".."), { recursive: true });
    await appendOrchestrationEvent({
      eventPath,
      event: { type: "review_completed", orchestrationId: "corr-1", taskId: "task-1", reviewStatus: "approved", usageBindings: [usageReceipt] },
    });
    const port = createOrchestrationReplayPort({ projectDirectory });
    const first = await port.replay(undefined, 1);
    await writeFile(eventPath, `${JSON.stringify({ type: "review_completed", id: "replacement" })}\n`, "utf8");
    await expect(port.replay(first.next, 1)).rejects.toThrow(/generation|cursor|truncated|rewind/i);
  });

  it("replays review events through the public prefix-bound port", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "phase5-subagents-replay-"));
    directories.push(projectDirectory);
    const eventPath = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "orchestration",
      "events.jsonl",
    );
    await mkdir(join(eventPath, ".."), { recursive: true });
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "review_completed",
        orchestrationId: "corr-1",
        taskId: "task-1",
        reviewStatus: "approved",
        usageBindings: [usageReceipt],
      },
    });
    const port = createOrchestrationReplayPort({ projectDirectory });
    const first = await port.replay(undefined, 1);
    expect(first.events).toHaveLength(1);
    expect(first.next?.producer).toBe("pi-subagents");
    expect(first.next?.prefixHash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
    expect(await port.replay(first.next, 1)).toEqual({ events: [] });
  });
});
