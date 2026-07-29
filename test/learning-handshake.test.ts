import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  makeContextAcceptedPayload,
  makeContextRequestPayload,
  makeContextRequestPayloadV2,
  makeContextServedPayload,
  PI_EVENTS_V2,
  type ContextRequestPayloadV1,
  type ContextServedPayloadV2,
} from "@minhduydev/pi-core";
import {
  SUBAGENT_LEARNING_EVENTS_V1,
  type LearningFactV1,
} from "../src/events.js";
import { requestLearningContext } from "../src/learning-handshake.js";

/** A minimal EventBus that mirrors the real one: synchronous emit dispatch. */
function createEventBus(): EventBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      for (const h of handlers.get(channel) ?? []) h(data);
    },
    on(channel, handler) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
  };
}

function buildRequest(): ContextRequestPayloadV1 {
  return makeContextRequestPayload("task-1", "implementer", "do the work", "corr-1");
}

function buildServed(
  request: ContextRequestPayloadV1,
  facts: LearningFactV1[],
  usageReceipts?: unknown,
): ContextServedPayloadV2 {
  const context: { version: 1; facts: LearningFactV1[]; usageReceipts?: unknown } = {
    version: 1,
    facts,
  };
  if (usageReceipts !== undefined) {
    context.usageReceipts = usageReceipts;
  }
  return makeContextServedPayload({
    request,
    projectId: "proj-1",
    trustEpoch: "epoch-1",
    sessionGeneration: "gen-1",
    context,
  });
}

const ACK_TIMEOUT = 80;
const SERVED_TIMEOUT = 240;

