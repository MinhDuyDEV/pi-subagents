# Integration API

Import from `@minhduydev/pi-subagents/api`.

## Lifecycle protocol v1

```ts
import {
  TASK_LIFECYCLE_EVENTS,
  TASK_LIFECYCLE_PROTOCOL_VERSION,
} from "@minhduydev/pi-subagents/api";
```

Events emitted on `pi.events`:

- `pi-subagents:task-started`
- `pi-subagents:task-settled`
- `pi-subagents:batch-settled`

All payloads contain `protocolVersion` and timestamp. Task events contain canonical `taskId`; started events also expose `invocationId`, batch, agent, description and backend where available. Payload types are exported as `TaskStartedEventV1`, `TaskSettledEventV1`, `BatchSettledEventV1`, and `TaskLifecycleEventMapV1`.

## RPC protocol v3

Request/reply channels use per-request replies:

```text
request: pi-subagents:rpc:v3:<method>
reply:   pi-subagents:rpc:v3:<method>:reply:<requestId>
```

### Ping

```ts
{ requestId, protocolVersion: 3 }
```

### Spawn

```ts
{
  requestId,
  protocolVersion: 3,
  parentHandle?: string,
  agentType: string,
  prompt: string,
  description: string,
  options?: Record<string, unknown>
}
```

Success data: `{ id: taskId, handle: ownershipScope }`.

### Stop

```ts
{
  requestId,
  protocolVersion: 3,
  handle: string,
  timeoutMs?: number
}
```

The runtime freezes the scope, recursively cancels descendants first, waits for settlement, and returns `{ settled, failures }`.

Reply envelope:

```ts
type Reply<T> =
  | { success: true; data: T }
  | { success: false; error: string };
```

## Durable/runtime helpers

Exported helpers include:

- `listDurableRuns`, `getDurableRunByTaskId`, and phase/run types
- typed evidence receipt record/list/verification helpers
- `createTaskWorktree`, inspection/finalization, gated-runtime merge primitive, and removal helpers
- `TaskScheduler`, `TaskSchedule`, and `CreateTaskScheduleInput`
- the typed `HerdrClient` and structured error/status types

External extensions should treat returned run records as snapshots and coordinate lifecycle mutations through task/RPC operations rather than editing JSON files. Low-level worktree and scheduler exports are building blocks; callers remain responsible for applying the same ownership and ship gates used by `task_control`.
