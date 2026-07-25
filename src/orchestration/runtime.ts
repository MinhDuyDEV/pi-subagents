import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { TSchema } from "typebox";
import { readRegistry } from "../conversation.js";
import { findPiDir } from "../helpers.js";
import { getAgentTerminalStopReason } from "../session-text.js";
import type { WorktreeHandle } from "../worktree.js";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  acquireResourceLease,
  assertNoConflictingWrite,
  listActiveResourceLeases,
  renewResourceLease,
  transferResourceLeaseOwnership,
  type ResourceLease,
} from "./claims.js";
import {
  buildContextPack,
  loadContextPack,
  renderContextPackForPrompt,
  saveContextPack,
  type ContextPack,
} from "./context.js";
import {
  SUBAGENT_LEARNING_EVENTS_V1,
  makeContextRequestPayload,
  validateLearningContext,
  mergeLearningFacts,
} from "../events.js";
import {
  recordBackgroundCompletion,
  recordForegroundCompletion,
  releaseLeaseAndRecord,
  type ActiveRun,
} from "./completion.js";
import {
  OrchestrationRequestSchema,
  parseOrchestrationRequest,
} from "./contract.js";
import {
  renderBackgroundReceipt,
  resolveTaskSessionReference,
} from "./lifecycle.js";
import { getOrchestrationPaths, type OrchestrationPaths } from "./paths.js";
import { appendOrchestrationEvent } from "./telemetry.js";
import {
  createDurableRun,
  getDurableRunByInvocationId,
  getDurableRunByTaskId,
  isTerminalExecutionPhase,
  listDurableRuns,
  patchDurableRun,
  putDurableRun,
  type DurableTaskRun,
} from "./run-store.js";
import { seedResumeRegistry } from "./task-state.js";
import { registerTaskControlTool } from "./tool.js";
import { registerTaskCommands, stopOwnedTask } from "./commands.js";
import { registerTaskRpc, type TaskRpcHandle } from "./rpc.js";
import { TaskScheduler } from "./scheduler.js";
import { getFinalTaskResult, getTaskSnapshot } from "./task-query.js";

interface PendingCompletion {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options?: Parameters<ExtensionAPI["sendMessage"]>[1];
  queuedAt: number;
}

interface RuntimeState {
  activeRuns: Map<string, ActiveRun>;
  pendingCompletions: Map<string, PendingCompletion[]>;
  pendingBatchMessages: Map<
    string,
    Array<{
      message: Parameters<ExtensionAPI["sendMessage"]>[0];
      options?: Parameters<ExtensionAPI["sendMessage"]>[1];
    }>
  >;
  batchTimers: Map<string, NodeJS.Timeout>;
  projectDirectories: Set<string>;
  startedInvocations: Set<string>;
  launchedTaskIds: Map<string, string>;
  schedulers: Map<string, TaskScheduler>;
  taskTool?: ToolDefinition<TSchema, unknown>;
  currentContext?: ExtensionContext;
  rpcHandle?: TaskRpcHandle;
  heartbeatTimer?: NodeJS.Timeout;
}

class EvidenceOnlyProofError extends Error {
  constructor(taskId: string, issues: readonly string[]) {
    super(`Evidence-only review failed for ${taskId}: ${issues.join(" ")}`);
    this.name = "EvidenceOnlyProofError";
  }
}

export type UpstreamTaskExtension = (pi: ExtensionAPI) => void;

export function resolveUpstreamTaskExtension(
  moduleValue: unknown,
): UpstreamTaskExtension {
  if (typeof moduleValue === "function") {
    return moduleValue as UpstreamTaskExtension;
  }
  if (isRecord(moduleValue) && typeof moduleValue.default === "function") {
    return moduleValue.default as UpstreamTaskExtension;
  }
  throw new Error("The upstream task package does not export a valid default extension");
}

export function createTaskRuntime(
  upstreamTaskExtension: UpstreamTaskExtension,
): UpstreamTaskExtension {
  return (pi) => {
    // Child Pi processes load the package to resolve normal tools and profiles,
    // but must never receive the parent control plane.
    if (process.env.PI_TASK_TOOL_DISABLED === "1") {
      upstreamTaskExtension(pi);
      return;
    }

    const state: RuntimeState = {
      activeRuns: new Map(),
      pendingCompletions: new Map(),
      pendingBatchMessages: new Map(),
      batchTimers: new Map(),
      projectDirectories: new Set(),
      startedInvocations: new Set(),
      launchedTaskIds: new Map(),
      schedulers: new Map(),
    };
    upstreamTaskExtension(createTaskExtensionProxy(pi, state));
    pi.events.on("pi-subagents:task-launched", (payload: unknown) => {
      void handleTaskLaunched(pi, state, payload).catch((error) => {
        pi.sendMessage(
          {
            customType: "orchestration-launch-event-failed",
            content: `Task launch state could not be persisted: ${errorMessage(error)}`,
            display: true,
          },
          { triggerTurn: false },
        );
      });
    });
    state.rpcHandle = registerTaskRpc({
      events: pi.events,
      spawn: (request) => invokeTaskThroughRpc(state, request),
      stopTask: async (taskId) => {
        const run = state.activeRuns.get(taskId);
        const projectDirectory = run?.projectDirectory ?? state.currentContext?.cwd;
        if (!projectDirectory) throw new Error("No active project for task stop");
        try {
          await stopOwnedTask(
            projectDirectory,
            taskId,
            "Stopped by RPC ownership scope",
          );
        } finally {
          state.activeRuns.delete(taskId);
          pi.events.emit("pi-subagents:task-stopped", {
            protocolVersion: 1,
            taskId,
            timestamp: new Date().toISOString(),
          });
        }
      },
      isTaskSettled: (taskId) => !state.activeRuns.has(taskId),
    });
    registerTaskControlTool(pi);
    registerTaskCommands(pi);
    registerWriteClaimGuard(pi);
    state.heartbeatTimer = startLeaseHeartbeats(state);
    pi.on("session_start", async (_event, ctx) => {
      state.currentContext = ctx;
      state.projectDirectories.add(ctx.cwd);
      const paths = getOrchestrationPaths(ctx.cwd);
      const storedRuns = await listDurableRuns(paths.runStore).catch(() => []);
      const runs = await recoverAllocatingRuns(ctx.cwd, paths, storedRuns);
      for (const run of runs) {
        if (!run.taskId || isTerminalExecutionPhase(run.executionPhase)) continue;
        state.activeRuns.set(run.taskId, {
          invocationId: run.invocationId,
          orchestrationId: run.correlationId ?? run.invocationId,
          taskId: run.taskId,
          agentType: run.agentType,
          startedAt: run.startedAt,
          lease: run.lease,
          leaseTtlMs: run.leaseTtlMs,
          lastHeartbeatAt: Date.parse(run.heartbeatAt),
          contextPack: run.contextPack,
          proof: run.proof,
          verifier: run.verifier,
          projectDirectory: run.projectDirectory,
          executionDirectory: run.executionDirectory,
          batchId: run.batchId,
          joinMode: run.joinMode,
        });
      }
      await reconcileRestoredCompletions(pi, state, ctx.cwd);
      await ensureScheduler(state, paths.scheduleStore, ctx);
    });
    pi.on("session_shutdown", () => {
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      for (const timer of state.batchTimers.values()) clearTimeout(timer);
      state.batchTimers.clear();
      for (const scheduler of state.schedulers.values()) scheduler.dispose();
      state.schedulers.clear();
      state.rpcHandle?.dispose();
      state.rpcHandle = undefined;
      state.currentContext = undefined;
    });
  };
}

