import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  PI_EVENTS_V2,
  parseContextAccepted,
  parseContextServed,
  type ContextRequestPayloadV1,
  type ContextRequestPayloadV2,
  type ContextServedPayloadV2,
} from "@minhduydev/pi-core";
import type { ContextFact } from "./orchestration/context.js";
import type { UsageReceiptV1 } from "./learning-contract.js";
import {
  SUBAGENT_LEARNING_EVENTS_V1,
  mergeLearningFacts,
  validateLearningContext,
  type LearningContextV1,
} from "./events.js";

/** The durable binding a provider announces when it serves a context. */
export type LearningBinding = {
  projectId: string;
  trustEpoch: string;
  sessionGeneration: string;
};

export interface LearningHandshakeResult {
  /** Project binding announced by the provider, for durable persistence. */
  learningBinding: LearningBinding | undefined;
  /** Usage receipts carried by the served context, for durable persistence. */
  usageBindings: UsageReceiptV1[] | undefined;
  /** The validated learning context (facts/patterns/metrics), if any. */
  validated: LearningContextV1 | undefined;
  /** Existing facts with learning facts merged in (additive only). */
  mergedFacts: readonly ContextFact[];
  /** Whether `mergedFacts` grew beyond `existingFacts` (drives context-pack rebuild). */
  factsGrew: boolean;
}

export interface RequestLearningContextOptions {
  /**
   * Bounded window to wait for a provider's `LEARNING_CONTEXT_ACCEPTED`.
   * A provider that acknowledges synchronously skips this wait entirely.
   */
  ackTimeoutMs: number;
  /**
   * Bounded window to wait for `LEARNING_CONTEXT_SERVED` after acceptance.
   */
  servedTimeoutMs: number;
  /** Existing context facts to merge learning facts into. */
  existingFacts?: readonly ContextFact[];
}

/**
 * Request a bounded learning context over the Pi EventBus and wait for a
 * matching acknowledgement followed by a served response.
 *
 * The handshake is asynchronous: a real provider may acknowledge then serve
 * after async work, so we cannot decide synchronously whether to wait (the
 * race the old inline `if (accepted)` check lost). Instead we race the
 * acknowledgement signal against a short ACK window, then race the served
 * signal against a served window.
 *
 * Fail-open is preserved everywhere: no provider, a provider that declines
 * without acknowledging, or either window elapsing returns `undefined` so
 * learning never blocks task launch. Responses are correlated by
 * `taskId` + `correlationId` + `requestDigest`; a mismatched response never
 * attaches.
 */
export async function requestLearningContext(
  events: EventBus,
  contextRequest: ContextRequestPayloadV1 | ContextRequestPayloadV2,
  options: RequestLearningContextOptions,
): Promise<LearningHandshakeResult | undefined> {
  let accepted = false;
  let resolveAccepted!: () => void;
  const acceptedSignal = new Promise<void>((resolve) => {
    resolveAccepted = resolve;
  });
  let resolveServed!: (served: ContextServedPayloadV2) => void;
  const servedResponse = new Promise<ContextServedPayloadV2>((resolve) => {
    resolveServed = resolve;
  });

  const matches = (
    event:
      | { taskId: string; correlationId: string; requestDigest: string }
      | undefined,
  ): boolean =>
    event !== undefined &&
    event.taskId === contextRequest.taskId &&
    event.correlationId === contextRequest.correlationId &&
    event.requestDigest === contextRequest.requestDigest;

  const unsubscribeAccepted = events.on(
    PI_EVENTS_V2.LEARNING_CONTEXT_ACCEPTED,
    (value: unknown) => {
      if (matches(parseContextAccepted(value))) {
        accepted = true;
        resolveAccepted();
      }
    },
  );
  const unsubscribeServed = events.on(
    PI_EVENTS_V2.LEARNING_CONTEXT_SERVED,
    (value: unknown) => {
      const event = parseContextServed(value);
      if (matches(event)) {
        resolveServed(event as ContextServedPayloadV2);
      }
    },
  );

  try {
    const requestEvent = contextRequest.protocolVersion === 2
      ? PI_EVENTS_V2.SUBAGENT_CONTEXT_REQUEST
      : SUBAGENT_LEARNING_EVENTS_V1.CONTEXT_REQUEST;
    events.emit(requestEvent, contextRequest);

    // Fast path: a provider that acknowledges synchronously (the common case
    // for the real pi-learning provider) resolves `accepted` before we await,
    // so the ACK wait is skipped and the task is not delayed.
    if (!accepted) {
      let ackTimer: ReturnType<typeof setTimeout> | undefined;
      const ackTimeout = new Promise<void>((resolve) => {
        ackTimer = setTimeout(() => resolve(), options.ackTimeoutMs);
      });
      try {
        await Promise.race([acceptedSignal, ackTimeout]);
      } finally {
        if (ackTimer) clearTimeout(ackTimer);
      }
    }

    if (!accepted) {
      // No provider installed, the provider declined without acknowledging,
      // or the ACK window elapsed — fail open without delaying the task.
      return undefined;
    }

    let servedTimer: ReturnType<typeof setTimeout> | undefined;
    const servedTimeout = new Promise<undefined>((resolve) => {
      servedTimer = setTimeout(() => resolve(undefined), options.servedTimeoutMs);
    });
    const served = await Promise.race([
      servedResponse,
      servedTimeout,
    ]).finally(() => {
      if (servedTimer) clearTimeout(servedTimer);
    });
    if (!served) {
      // Provider accepted but never served within the window — fail open.
      return undefined;
    }

    const validated = validateLearningContext(served.context);
    const learningBinding: LearningBinding = {
      projectId: served.projectId,
      trustEpoch: served.trustEpoch,
      sessionGeneration: served.sessionGeneration,
    };
    const usageBindings: UsageReceiptV1[] | undefined = validated?.usageReceipts
      ? [...validated.usageReceipts]
      : undefined;
    const existingFacts = options.existingFacts;
    const mergedFacts = mergeLearningFacts(existingFacts, validated, 1200);
    const factsGrew = mergedFacts.length > (existingFacts?.length ?? 0);
    return { learningBinding, usageBindings, validated, mergedFacts, factsGrew };
  } catch {
    // fail-open: any listener/emit error must not block task launch
    return undefined;
  } finally {
    unsubscribeAccepted();
    unsubscribeServed();
  }
}