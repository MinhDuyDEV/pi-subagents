import { randomUUID } from "node:crypto";

export const TASK_RPC_PROTOCOL_VERSION = 3;

export interface EventBus {
  on(event: string, handler: (data: unknown) => void | Promise<void>): () => void;
  emit(event: string, data: unknown): void;
}

interface OwnershipScope {
  handle: string;
  parentHandle?: string;
  children: Set<string>;
  taskIds: Set<string>;
  frozen: boolean;
}

export interface TaskRpcDependencies {
  events: EventBus;
  spawn: (input: {
    agentType: string;
    prompt: string;
    description: string;
    options?: Record<string, unknown>;
  }) => Promise<string>;
  stopTask: (taskId: string) => Promise<void>;
  isTaskSettled: (taskId: string) => boolean;
}

export interface TaskRpcHandle {
  dispose(): void;
  settleTask(taskId: string): void;
}

export function registerTaskRpc(deps: TaskRpcDependencies): TaskRpcHandle {
  const scopes = new Map<string, OwnershipScope>();
  const taskOwners = new Map<string, string>();
  const unsubscribers: Array<() => void> = [];

  unsubscribers.push(
    handleRpc(deps.events, "pi-subagents:rpc:v3:ping", () => ({
      protocolVersion: TASK_RPC_PROTOCOL_VERSION,
      capabilities: ["spawn", "stop-scope", "settled-stop", "recursive-ownership"],
    })),
  );

  unsubscribers.push(
    handleRpc<{
      requestId: string;
      protocolVersion: number;
      parentHandle?: string;
      agentType: string;
      prompt: string;
      description: string;
      options?: Record<string, unknown>;
    }>(deps.events, "pi-subagents:rpc:v3:spawn", async (request) => {
      requireVersion(request.protocolVersion);
      const parent = request.parentHandle
        ? requireScope(scopes, request.parentHandle)
        : undefined;
      if (parent?.frozen) throw new Error("Parent ownership scope is stopping");

      const scope: OwnershipScope = {
        handle: `scope-${randomUUID()}`,
        ...(parent ? { parentHandle: parent.handle } : {}),
        children: new Set(),
        taskIds: new Set(),
        frozen: false,
      };
      scopes.set(scope.handle, scope);
      parent?.children.add(scope.handle);
      try {
        const taskId = await deps.spawn(request);
        if (scope.frozen) {
          await deps.stopTask(taskId);
          throw new Error("Ownership scope was stopped while spawn was settling");
        }
        scope.taskIds.add(taskId);
        taskOwners.set(taskId, scope.handle);
        return { id: taskId, handle: scope.handle };
      } catch (error) {
        scopes.delete(scope.handle);
        parent?.children.delete(scope.handle);
        throw error;
      }
    }),
  );

  unsubscribers.push(
    handleRpc<{
      requestId: string;
      protocolVersion: number;
      handle: string;
      timeoutMs?: number;
    }>(deps.events, "pi-subagents:rpc:v3:stop", async (request) => {
      requireVersion(request.protocolVersion);
      const root = requireScope(scopes, request.handle);
      const ordered = descendantFirst(scopes, root);
      for (const scope of ordered) scope.frozen = true;

      const failures: string[] = [];
      for (const scope of ordered) {
        for (const taskId of scope.taskIds) {
          try {
            await deps.stopTask(taskId);
          } catch (error) {
            failures.push(`${taskId}: ${errorMessage(error)}`);
          }
        }
      }
      const taskIds = ordered.flatMap((scope) => [...scope.taskIds]);
      const timeoutMs = Math.max(1, request.timeoutMs ?? 10_000);
      const deadline = Date.now() + timeoutMs;
      while (
        taskIds.some((taskId) => !deps.isTaskSettled(taskId)) &&
        Date.now() < deadline
      ) {
        await sleep(25);
      }
      const unsettled = taskIds.filter((taskId) => !deps.isTaskSettled(taskId));
      failures.push(...unsettled.map((taskId) => `${taskId}: did not settle before timeout`));
      if (unsettled.length === 0) removeScopes(scopes, taskOwners, ordered);
      return { settled: unsettled.length === 0, failures };
    }),
  );

  return {
    dispose() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      scopes.clear();
      taskOwners.clear();
    },
    settleTask(taskId: string) {
      const owner = taskOwners.get(taskId);
      if (!owner) return;
      scopes.get(owner)?.taskIds.delete(taskId);
      taskOwners.delete(taskId);
    },
  };
}

function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  handler: (request: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const request = raw as P;
    if (!request || typeof request.requestId !== "string") return;
    try {
      const data = await handler(request);
      events.emit(`${channel}:reply:${request.requestId}`, { success: true, data });
    } catch (error) {
      events.emit(`${channel}:reply:${request.requestId}`, {
        success: false,
        error: errorMessage(error),
      });
    }
  });
}

function requireVersion(version: number): void {
  if (version !== TASK_RPC_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported task RPC protocol ${version}; expected ${TASK_RPC_PROTOCOL_VERSION}`,
    );
  }
}

function requireScope(
  scopes: Map<string, OwnershipScope>,
  handle: string,
): OwnershipScope {
  const scope = scopes.get(handle);
  if (!scope) throw new Error("Ownership scope not found");
  return scope;
}

function descendantFirst(
  scopes: Map<string, OwnershipScope>,
  root: OwnershipScope,
): OwnershipScope[] {
  const result: OwnershipScope[] = [];
  const visit = (scope: OwnershipScope) => {
    for (const child of scope.children) {
      const value = scopes.get(child);
      if (value) visit(value);
    }
    result.push(scope);
  };
  visit(root);
  return result;
}

function removeScopes(
  scopes: Map<string, OwnershipScope>,
  taskOwners: Map<string, string>,
  ordered: readonly OwnershipScope[],
): void {
  for (const scope of ordered) {
    for (const taskId of scope.taskIds) taskOwners.delete(taskId);
    if (scope.parentHandle) scopes.get(scope.parentHandle)?.children.delete(scope.handle);
    scopes.delete(scope.handle);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