describe("requestLearningContext handshake", () => {
  it("merges context from an asynchronous provider (ack then served)", async () => {
    const events = createEventBus();
    const request = buildRequest();
    const served = buildServed(request, [
      { domain: "typescript", summary: "prefer unknown over any", confidence: "high" },
    ]);

    // A provider that acknowledges and serves asynchronously (after macrotasks),
    // exactly the race the synchronous `if (accepted)` check used to miss.
    events.on(SUBAGENT_LEARNING_EVENTS_V1.CONTEXT_REQUEST, (payload) => {
      setTimeout(() => {
        events.emit(PI_EVENTS_V2.LEARNING_CONTEXT_ACCEPTED, makeContextAcceptedPayload(payload));
        setTimeout(() => {
          events.emit(PI_EVENTS_V2.LEARNING_CONTEXT_SERVED, served);
        }, 20);
      }, 10);
    });

    const result = await requestLearningContext(events, request, {
      ackTimeoutMs: ACK_TIMEOUT,
      servedTimeoutMs: SERVED_TIMEOUT,
      existingFacts: [],
    });

    expect(result).toBeDefined();
    expect(result?.learningBinding).toEqual({
      projectId: "proj-1",
      trustEpoch: "epoch-1",
      sessionGeneration: "gen-1",
    });
    expect(result?.factsGrew).toBe(true);
    expect(result?.mergedFacts.some((f) => f.source === "learning")).toBe(true);
  });

  it("does not delay or merge when no provider is installed (fast path)", async () => {
    const events = createEventBus();
    const request = buildRequest();

    const start = Date.now();
    const result = await requestLearningContext(events, request, {
      ackTimeoutMs: ACK_TIMEOUT,
      servedTimeoutMs: SERVED_TIMEOUT,
      existingFacts: [],
    });
    const elapsed = Date.now() - start;

    expect(result).toBeUndefined();
    // Fails open within the ACK window — never waits the full served timeout.
    expect(elapsed).toBeLessThan(SERVED_TIMEOUT);
  });

  it("keeps a standalone process alive until the no-provider timeout resolves", () => {
    const fixture = fileURLToPath(new URL("./fixtures/learning-no-provider.ts", import.meta.url));
    const run = spawnSync(process.execPath, ["--import", "tsx", fixture], {
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("NO_PROVIDER_RESOLVED");
  });

  it("fails open when the provider never acknowledges within the ACK window", async () => {
    const events = createEventBus();
    const request = buildRequest();
    const served = buildServed(request, [
      { domain: "rust", summary: "prefer Result over throws", confidence: "medium" },
    ]);

    let servedEmitted = false;
    events.on(SUBAGENT_LEARNING_EVENTS_V1.CONTEXT_REQUEST, () => {
      // Acknowledges too late for the ACK window, then serves.
      setTimeout(() => {
        events.emit(PI_EVENTS_V2.LEARNING_CONTEXT_ACCEPTED, makeContextAcceptedPayload(request));
      }, ACK_TIMEOUT + 60);
      setTimeout(() => {
        events.emit(PI_EVENTS_V2.LEARNING_CONTEXT_SERVED, served);
        servedEmitted = true;
      }, ACK_TIMEOUT + 80);
    });

    const result = await requestLearningContext(events, request, {
      ackTimeoutMs: ACK_TIMEOUT,
      servedTimeoutMs: SERVED_TIMEOUT,
      existingFacts: [],
    });

    expect(result).toBeUndefined();
    // The late served event must not attach after the runtime unsubscribed.
    await new Promise((r) => setTimeout(r, ACK_TIMEOUT + 120));
    expect(servedEmitted).toBe(true);
  });

  it("ignores responses that do not match the correlation triple", async () => {
    const events = createEventBus();
    const request = buildRequest();

    events.on(SUBAGENT_LEARNING_EVENTS_V1.CONTEXT_REQUEST, () => {
      // A different request whose correlationId/requestDigest do not match.
      const otherRequest = makeContextRequestPayload(
        "task-1",
        "implementer",
        "do the work",
        "wrong-corr",
      );
      setTimeout(() => {
        events.emit(
          PI_EVENTS_V2.LEARNING_CONTEXT_ACCEPTED,
          makeContextAcceptedPayload(otherRequest),
        );
      }, 10);
    });

    const result = await requestLearningContext(events, request, {
      ackTimeoutMs: ACK_TIMEOUT,
      servedTimeoutMs: SERVED_TIMEOUT,
      existingFacts: [],
    });

    expect(result).toBeUndefined();
  });

  it("persists binding and usage receipts and merges facts on a successful serve", async () => {
    const events = createEventBus();
    const request = buildRequest();
    const SHA = "sha256:v1:" + "0".repeat(64);
    const usageReceipts = [
      {
        version: 1,
        usageId: SHA,
        projectId: "proj-1",
        trustEpoch: "epoch-1",
        sessionGeneration: "gen-1",
        consumer: { kind: "subagent", id: "task-1" },
        correlationId: request.correlationId,
        requestDigest: SHA,
        queryDigest: SHA,
        learningId: "learn-1",
        learningRevision: 1,
        learningDigest: SHA,
        returnedAt: "2024-01-15T10:30:00.000Z",
      },
    ];
    const served = buildServed(
      request,
      [
        { domain: "testing", summary: "write the failing test first", confidence: "high" },
        { domain: "git", summary: "commit messages use imperative mood", confidence: "medium" },
      ],
      usageReceipts,
    );

    events.on(SUBAGENT_LEARNING_EVENTS_V1.CONTEXT_REQUEST, (payload) => {
      setTimeout(() => {
        events.emit(PI_EVENTS_V2.LEARNING_CONTEXT_ACCEPTED, makeContextAcceptedPayload(payload));
        setTimeout(() => {
          events.emit(PI_EVENTS_V2.LEARNING_CONTEXT_SERVED, served);
        }, 20);
      }, 10);
    });

    const existingFacts = [
      { statement: "prior fact", source: "user" as const, reference: "seed" },
    ];
    const result = await requestLearningContext(events, request, {
      ackTimeoutMs: ACK_TIMEOUT,
      servedTimeoutMs: SERVED_TIMEOUT,
      existingFacts,
    });

    expect(result).toBeDefined();
    // Binding propagated for durable persistence.
    expect(result?.learningBinding).toEqual({
      projectId: "proj-1",
      trustEpoch: "epoch-1",
      sessionGeneration: "gen-1",
    });
    // Usage receipts propagated for durable persistence.
    expect(result?.usageBindings).toHaveLength(1);
    expect(result?.usageBindings?.[0]?.usageId).toBe(SHA);
    // Facts merged into the existing set without clobbering prior facts.
    expect(result?.mergedFacts.length).toBe(3);
    expect(result?.factsGrew).toBe(true);
    expect(result?.mergedFacts[0]?.statement).toBe("prior fact");
  });
  it("emits V2 intents on the V2 request channel", async () => {
    const events = createEventBus();
    const request = makeContextRequestPayloadV2(
      "task-v2",
      "general",
      "verify intent",
      "corr-v2",
      [],
    );
    let observed = false;
    events.on(PI_EVENTS_V2.SUBAGENT_CONTEXT_REQUEST, (payload) => {
      observed = payload === request;
      events.emit(PI_EVENTS_V2.LEARNING_CONTEXT_ACCEPTED, makeContextAcceptedPayload(request));
    });

    const result = await requestLearningContext(events, request, {
      ackTimeoutMs: ACK_TIMEOUT,
      servedTimeoutMs: 20,
      existingFacts: [],
    });

    expect(observed).toBe(true);
    expect(result).toBeUndefined();
  });

});