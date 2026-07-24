import { describe, expect, it } from "vitest";
import {
  registerTaskRpc,
  TASK_RPC_PROTOCOL_VERSION,
  type EventBus,
} from "../src/orchestration/rpc.ts";

class Bus implements EventBus {
  private listeners = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
  on(event: string, handler: (data: unknown) => void | Promise<void>): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(handler);
    this.listeners.set(event, listeners);
    return () => listeners.delete(handler);
  }
  emit(event: string, data: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) void listener(data);
  }
  request(channel: string, request: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      const reply = `${channel}:reply:${request.requestId}`;
      const unsubscribe = this.on(reply, (value) => {
        unsubscribe();
        resolve(value);
      });
      this.emit(channel, request);
    });
  }
}

describe("task RPC protocol v3", () => {
  it("returns opaque ownership handles and settled stop results", async () => {
    const bus = new Bus();
    let next = 0;
    const active = new Set<string>();
    const rpc = registerTaskRpc({
      events: bus,
      spawn: async () => {
        const id = `task-${++next}`;
        active.add(id);
        return id;
      },
      stopTask: async (taskId) => {
        active.delete(taskId);
      },
      isTaskSettled: (taskId) => !active.has(taskId),
    });

    const spawn = (await bus.request("pi-subagents:rpc:v3:spawn", {
      requestId: "spawn-1",
      protocolVersion: TASK_RPC_PROTOCOL_VERSION,
      agentType: "general",
      prompt: "work",
      description: "RPC work",
    })) as { success: boolean; data: { id: string; handle: string } };
    expect(spawn.success).toBe(true);
    expect(spawn.data.handle).toMatch(/^scope-/u);

    const stopped = (await bus.request("pi-subagents:rpc:v3:stop", {
      requestId: "stop-1",
      protocolVersion: TASK_RPC_PROTOCOL_VERSION,
      handle: spawn.data.handle,
    })) as { success: boolean; data: { settled: boolean; failures: string[] } };
    expect(stopped).toEqual({
      success: true,
      data: { settled: true, failures: [] },
    });
    rpc.dispose();
  });

  it("rejects incompatible protocol versions", async () => {
    const bus = new Bus();
    const rpc = registerTaskRpc({
      events: bus,
      spawn: async () => "unused",
      stopTask: async () => undefined,
      isTaskSettled: () => true,
    });
    const reply = (await bus.request("pi-subagents:rpc:v3:spawn", {
      requestId: "bad-version",
      protocolVersion: 2,
      agentType: "general",
      prompt: "work",
      description: "work",
    })) as { success: boolean; error: string };
    expect(reply.success).toBe(false);
    expect(reply.error).toMatch(/expected 3/u);
    rpc.dispose();
  });
});
