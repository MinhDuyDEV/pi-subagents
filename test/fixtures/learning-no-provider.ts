import type { EventBus } from "@earendil-works/pi-coding-agent";
import { makeContextRequestPayload } from "@minhduydev/pi-core";
import { requestLearningContext } from "../../src/learning-handshake.js";

const handlers = new Map<string, Set<(value: unknown) => void>>();
const events: EventBus = {
  emit(channel, value) {
    for (const handler of handlers.get(channel) ?? []) handler(value);
  },
  on(channel, handler) {
    const listeners = handlers.get(channel) ?? new Set();
    listeners.add(handler);
    handlers.set(channel, listeners);
    return () => listeners.delete(handler);
  },
};

const request = makeContextRequestPayload(
  "task-no-provider",
  "general",
  "verify fail-open timeout",
  "corr-no-provider",
);
const result = await requestLearningContext(events, request, {
  ackTimeoutMs: 20,
  servedTimeoutMs: 20,
  existingFacts: [],
});
if (result !== undefined) throw new Error("Expected no learning context");
process.stdout.write("NO_PROVIDER_RESOLVED\n");