function createTaskExtensionProxy(
  pi: ExtensionAPI,
  state: RuntimeState,
): ExtensionAPI {
  const registerTool = ((definition: ToolDefinition<TSchema, unknown>) => {
    if (definition.name === "task") {
      const taskTool = createOrchestratedTaskTool(definition, state, pi);
      state.taskTool = taskTool;
      pi.registerTool(taskTool);
      return;
    }
    pi.registerTool(definition);
  }) as ExtensionAPI["registerTool"];

  const sendMessage = ((
    message: Parameters<ExtensionAPI["sendMessage"]>[0],
    options?: Parameters<ExtensionAPI["sendMessage"]>[1],
  ) => {
    const messageValue: unknown = message;
    if (!isRecord(messageValue) || messageValue.customType !== "task-complete") {
      pi.sendMessage(message, options);
      return;
    }

    const details = isRecord(messageValue.details) ? messageValue.details : undefined;
    const taskId = stringValue(details?.task_id) ?? stringValue(details?.taskId);
    if (taskId && !state.activeRuns.has(taskId)) {
      const pending = state.pendingCompletions.get(taskId) ?? [];
      pending.push({
        message,
        queuedAt: Date.now(),
        ...(options ? { options } : {}),
      });
      state.pendingCompletions.set(taskId, pending);
      // A plain or restored task may not have an in-memory run. Give launch
      // registration a short window, then reconcile from the durable store.
      setTimeout(() => void flushPendingCompletion(pi, state, taskId), 50).unref();
      return;
    }
    void finalizeAndForwardCompletion(pi, state, message, options);
  }) as ExtensionAPI["sendMessage"];

  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return registerTool;
      }
      if (property === "sendMessage") {
        return sendMessage;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createOrchestratedTaskTool(
  upstreamTool: ToolDefinition<TSchema, unknown>,
  state: RuntimeState,
  pi: ExtensionAPI,
): ToolDefinition<TSchema, unknown> {
  const parameters = extendTaskParameterSchema(upstreamTool.parameters);

  return {
    ...upstreamTool,
    description: `${upstreamTool.description}\n\nOptional orchestration adds durable resource ownership, Context Packs, evidence receipts, grouped completion, worktree isolation, and independent review state. Use task_control for status, result, handoff, review, metrics, and doctor actions.`,
    parameters: parameters as TSchema,
    async execute(toolCallId, parametersValue, signal, onUpdate, ctx) {
      const rawParameters = toRecord(parametersValue);
      const orchestration = parseOrchestrationRequest(rawParameters.orchestration);
      const invocationId = randomUUID();
      const orchestrationId = orchestration?.id ?? `run-${invocationId}`;
      const paths = getOrchestrationPaths(ctx.cwd);
      state.projectDirectories.add(ctx.cwd);
      if (orchestration?.schedule) {
        const scheduler = await ensureScheduler(state, paths.scheduleStore, ctx);
        const scheduledParameters = structuredClone(parametersValue);
        const scheduledRecord = toRecord(scheduledParameters);
        scheduledRecord.background = true;
        const scheduledOrchestration = toRecord(scheduledRecord.orchestration);
        delete scheduledOrchestration.schedule;
        const schedule = await scheduler.add({
          name:
            stringValue(rawParameters.description) ??
            stringValue(rawParameters.agent_type) ??
            "scheduled-task",
          projectDirectory: ctx.cwd,
          cron: orchestration.schedule.cron,
          at: orchestration.schedule.at,
          timezone: orchestration.schedule.timezone,
          maxRuns: orchestration.schedule.maxRuns,
          parameters: scheduledRecord,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Scheduled task ${schedule.id}; next run ${schedule.nextRunAt}.`,
            },
          ],
          details: {
            phase: "scheduled",
            schedule_id: schedule.id,
            next_run_at: schedule.nextRunAt,
          },
        };
      }
      const agentType = stringValue(rawParameters.agent_type);
      const description = stringValue(rawParameters.description);
      const isBackground = rawParameters.background !== false;
      const resumedTaskId = stringValue(rawParameters.task_id);
      let canonicalTaskId = resumedTaskId;
      let lease: ResourceLease | undefined;
      let leaseOwner: string = invocationId;
      let launchLeaseHeartbeat: NodeJS.Timeout | undefined;
      let contextPack: ContextPack | undefined;
      const startedAt = new Date().toISOString();
      const explicitProof = orchestration?.proof;
      const isWriteAuthorized =
        orchestration?.context?.authorization === "write-approved" ||
        orchestration?.context?.authorization === "sensitive-approved";
      const honorNoProofEnv =
        process.env.PI_SUBAGENTS_NO_PROOF === "1" &&
        !(isWriteAuthorized && !explicitProof);
      const effectiveProof = honorNoProofEnv
        ? undefined
        : explicitProof ??
          (isWriteAuthorized ? { mode: "evidence-only" as const } : undefined);

      try {
        if (orchestration?.claims && orchestration.claims.length > 0 && process.env.PI_SUBAGENTS_NO_CLAIMS !== "1") {
          lease = await acquireResourceLease({
            storePath: paths.leaseStore,
            owner: invocationId,
            claims: orchestration.claims,
            ttlMs: orchestration.leaseTtlMs,
          });
          await appendOrchestrationEvent({
            eventPath: paths.eventLog,
            event: {
              type: "claim_acquired",
              orchestrationId,
              leaseId: lease.id,
              agentType,
              idempotencyKey: `${invocationId}:lease:acquired`,
            },
          });
          launchLeaseHeartbeat = setInterval(() => {
            if (!lease) return;
            const launchedTaskId = state.launchedTaskIds.get(invocationId);
            const alignOwner =
              launchedTaskId && lease.owner !== launchedTaskId
                ? transferResourceLeaseOwnership({
                    storePath: paths.leaseStore,
                    leaseId: lease.id,
                    owner: launchedTaskId,
                  })
                : Promise.resolve(lease);
            void alignOwner
              .then(async (aligned) => {
                if (!aligned) return;
                lease = aligned;
                leaseOwner = aligned.owner;
                const renewed = await renewResourceLease({
                  storePath: paths.leaseStore,
                  leaseId: aligned.id,
                  owner: leaseOwner,
                  ttlMs: orchestration.leaseTtlMs,
                });
                if (!renewed) return;
                lease = renewed;
                await patchDurableRun(paths.runStore, invocationId, {
                  lease: renewed,
                  heartbeatAt: new Date().toISOString(),
                }).catch(() => undefined);
              })
              .catch(() => undefined);
          }, leaseHeartbeatInterval(orchestration.leaseTtlMs));
          launchLeaseHeartbeat.unref();
        }

        if (resumedTaskId) {
          await seedResumeRegistry(ctx.cwd, resumedTaskId);
        }

        // The context request is an event, so establish the durable run first.
        // This preserves durable-before-emit without changing task ID semantics.
        if (!resumedTaskId) {
          await putDurableRun(
            paths.runStore,
            createDurableRun({
              invocationId,
              correlationId: orchestration?.id,
              batchId: orchestration?.batchId,
              joinMode: orchestration?.join,
              agentType,
              description,
              projectDirectory: ctx.cwd,
              startedAt,
              claims: orchestration?.claims,
              lease,
              leaseTtlMs: orchestration?.leaseTtlMs,
              proof: effectiveProof,
              verifier: orchestration?.verifier,
            }),
          );
        }

        // ── Optional learning context request (fail-open) ──────────
        if (pi?.events && !resumedTaskId) {
          const contextRequest = makeContextRequestPayload(
            invocationId,
            agentType ?? "unknown",
            description ?? "",
            orchestration?.id ?? invocationId,
          );
          try {
            await pi.events.emit(
              SUBAGENT_LEARNING_EVENTS_V1.CONTEXT_REQUEST,
              contextRequest,
            );
            if (contextRequest.response) {
              const validated = validateLearningContext(contextRequest.response);
              if (validated && validated.facts.length > 0) {
                // Merge learning facts into orchestration context as
                // provenance-labelled non-authoritative entries.
                // This never overrides user prompt or policy.
                const existingFacts = orchestration?.context?.knownFacts;
                const mergedFacts = mergeLearningFacts(existingFacts, validated, 1200);
                if (mergedFacts.length > (existingFacts?.length ?? 0)) {
                  const contextInput = {
                    ...(orchestration?.context ?? { goal: description ?? "", authorization: "read-only" as const, nextStep: "" }),
                    knownFacts: mergedFacts,
                  };
                  contextPack = await buildContextPack({
                    projectDirectory: ctx.cwd,
                    input: contextInput,
                  });
                }
              }
            }
          } catch {
            // fail-open: listener error must not block task launch
          }
        }

        if (!contextPack && orchestration?.context) {
          contextPack = await buildContextPack({
            projectDirectory: ctx.cwd,
            input: orchestration.context,
          });
        } else if (resumedTaskId) {
          contextPack = await loadContextPack({
            storeDirectory: paths.contextStore,
            key: resumedTaskId,
          });
        }

        await putDurableRun(
          paths.runStore,
          createDurableRun({
            invocationId,
            correlationId: orchestration?.id,
            batchId: orchestration?.batchId,
            joinMode: orchestration?.join,
            agentType,
            description,
            projectDirectory: ctx.cwd,
            startedAt,
            claims: orchestration?.claims,
            lease,
            leaseTtlMs: orchestration?.leaseTtlMs,
            contextPack,
            proof: effectiveProof,
            verifier: orchestration?.verifier,
          }),
        );

        const upstreamParametersValue = structuredClone(parametersValue);
        const upstreamParameters = toRecord(upstreamParametersValue);
        delete upstreamParameters.orchestration;
        if (taskToolSupportsLaunchEvents(upstreamTool.parameters)) {
          upstreamParameters.__pi_subagents_invocation_id = invocationId;
        }
        if (orchestration?.isolation && upstreamParameters.isolation === undefined) {
          upstreamParameters.isolation = orchestration.isolation;
        }
        if (contextPack) {
          const prompt = stringValue(upstreamParameters.prompt) ?? "";
          upstreamParameters.prompt = `${prompt.trim()}\n\n${renderContextPackForPrompt(contextPack)}`;
        }

        const upstreamResult = await upstreamTool.execute(
          toolCallId,
          upstreamParametersValue,
          signal,
          onUpdate,
          ctx,
        );
        canonicalTaskId = taskIdFromResult(upstreamResult) ?? resumedTaskId;
        if (!canonicalTaskId) {
          if (isFailedTaskResult(upstreamResult)) {
            if (lease) {
              await releaseLeaseAndRecord(paths, orchestrationId, lease);
              lease = undefined;
            }
            await patchDurableRun(paths.runStore, invocationId, {
              executionPhase: "failed",
              verificationIssues: [taskResultFailureReason(upstreamResult)],
            });
            await appendOrchestrationEvent({
              eventPath: paths.eventLog,
              event: {
                type: "task_failed",
                orchestrationId,
                agentType,
                reason: taskResultFailureReason(upstreamResult),
              },
            });
            return upstreamResult;
          }
          throw new Error("Upstream task result did not include a task ID");
        }
        const taskId = canonicalTaskId;
        const registryEntry = readRegistry(findPiDir(ctx.cwd) ?? resolve(ctx.cwd, ".pi")).find(
          (entry) => entry.id === taskId,
        );
        const upstreamDetails = isRecord(upstreamResult.details)
          ? upstreamResult.details
          : undefined;
        const resultWorktree = isRecord(upstreamDetails?.worktree)
          ? upstreamDetails.worktree
          : undefined;
        const resultWorktreePath = stringValue(resultWorktree?.path);
        const executionDirectory =
          registryEntry?.worktree?.path ?? resultWorktreePath ?? ctx.cwd;

        if (lease) {
          lease =
            (await transferResourceLeaseOwnership({
              storePath: paths.leaseStore,
              leaseId: lease.id,
              owner: taskId,
            })) ?? lease;
          leaseOwner = taskId;
        }
        if (contextPack) {
          await saveContextPack({
            storeDirectory: paths.contextStore,
            key: taskId,
            pack: contextPack,
          });
        }
        await patchDurableRun(paths.runStore, invocationId, {
          taskId,
          executionPhase: "working",
          executionDirectory,
          ...(registryEntry?.worktree ? { worktree: registryEntry.worktree } : {}),
          heartbeatAt: new Date().toISOString(),
          ...(lease ? { lease } : {}),
        });
        if (!state.startedInvocations.has(invocationId)) {
          state.startedInvocations.add(invocationId);
          state.launchedTaskIds.set(invocationId, taskId);
          await appendOrchestrationEvent({
            eventPath: paths.eventLog,
            event: {
              type: resumedTaskId ? "task_resumed" : "task_started",
              orchestrationId,
              taskId,
              agentType,
              timestamp: startedAt,
              idempotencyKey: `${invocationId}:execution:started`,
            },
          });
          pi.events.emit("pi-subagents:task-started", {
            protocolVersion: 1,
            taskId,
            invocationId,
            batchId: orchestration?.batchId,
            agentType,
            description,
            backend:
              registryEntry?.handle?.backend ?? stringValue(upstreamDetails?.backend),
            timestamp: startedAt,
          });
        }

        const activeRun: ActiveRun = {
          invocationId,
          orchestrationId,
          taskId,
          agentType,
          startedAt,
          lease,
          leaseTtlMs: orchestration?.leaseTtlMs,
          lastHeartbeatAt: Date.now(),
          contextPack,
          proof: effectiveProof,
          verifier: orchestration?.verifier,
          projectDirectory: ctx.cwd,
          executionDirectory,
          batchId: orchestration?.batchId,
          joinMode: orchestration?.join,
        };
        if (isFailedTaskResult(upstreamResult)) {
          await recordForegroundCompletion(activeRun, paths, upstreamResult);
          if (lease) lease = undefined;
          return upstreamResult;
        }
        if (isBackground) {
          state.activeRuns.set(taskId, activeRun);
          void flushPendingCompletion(pi, state, taskId);
          return normalizeTaskReceipt(upstreamResult, {
            projectDirectory: ctx.cwd,
            taskId,
          });
        }

        // PI_SUBAGENTS_NO_PROOF stays an escape hatch, but it must not silently
        // disable the default evidence-only proof for write/sensitive tasks.
        // Honor the env var only when the caller made an explicit proof choice, or
        // for non-write tasks (preserving existing behavior).
        const proof = await recordForegroundCompletion(
          activeRun,
          paths,
          upstreamResult,
        );
        if (lease) lease = undefined;
        if (proof && !proof.valid) {
          throw new EvidenceOnlyProofError(taskId, proof.issues);
        }
        const durable = await getDurableRunByTaskId(paths.runStore, taskId).catch(
          () => undefined,
        );
        if (durable?.reviewPhase === "awaiting") {
          return markResultAwaitingReview(upstreamResult, taskId);
        }
        return upstreamResult;
      } catch (error) {
        if (error instanceof EvidenceOnlyProofError) {
          throw error;
        }
        if (lease) {
          await releaseLeaseAndRecord(paths, orchestrationId, lease);
        }
        const current = await getDurableRunByInvocationId(
          paths.runStore,
          invocationId,
        ).catch(() => undefined);
        if (!current || !isTerminalExecutionPhase(current.executionPhase)) {
          await patchDurableRun(paths.runStore, invocationId, {
            ...(canonicalTaskId ? { taskId: canonicalTaskId } : {}),
            executionPhase: "failed",
            verificationIssues: [errorMessage(error)],
          }).catch(() => undefined);
          await appendOrchestrationEvent({
            eventPath: paths.eventLog,
            event: {
              type: "task_failed",
              orchestrationId,
              taskId: canonicalTaskId,
              agentType,
              reason: errorMessage(error),
              idempotencyKey: `${invocationId}:execution:failed`,
            },
          });
        }
        throw error;
      } finally {
        if (launchLeaseHeartbeat) clearInterval(launchLeaseHeartbeat);
        state.startedInvocations.delete(invocationId);
        state.launchedTaskIds.delete(invocationId);
      }
    },
  };
}

async function normalizeTaskReceipt(
  result: AgentToolResult<unknown>,
  input: { projectDirectory: string; taskId: string },
): Promise<AgentToolResult<unknown>> {
  const sessionName = `task-${input.taskId}`;
  const sessionReference = await resolveTaskSessionReference({
    projectDirectory: input.projectDirectory,
    taskId: input.taskId,
    sessionName,
  });
  const receipt = renderBackgroundReceipt({
    taskId: input.taskId,
    sessionName,
    sessionReference,
  });
  const content = result.content.map((item, index) => {
    if (index !== 0 || item.type !== "text") {
      return item;
    }
    const retained = item.text
      .split("\n")
      .filter((line) => !line.startsWith("Subagent session:"))
      .join("\n")
      .trim();
    return { ...item, text: `${retained}\n${receipt}` };
  });
  return { ...result, content };
}

function parseWorktreeHandle(value: unknown): WorktreeHandle | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.repositoryRoot !== "string" ||
    typeof value.path !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.baseSha !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    repositoryRoot: value.repositoryRoot,
    path: value.path,
    branch: value.branch,
    baseSha: value.baseSha,
    createdAt: value.createdAt,
  };
}

function taskToolSupportsLaunchEvents(schema: TSchema): boolean {
  const rawSchema = schema as unknown as Record<string, unknown>;
  return (
    isRecord(rawSchema.properties) &&
    "__pi_subagents_invocation_id" in rawSchema.properties
  );
}

function extendTaskParameterSchema(schema: TSchema): TSchema {
  const rawSchema = schema as unknown as Record<string, unknown>;
  if (!isRecord(rawSchema.properties)) {
    throw new Error("The upstream task tool must use an object parameter schema");
  }
  const properties = { ...rawSchema.properties };
  delete properties.__pi_subagents_invocation_id;
  return {
    ...rawSchema,
    properties: {
      ...properties,
      orchestration: OrchestrationRequestSchema,
    },
  } as TSchema;
}

function taskIdFromResult(
  result: AgentToolResult<unknown>,
): string | undefined {
  if (isRecord(result.details)) {
    const fromDetails =
      stringValue(result.details.taskId) ?? stringValue(result.details.task_id);
    if (fromDetails) {
      return fromDetails;
    }
  }
  for (const item of result.content) {
    if (item.type !== "text") {
      continue;
    }
    const match = item.text.match(/(?:Task ID:|Started task)\s+([A-Za-z0-9_-]+)/u);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function isFailedTaskResult(result: AgentToolResult<unknown>): boolean {
  if (isRecord(result) && result.isError === true) return true;
  if (!isRecord(result.details)) return false;
  const phase = String(
    result.details.execution_phase ?? result.details.phase ?? "",
  ).toLowerCase();
  return ["failed", "error", "cancelled", "canceled", "timeout"].includes(phase);
}

function taskResultFailureReason(result: AgentToolResult<unknown>): string {
  if (isRecord(result.details)) {
    const reason =
      stringValue(result.details.error) ?? stringValue(result.details.summary);
    if (reason) return reason;
  }
  const text = result.content.find((item) => item.type === "text");
  return text?.type === "text" ? text.text : "Task failed before launch";
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Task parameters must be an object");
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleTaskLaunched(
  pi: ExtensionAPI,
  state: RuntimeState,
  payload: unknown,
): Promise<void> {
  if (!isRecord(payload)) return;
  const invocationId = stringValue(payload.invocationId);
  const taskId = stringValue(payload.taskId);
  if (!invocationId || !taskId || state.startedInvocations.has(invocationId)) return;
  state.launchedTaskIds.set(invocationId, taskId);
  state.startedInvocations.add(invocationId);

  for (const projectDirectory of state.projectDirectories) {
    const paths = getOrchestrationPaths(projectDirectory);
    const run = await getDurableRunByInvocationId(
      paths.runStore,
      invocationId,
    ).catch(() => undefined);
    if (!run) continue;
    const executionDirectory =
      stringValue(payload.executionDirectory) ?? run.executionDirectory;
    const worktree = parseWorktreeHandle(payload.worktree);
    await patchDurableRun(paths.runStore, invocationId, {
      taskId,
      executionPhase:
        run.executionPhase === "allocating" || run.executionPhase === "starting"
          ? "working"
          : run.executionPhase,
      executionDirectory,
      ...(worktree ? { worktree } : {}),
      heartbeatAt: new Date().toISOString(),
    });
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: payload.resumed === true ? "task_resumed" : "task_started",
        orchestrationId: run.correlationId ?? invocationId,
        taskId,
        agentType: stringValue(payload.agentType) ?? run.agentType,
        timestamp: stringValue(payload.timestamp),
        idempotencyKey: `${invocationId}:execution:started`,
      },
    });
    pi.events.emit("pi-subagents:task-started", {
      protocolVersion: 1,
      taskId,
      invocationId,
      batchId: run.batchId,
      agentType: stringValue(payload.agentType) ?? run.agentType,
      description: stringValue(payload.description) ?? run.description,
      backend: stringValue(payload.backend),
      timestamp: stringValue(payload.timestamp) ?? new Date().toISOString(),
    });
    return;
  }
}

async function reconcileRestoredCompletions(
  pi: ExtensionAPI,
  state: RuntimeState,
  projectDirectory: string,
): Promise<void> {
  const candidates = [...state.activeRuns.values()].filter(
    (run) => run.projectDirectory === projectDirectory,
  );
  for (const run of candidates) {
    const snapshot = await getTaskSnapshot(projectDirectory, run.taskId).catch(
      () => undefined,
    );
    if (!snapshot) continue;
    let status = snapshot.status.toLowerCase();
    const stopReason = snapshot.sessionReference
      ? getAgentTerminalStopReason(
          dirname(snapshot.sessionReference),
          snapshot.sessionName,
          Date.parse(run.startedAt),
        )
      : undefined;
    if (["stop", "endTurn", "length"].includes(stopReason ?? "")) status = "done";
    if (stopReason === "error") status = "failed";
    if (stopReason === "aborted") status = "cancelled";
    if (
      ![
        "done",
        "completed",
        "failed",
        "cancelled",
        "canceled",
        "timeout",
      ].includes(status)
    ) {
      continue;
    }
    const completed = status === "done" || status === "completed";
    if (completed && !["stop", "endTurn", "length"].includes(stopReason ?? "")) {
      continue;
    }
    const result = completed
      ? await getFinalTaskResult(snapshot).catch(() => undefined)
      : undefined;
    const executionPhase = completed
      ? "done"
      : status === "canceled"
        ? "cancelled"
        : status;
    await finalizeAndForwardCompletion(
      pi,
      state,
      {
        customType: "task-complete",
        content: completed
          ? `Recovered completed background task ${run.taskId}.\n\n${result ?? "No final assistant text was recorded."}`
          : `Recovered background task ${run.taskId} in terminal state ${executionPhase}.`,
        display: true,
        details: {
          task_id: run.taskId,
          agent_type: run.agentType,
          phase: executionPhase,
          execution_phase: executionPhase,
          result,
          summary: result,
          background: true,
          project_directory: projectDirectory,
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
}

async function recoverAllocatingRuns(
  projectDirectory: string,
  paths: OrchestrationPaths,
  runs: readonly DurableTaskRun[],
): Promise<DurableTaskRun[]> {
  const recovered = runs.map((run) => structuredClone(run));
  const piDirectory = findPiDir(projectDirectory) ?? resolve(projectDirectory, ".pi");
  const entries = readRegistry(piDirectory);
  const assignedTaskIds = new Set(
    recovered.flatMap((run) => (run.taskId ? [run.taskId] : [])),
  );

  for (let index = 0; index < recovered.length; index += 1) {
    const run = recovered[index]!;
    if (
      run.taskId ||
      (run.executionPhase !== "allocating" && run.executionPhase !== "starting")
    ) {
      continue;
    }
    const startedAt = Date.parse(run.startedAt);
    const candidates = entries.filter(
      (entry) =>
        !assignedTaskIds.has(entry.id) &&
        entry.agentType === run.agentType &&
        entry.description === run.description &&
        Number.isFinite(startedAt) &&
        entry.startedAt >= startedAt - 5_000 &&
        entry.startedAt <= startedAt + 10 * 60_000,
    );
    if (candidates.length !== 1) continue;
    const entry = candidates[0]!;
    let lease = run.lease;
    if (lease) {
      const transferred = await transferResourceLeaseOwnership({
        storePath: paths.leaseStore,
        leaseId: lease.id,
        owner: entry.id,
      }).catch(() => undefined);
      if (!transferred) continue;
      lease = transferred;
    } else if (run.claims.length > 0) {
      const reacquired = await acquireResourceLease({
        storePath: paths.leaseStore,
        owner: entry.id,
        claims: run.claims,
        ttlMs: run.leaseTtlMs,
      }).catch(() => undefined);
      if (!reacquired) continue;
      lease = reacquired;
    }
    const patch: Partial<DurableTaskRun> = {
      taskId: entry.id,
      executionPhase: "working",
      executionDirectory: entry.worktree?.path ?? projectDirectory,
      heartbeatAt: new Date().toISOString(),
      ...(entry.worktree ? { worktree: entry.worktree } : {}),
      ...(lease ? { lease } : {}),
    };
    await patchDurableRun(paths.runStore, run.invocationId, patch);
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: "task_resumed",
        orchestrationId: run.correlationId ?? run.invocationId,
        taskId: entry.id,
        agentType: run.agentType,
        reason: "Recovered task identity from the durable launch registry",
        idempotencyKey: `${run.invocationId}:identity:recovered`,
      },
    });
    recovered[index] = { ...run, ...patch, updatedAt: new Date().toISOString() };
    assignedTaskIds.add(entry.id);
  }
  return recovered;
}

async function invokeTaskThroughRpc(
  state: RuntimeState,
  request: {
    agentType: string;
    prompt: string;
    description: string;
    options?: Record<string, unknown>;
  },
): Promise<string> {
  const taskTool = state.taskTool;
  const ctx = state.currentContext;
  if (!taskTool || !ctx) throw new Error("No active Pi session for task RPC spawn");
  const parameters = {
    ...(request.options ?? {}),
    agent_type: request.agentType,
    prompt: request.prompt,
    description: request.description,
    background: true,
  };
  const result = await taskTool.execute(
    `rpc-${randomUUID()}`,
    parameters,
    new AbortController().signal,
    undefined,
    ctx,
  );
  const taskId = taskIdFromResult(result);
  if (!taskId) throw new Error("Task RPC spawn did not return a task ID");
  if (isFailedTaskResult(result)) {
    throw new Error(`Task RPC spawn failed for ${taskId}: ${taskResultFailureReason(result)}`);
  }
  return taskId;
}

async function ensureScheduler(
  state: RuntimeState,
  storePath: string,
  ctx: ExtensionContext,
): Promise<TaskScheduler> {
  let scheduler = state.schedulers.get(storePath);
  if (!scheduler) {
    scheduler = new TaskScheduler(storePath);
    state.schedulers.set(storePath, scheduler);
  }
  await scheduler.start(async (parameters, projectDirectory) => {
    const taskTool = state.taskTool;
    if (!taskTool) throw new Error("Task tool is unavailable for scheduled execution");
    const invocationContext = new Proxy(ctx, {
      get(target, property, receiver) {
        if (property === "cwd") return projectDirectory;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const result = await taskTool.execute(
      `schedule-${randomUUID()}`,
      parameters,
      new AbortController().signal,
      undefined,
      invocationContext,
    );
    if (isFailedTaskResult(result)) {
      throw new Error(`Scheduled task launch failed: ${taskResultFailureReason(result)}`);
    }
  });
  return scheduler;
}

function registerWriteClaimGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (process.env.PI_SUBAGENTS_NO_CLAIMS === "1") return;
    const pathsToCheck = extractWritePaths(event.toolName, event.input);
    if (pathsToCheck.length === 0) return;

    const projectDirectory = ctx.cwd;
    const paths = getOrchestrationPaths(projectDirectory);
    try {
      const activeLeases = await listActiveResourceLeases({
        storePath: paths.leaseStore,
      });
      if (activeLeases.length === 0) return;

      for (const rawPath of pathsToCheck) {
        const absolutePath = isAbsolute(rawPath)
          ? resolve(rawPath)
          : resolve(projectDirectory, rawPath.replace(/^@/u, ""));
        const projectRelativePath = relative(projectDirectory, absolutePath);
        if (
          projectRelativePath === ".." ||
          projectRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
          isAbsolute(projectRelativePath)
        ) {
          return {
            block: true,
            reason: `Write blocked: ${rawPath} is outside the project while task leases are active`,
          };
        }
        if (pathEscapesProject(projectDirectory, absolutePath)) {
          return {
            block: true,
            reason: `Write blocked: ${rawPath} resolves outside the project through a symlink`,
          };
        }
        await assertNoConflictingWrite({
          storePath: paths.leaseStore,
          ownerTaskId: "parent",
          path: projectRelativePath.replaceAll("\\", "/"),
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Write blocked:")) {
        return { block: true, reason: error.message };
      }
      pi.sendMessage(
        {
          customType: "orchestration-write-guard-error",
          content: `Write-claim guard could not inspect active leases: ${errorMessage(error)}`,
          display: false,
        },
        { triggerTurn: false },
      );
      return {
        block: true,
        reason: `Write blocked because the mandatory lease store could not be verified: ${errorMessage(error)}`,
      };
    }
  });
}

function pathEscapesProject(
  projectDirectory: string,
  absolutePath: string,
): boolean {
  const projectRoot = realpathSync(resolve(projectDirectory));
  let probe = absolutePath;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const resolvedProbe = realpathSync(probe);
  const relativeProbe = relative(projectRoot, resolvedProbe);
  return (
    relativeProbe === ".." ||
    relativeProbe.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativeProbe)
  );
}

function extractWritePaths(
  toolName: string,
  parameters: unknown,
): string[] {
  if (!isRecord(parameters)) return [];
  if (toolName === "write" || toolName === "edit") {
    const candidate = parameters.path ?? parameters.file_path ?? parameters.filePath;
    return typeof candidate === "string" ? [candidate] : [];
  }
  if (toolName === "apply_patch" && typeof parameters.patch === "string") {
    return [...parameters.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)]
      .map((match) => match[1]?.trim())
      .filter((path): path is string => Boolean(path));
  }
  return [];
}

async function finalizeAndForwardCompletion(
  pi: ExtensionAPI,
  state: RuntimeState,
  message: Parameters<ExtensionAPI["sendMessage"]>[0],
  options?: Parameters<ExtensionAPI["sendMessage"]>[1],
): Promise<void> {
  try {
    const messageDetails = isRecord(message.details) ? message.details : undefined;
    const messageTaskId =
      stringValue(messageDetails?.task_id) ?? stringValue(messageDetails?.taskId);
    const run = messageTaskId ? state.activeRuns.get(messageTaskId) : undefined;
    const outcome = await recordBackgroundCompletion(
      pi,
      state.activeRuns,
      message as Record<string, unknown>,
    );
    const forwarded = applyCompletionOutcome(message, outcome);
    if (run?.joinMode === "group" && run.batchId) {
      queueBatchCompletion(pi, state, run.batchId, forwarded, options);
    } else {
      pi.sendMessage(forwarded, options);
    }
    if (outcome.taskId && outcome.handled) {
      state.rpcHandle?.settleTask(outcome.taskId);
      pi.events.emit("pi-subagents:task-settled", {
        protocolVersion: 1,
        taskId: outcome.taskId,
        executionPhase: outcome.executionPhase,
        verificationPassed: outcome.proof?.valid,
        awaitingReview: outcome.awaitingReview === true,
        issues: outcome.issues,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    pi.sendMessage(
      {
        customType: "orchestration-hook-failed",
        content: `Task completion could not be verified: ${errorMessage(error)}`,
        display: true,
        details: { originalMessage: message },
      },
      { triggerTurn: false },
    );
  }
}

function applyCompletionOutcome(
  message: Parameters<ExtensionAPI["sendMessage"]>[0],
  outcome: Awaited<ReturnType<typeof recordBackgroundCompletion>>,
): Parameters<ExtensionAPI["sendMessage"]>[0] {
  if (!outcome.handled) return message;
  const details = isRecord(message.details) ? message.details : {};
  if (outcome.proof && !outcome.proof.valid) {
    return {
      ...message,
      content: `Task ${outcome.taskId ?? "unknown"} completed execution but verification failed: ${outcome.proof.issues.join(" ")}`,
      details: {
        ...details,
        phase: "verification_failed",
        execution_phase: "done",
        verification_passed: false,
        verification_issues: outcome.proof.issues,
      },
    };
  }
  if (outcome.awaitingReview) {
    return {
      ...message,
      content: `Task ${outcome.taskId ?? "unknown"} completed execution and verification; it is awaiting independent review.`,
      details: {
        ...details,
        phase: "awaiting_review",
        execution_phase: "done",
        verification_passed: true,
      },
    };
  }
  return message;
}

async function flushPendingCompletion(
  pi: ExtensionAPI,
  state: RuntimeState,
  taskId: string,
): Promise<void> {
  const pending = state.pendingCompletions.get(taskId);
  if (!pending?.length) return;

  let allocationInFlight = false;
  if (!state.activeRuns.has(taskId)) {
    for (const projectDirectory of state.projectDirectories) {
      const paths = getOrchestrationPaths(projectDirectory);
      const runs = await listDurableRuns(paths.runStore).catch(() => []);
      const stored = runs
        .filter((candidate) => candidate.taskId === taskId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      allocationInFlight ||= runs.some(
        (candidate) =>
          !candidate.taskId &&
          candidate.executionPhase === "allocating" &&
          Date.now() - Date.parse(candidate.startedAt) < 5_000,
      );
      if (!stored) continue;
      if (isTerminalExecutionPhase(stored.executionPhase)) {
        state.pendingCompletions.delete(taskId);
        return;
      }
      state.activeRuns.set(taskId, {
        invocationId: stored.invocationId,
        orchestrationId: stored.correlationId ?? stored.invocationId,
        taskId,
        agentType: stored.agentType,
        startedAt: stored.startedAt,
        lease: stored.lease,
        leaseTtlMs: stored.leaseTtlMs,
        lastHeartbeatAt: Date.parse(stored.heartbeatAt),
        contextPack: stored.contextPack,
        proof: stored.proof,
        verifier: stored.verifier,
        projectDirectory: stored.projectDirectory,
        executionDirectory: stored.executionDirectory,
        batchId: stored.batchId,
        joinMode: stored.joinMode,
      });
      break;
    }
  }

  if (
    !state.activeRuns.has(taskId) &&
    allocationInFlight &&
    pending.some((item) => Date.now() - item.queuedAt < 5_000)
  ) {
    setTimeout(() => void flushPendingCompletion(pi, state, taskId), 50).unref();
    return;
  }

  // A legacy completion has no run record. Forward it rather than holding it forever.
  state.pendingCompletions.delete(taskId);
  for (const item of pending) {
    if (state.activeRuns.has(taskId)) {
      await finalizeAndForwardCompletion(pi, state, item.message, item.options);
    } else {
      pi.sendMessage(item.message, item.options);
    }
  }
}

function queueBatchCompletion(
  pi: ExtensionAPI,
  state: RuntimeState,
  batchId: string,
  message: Parameters<ExtensionAPI["sendMessage"]>[0],
  options?: Parameters<ExtensionAPI["sendMessage"]>[1],
): void {
  const items = state.pendingBatchMessages.get(batchId) ?? [];
  items.push({ message, ...(options ? { options } : {}) });
  state.pendingBatchMessages.set(batchId, items);
  const currentTimer = state.batchTimers.get(batchId);
  if (currentTimer) clearTimeout(currentTimer);
  const timer = setTimeout(() => {
    state.batchTimers.delete(batchId);
    const completed = state.pendingBatchMessages.get(batchId) ?? [];
    state.pendingBatchMessages.delete(batchId);
    if (completed.length === 0) return;
    const summaries = completed.map((item) => item.message.content).join("\n\n");
    pi.sendMessage(
      {
        customType: "task-batch-complete",
        content: `Task batch ${batchId} settled (${completed.length} tasks).\n\n${summaries}`,
        display: true,
        details: {
          protocolVersion: 1,
          batchId,
          count: completed.length,
          tasks: completed.map((item) => item.message.details),
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    pi.events.emit("pi-subagents:batch-settled", {
      protocolVersion: 1,
      batchId,
      count: completed.length,
      timestamp: new Date().toISOString(),
    });
  }, 500);
  timer.unref();
  state.batchTimers.set(batchId, timer);
}

function startLeaseHeartbeats(state: RuntimeState): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    void Promise.all(
      [...state.activeRuns.values()].map(async (run) => {
        const interval = run.lease
          ? leaseHeartbeatInterval(run.leaseTtlMs)
          : 60_000;
        if (now - (run.lastHeartbeatAt ?? 0) < interval) return;
        const paths = getOrchestrationPaths(run.projectDirectory);
        let renewed = run.lease;
        if (run.lease) {
          renewed = await renewResourceLease({
            storePath: paths.leaseStore,
            leaseId: run.lease.id,
            owner: run.taskId,
            ttlMs: run.leaseTtlMs,
          }).catch(() => undefined);
          if (!renewed) return;
          run.lease = renewed;
        }
        const heartbeatAt = new Date(now).toISOString();
        if (run.invocationId) {
          const patched = await patchDurableRun(paths.runStore, run.invocationId, {
            ...(renewed ? { lease: renewed } : {}),
            heartbeatAt,
          }).catch(() => undefined);
          if (patched) run.lastHeartbeatAt = now;
        } else {
          run.lastHeartbeatAt = now;
        }
      }),
    );
  }, 250);
  timer.unref();
  return timer;
}

function leaseHeartbeatInterval(ttlMs = 30 * 60 * 1_000): number {
  return Math.max(100, Math.min(60_000, Math.floor(ttlMs / 3)));
}

function markResultAwaitingReview(
  result: AgentToolResult<unknown>,
  taskId: string,
): AgentToolResult<unknown> {
  const details = isRecord(result.details) ? result.details : {};
  return {
    ...result,
    content: [
      {
        type: "text" as const,
        text: `Task ${taskId} completed execution and verification; it is awaiting independent review.`,
      },
    ],
    details: {
      ...details,
      phase: "awaiting_review",
      execution_phase: "done",
    },
  };
}
