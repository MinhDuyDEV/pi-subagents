/**
 * The orchestration journal is on the write path: the write guard fails closed
 * when telemetry throws, so anything that makes appending slow or fatal
 * eventually stops every agent from writing to the repository. These cover the
 * O(n²) append (§S-D), rotation, and the type-guard drift that turned adding an
 * event type into a journal that could never be read again.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ORCHESTRATION_EVENT_TYPES,
  appendOrchestrationEvent,
  readOrchestrationEvents,
  type OrchestrationEventType,
} from "../src/orchestration/telemetry.ts";

const temporaryDirectories: string[] = [];

async function createEventPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-journal-"));
  temporaryDirectories.push(directory);
  return join(directory, "events.jsonl");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("journal appends", () => {
  it("issues strictly increasing sequences", async () => {
    const eventPath = await createEventPath();
    for (let index = 0; index < 25; index += 1) {
      await appendOrchestrationEvent({
        eventPath,
        event: { type: "task_started", orchestrationId: `run-${index}` },
      });
    }

    const events = await readOrchestrationEvents(eventPath);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it("returns the original event for a repeated idempotency key", async () => {
    const eventPath = await createEventPath();
    const first = await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        orchestrationId: "run-1",
        idempotencyKey: "inv-1:execution:completed",
      },
    });
    const second = await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        orchestrationId: "run-1",
        idempotencyKey: "inv-1:execution:completed",
      },
    });

    expect(second).toEqual(first);
    expect(await readOrchestrationEvents(eventPath)).toHaveLength(1);
  });

  it("still dedupes after the sidecar index is lost", async () => {
    const eventPath = await createEventPath();
    const first = await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        orchestrationId: "run-1",
        idempotencyKey: "inv-1:done",
      },
    });

    // The index is a cache. Deleting it must cost a rescan, not correctness.
    await rm(`${eventPath}.index.json`);

    const second = await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "task_completed",
        orchestrationId: "run-1",
        idempotencyKey: "inv-1:done",
      },
    });
    expect(second.id).toBe(first.id);
    expect(await readOrchestrationEvents(eventPath)).toHaveLength(1);
  });

  it("rebuilds rather than trusting an index that disagrees with the journal", async () => {
    const eventPath = await createEventPath();
    await appendOrchestrationEvent({
      eventPath,
      event: { type: "task_started", orchestrationId: "run-1" },
    });

    // A stale index claiming a wildly different size and sequence — what a
    // half-written index or an out-of-date process would leave behind.
    await writeFile(
      `${eventPath}.index.json`,
      JSON.stringify({
        version: 1,
        generation: 1,
        lastSequence: 999,
        bytes: 7,
        keyed: {},
      }),
      "utf8",
    );

    const next = await appendOrchestrationEvent({
      eventPath,
      event: { type: "task_started", orchestrationId: "run-2" },
    });
    expect(next.sequence).toBe(2);
  });

  it("repairs a crash-truncated tail without losing earlier events", async () => {
    const eventPath = await createEventPath();
    await appendOrchestrationEvent({
      eventPath,
      event: { type: "task_started", orchestrationId: "run-1" },
    });
    await writeFile(eventPath, `${await readFile(eventPath, "utf8")}{"partial":`, "utf8");

    const next = await appendOrchestrationEvent({
      eventPath,
      event: { type: "task_started", orchestrationId: "run-2" },
    });

    const events = await readOrchestrationEvents(eventPath);
    expect(events.map((event) => event.orchestrationId)).toEqual(["run-1", "run-2"]);
    expect(next.sequence).toBe(2);
  });

  it("truncates a crash tail at the right byte when events contain non-ASCII text", async () => {
    const eventPath = await createEventPath();
    await appendOrchestrationEvent({
      eventPath,
      // Multi-byte characters: a character offset would cut in the wrong place.
      event: { type: "task_failed", orchestrationId: "run-1", reason: "khôi phục ✅" },
    });
    await writeFile(eventPath, `${await readFile(eventPath, "utf8")}{"partial":`, "utf8");

    await appendOrchestrationEvent({
      eventPath,
      event: { type: "task_started", orchestrationId: "run-2" },
    });

    const events = await readOrchestrationEvents(eventPath);
    expect(events).toHaveLength(2);
    expect(events[0]?.reason).toBe("khôi phục ✅");
  });
});

describe("journal rotation", () => {
  it("rotates past the size cap and keeps reading every segment in order", async () => {
    const eventPath = await createEventPath();
    // A reason field large enough that a few dozen events cross the 4 MiB cap.
    const padding = "x".repeat(256 * 1024);

    for (let index = 0; index < 40; index += 1) {
      await appendOrchestrationEvent({
        eventPath,
        event: {
          type: "task_started",
          orchestrationId: `run-${index}`,
          reason: padding,
        },
      });
    }

    const directory = join(eventPath, "..");
    const rotated = (await readdir(directory)).filter((name) =>
      /^events\.\d+\.jsonl$/u.test(name),
    );
    expect(rotated.length).toBeGreaterThan(0);

    // The live segment is bounded even though the history is not.
    expect((await stat(eventPath)).size).toBeLessThanOrEqual(5 * 1024 * 1024);

    // History is still complete, in order, with unbroken sequences.
    const events = await readOrchestrationEvents(eventPath);
    expect(events).toHaveLength(40);
    expect(events.map((event) => event.orchestrationId)).toEqual(
      Array.from({ length: 40 }, (_, index) => `run-${index}`),
    );
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
  });
});

describe("event types", () => {
  it("accepts every declared type — the guard cannot drift from the union", async () => {
    const eventPath = await createEventPath();
    for (const type of ORCHESTRATION_EVENT_TYPES) {
      await appendOrchestrationEvent({
        eventPath,
        event: { type, orchestrationId: `run-${type}` },
      });
    }

    // Writing validates nothing, so a type the READ guard rejects appends fine
    // and then makes every later read throw — which fails the write guard
    // closed and blocks all writes. Reading back is the assertion that matters.
    const events = await readOrchestrationEvents(eventPath);
    expect(events.map((event) => event.type)).toEqual([...ORCHESTRATION_EVENT_TYPES]);
  });

  it("rejects a type outside the declared set", async () => {
    const eventPath = await createEventPath();
    await appendOrchestrationEvent({
      eventPath,
      event: {
        type: "not_a_real_type" as OrchestrationEventType,
        orchestrationId: "run-1",
      },
    });
    await expect(readOrchestrationEvents(eventPath)).rejects.toThrow(
      /Invalid orchestration event/u,
    );
  });
});
