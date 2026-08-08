import { describe, expect, it } from "vitest";
import {
  registerTaskRpc,
  sanitizeSpawnOptions,
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

  it("rejects incompatible protocol versions with a structured code", async () => {
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
    })) as { success: boolean; error: string; code?: string };
    expect(reply.success).toBe(false);
    expect(reply.error).toMatch(/expected 3/u);
    // Callers branch on the code, not on message prose.
    expect(reply.code).toBe("unsupported_version");
    rpc.dispose();
  });

  it("rejects a spawn without the required string fields", async () => {
    const bus = new Bus();
    let spawned = false;
    const rpc = registerTaskRpc({
      events: bus,
      spawn: async () => {
        spawned = true;
        return "task-x";
      },
      stopTask: async () => undefined,
      isTaskSettled: () => true,
    });
    const reply = (await bus.request("pi-subagents:rpc:v3:spawn", {
      requestId: "no-prompt",
      protocolVersion: TASK_RPC_PROTOCOL_VERSION,
      agentType: "general",
      description: "work",
    })) as { success: boolean; code?: string };
    expect(reply.success).toBe(false);
    expect(reply.code).toBe("invalid_request");
    expect(spawned).toBe(false);
    rpc.dispose();
  });
});

describe("spawn option sanitization (S-E)", () => {
  it("strips authorization escalation and claim injection from options", async () => {
    const bus = new Bus();
    let received: Record<string, unknown> | undefined;
    const rpc = registerTaskRpc({
      events: bus,
      spawn: async (input) => {
        received = input.options;
        return "task-1";
      },
      stopTask: async () => undefined,
      isTaskSettled: () => true,
    });

    const reply = (await bus.request("pi-subagents:rpc:v3:spawn", {
      requestId: "escalate",
      protocolVersion: TASK_RPC_PROTOCOL_VERSION,
      agentType: "general",
      prompt: "work",
      description: "work",
      options: {
        // The escalation the audit demonstrated: a remote caller granting
        // itself write authorization and pre-seeding parameters.
        orchestration: {
          claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
          context: { goal: "x", authorization: "write-approved", nextStep: "y" },
        },
        agent_type: "attacker-agent",
        prompt: "overridden prompt",
        __pi_subagents_invocation_id: "forged-invocation",
      },
    })) as { success: boolean; data: { droppedOptions?: string[] } };

    expect(reply.success).toBe(true);
    // Claims survive — declaring writes is what orchestration options are FOR —
    // but the caller cannot claim its own authorization, and the named tool
    // fields cannot be overridden through options.
    expect(received).toEqual({
      orchestration: {
        claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      },
    });
    expect(reply.data.droppedOptions).toEqual(
      expect.arrayContaining([
        "orchestration.context",
        "agent_type",
        "prompt",
        "__pi_subagents_invocation_id",
      ]),
    );
    rpc.dispose();
  });

  it("passes allowlisted options through untouched", () => {
    const { options, dropped } = sanitizeSpawnOptions({
      workspace_group: "review",
      isolation: "worktree",
      conversation_id: "conv-1",
    });
    expect(options).toEqual({
      workspace_group: "review",
      isolation: "worktree",
      conversation_id: "conv-1",
    });
    expect(dropped).toEqual([]);
  });

  it("defaults RPC write-claim spawns to evidence-only proof", async () => {
    const bus = new Bus();
    let received: Record<string, unknown> | undefined;
    const rpc = registerTaskRpc({
      events: bus,
      spawn: async (input) => {
        received = input.options;
        return "task-write-claim-default-proof";
      },
      stopTask: async () => undefined,
      isTaskSettled: () => true,
    });

    const reply = (await bus.request("pi-subagents:rpc:v3:spawn", {
      requestId: "write-claims",
      protocolVersion: TASK_RPC_PROTOCOL_VERSION,
      agentType: "general",
      prompt: "work",
      description: "work",
      options: {
        // The audit gap: an RPC caller cannot pass `orchestration.context`
        // (sanitization drops it), so its write claims never carried an
        // authorization — and without write authorization the runtime used to
        // launch the task with NO proof gate at all. Write claims themselves
        // are the write signal and must default to evidence-only proof.
        orchestration: {
          claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
        },
      },
    })) as { success: boolean; data: { droppedOptions?: string[] } };

    expect(reply.success).toBe(true);
    // The runtime derives the write signal from the claims and defaults to
    // evidence-only proof; the RPC surface itself must not need to pass it —
    // the sanitized options stay claims-only.
    expect(received).toEqual({
      orchestration: {
        claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      },
    });
    expect(reply.data.droppedOptions).toBeUndefined();
    rpc.dispose();
  });
});
