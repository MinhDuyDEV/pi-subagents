import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  makeTaskSettledEvent,
  makeTaskStartedEvent,
  TASK_LIFECYCLE_EVENTS_V1,
  type TerminalTaskOutcomeV1,
} from "@minhduydev/pi-core/task-lifecycle";
import type { TSchema } from "typebox";
import { readRegistry, setRegistryQuarantineReporter } from "../conversation.js";
import { findPiDir, parseResultXml } from "../helpers.js";
import { getAgentTerminalStopReason } from "../session-text.js";
import { resolveTaskCwd } from "../task-cwd.js";
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
  DEFAULT_LEASE_TTL_MS,
  findClaimCoveringPath,
  claimCoversPath,
  listActiveResourceLeases,
  renewResourceLease,
  setStoreQuarantineReporter,
  transferResourceLeaseOwnership,
  type ResourceLease,
  type ResourceClaim,
} from "./claims.js";
import {
  beginBlindContinuation,
  buildContextPack,
  loadContextPack,
  markBlindContinuationStarted,
  recordBlindOrientation,
  renderContextPackForPrompt,
  saveContextPack,
  type ContextPack,
} from "./context.js";
import {
  clampString,
  makeContextRequestPayload,
  makeContextRequestPayloadV2,
} from "../events.js";
import { requestLearningContext } from "../learning-handshake.js";
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
  completeDurableRun,
  getDurableRunByDecisionId,
  getDurableRunByInvocationId,
  getDurableRunByTaskId,
  isTerminalExecutionPhase,
  listDurableRuns,
  patchDurableRun,
  putDurableRun,
  setRunStoreQuarantineReporter,
  type DurableTaskRun,
} from "./run-store.js";
import { taggedDigest } from "../learning-contract.js";
import { seedResumeRegistry } from "./task-state.js";
import { registerTaskControlTool } from "./tool.js";
import { registerTaskCommands, stopOwnedTask } from "./commands.js";
import { registerTaskRpc, type TaskRpcHandle } from "./rpc.js";
import { TaskScheduler } from "./scheduler.js";
import { getFinalTaskResult, getTaskSnapshot } from "./task-query.js";

/**
 * Learning handshake timeout split.
 *
 * A provider that acknowledges synchronously (the real pi-learning provider)
 * skips the ACK wait entirely. The ACK window only bounds the wait for an
 * asynchronous acknowledgement; when no provider is installed it fails open
 * within this window instead of blocking for the full served timeout.
 */
const LEARNING_ACK_TIMEOUT_MS = 75;
const LEARNING_SERVED_TIMEOUT_MS = 2_000;

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
  decisionResumesInFlight: Set<string>;
  runtimeInstanceId: string;
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
    // but must never receive the parent control plane. They DO receive the
    // write-claim guard: this early return used to skip it entirely, so the
    // one process actually doing the delegated writing was the one process
    // whose writes were never checked against the lease store.
    if (process.env.PI_TASK_TOOL_DISABLED === "1") {
      registerChildWriteClaimGuard(pi);
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
      decisionResumesInFlight: new Set(),
      runtimeInstanceId: randomUUID(),
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
    pi.events.on("pi-subagents:decision-response", (payload: unknown) =>
      resumeTaskAfterDecision(state, payload, "event"),
    );
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
          try {
            await pi.events.emit("pi-subagents:task-stopped", {
              protocolVersion: 1,
              taskId,
              timestamp: new Date().toISOString(),
            });
          } catch {
            // Optional wake-up listeners cannot undo the durable stop.
          }
        }
      },
      isTaskSettled: (taskId) => !state.activeRuns.has(taskId),
    });
    registerTaskControlTool(pi);
    registerTaskCommands(pi);
    registerWriteClaimGuard(pi);
    registerStoreQuarantineReporter(pi, state);
    state.heartbeatTimer = startLeaseHeartbeats(state, pi);
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
          lastRenewMonotonicMs: monotonicNowMs(),
          contextPack: run.contextPack,
          proof: run.proof,
          semanticAttestations: run.semanticAttestations,
          verifier: run.verifier,
          projectDirectory: run.projectDirectory,
          workspaceDirectory: run.workspaceDirectory ?? run.projectDirectory,
          executionDirectory: run.executionDirectory,
          batchId: run.batchId,
          joinMode: run.joinMode,
          reportedOutcome: run.reportedOutcome,
        });
      }
      for (const run of runs) {
        const decision = run.decisionRequest;
        if (!run.taskId || !decision || decision.status !== "pending") continue;
        try {
          await pi.events.emit("herdr:blocked", {
            active: true,
            blockerId: decision.id,
            taskId: run.taskId,
            label: decision.question,
          });
        } catch {
          // Durable decision state is authoritative; Herdr is a projection.
        }
      }
      for (const run of runs) {
        const decision = run.decisionRequest;
        const response = decision?.response;
        if (
          !run.taskId ||
          !decision ||
          decision.status !== "resolved" ||
          !response ||
          response.resumeState === "started" ||
          response.resumeState === "failed"
        ) {
          continue;
        }
        const resumeAttemptId = response.resumeAttemptId ?? randomUUID();
        const resumeCorrelationId =
          response.resumeCorrelationId ??
          `decision-resume:${run.invocationId}:${decision.id}`;
        const prepared = await patchDurableRun(
          paths.runStore,
          run.invocationId,
          (current) => {
            const currentDecision = current.decisionRequest;
            const currentResponse = currentDecision?.response;
            if (
              !currentDecision ||
              currentDecision.id !== decision.id ||
              !currentResponse ||
              currentResponse.resumeState === "started" ||
              currentResponse.resumeState === "failed"
            ) {
              return {};
            }
            return {
              decisionRequest: {
                ...currentDecision,
                response: {
                  ...currentResponse,
                  resumeState: "dispatching",
                  // The first durable recovery writer owns the stable
                  // attempt/correlation. Later runtimes must reuse it rather
                  // than silently replacing the identity mid-dispatch.
                  resumeAttemptId:
                    currentResponse.resumeAttemptId ?? resumeAttemptId,
                  resumeCorrelationId:
                    currentResponse.resumeCorrelationId ?? resumeCorrelationId,
                  resumeDispatchStartedAt:
                    currentResponse.resumeDispatchStartedAt ?? new Date().toISOString(),
                },
              },
            };
          },
        );
        const preparedResponse = prepared?.decisionRequest?.response;
        if (!preparedResponse?.resumeAttemptId || !preparedResponse.resumeCorrelationId) continue;
        await resumeTaskAfterDecision(
          state,
          {
            protocolVersion: 1,
            projectDirectory: ctx.cwd,
            taskId: run.taskId,
            decisionId: decision.id,
            optionId: preparedResponse.optionId,
            response: preparedResponse.response,
            responseDigest: preparedResponse.responseDigest,
            resumeCorrelationId: preparedResponse.resumeCorrelationId,
            resumeAttemptId: preparedResponse.resumeAttemptId,
            timestamp: preparedResponse.respondedAt,
          },
          "recovery",
        ).catch((error) => {
          pi.sendMessage(
            {
              customType: "orchestration-decision-resume-recovery-failed",
              content:
                `Decision ${decision.id} remains durable but resume recovery failed: ` +
                errorMessage(error),
              display: true,
            },
            { triggerTurn: false },
          );
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
      const paths = getOrchestrationPaths(ctx.cwd);
      state.projectDirectories.add(ctx.cwd);
      const requestedWorkspace = resolveTaskCwd(ctx.cwd, rawParameters.cwd);
      if (requestedWorkspace.kind === "invalid") {
        return {
          content: [{ type: "text" as const, text: requestedWorkspace.message }],
          details: { phase: "failed" as const, error: "invalid cwd" },
          isError: true,
        };
      }
      const resolvedTaskId = stringValue(rawParameters.task_id);
      const resolvedTaskKey = resolvedTaskId ?? stringValue(rawParameters.id);
      const resumedRun = resolvedTaskId
        ? await getDurableRunByTaskId(paths.runStore, resolvedTaskId)
        : undefined;
      const effectiveClaims = orchestration?.claims ?? resumedRun?.claims;
      const effectiveAuthorization =
        orchestration?.context?.authorization ??
        resumedRun?.contextPack?.authorization;
      const claimsDeclareWrite =
        effectiveClaims?.some(
          (claim) => claim.kind === "write" || claim.kind === "test",
        ) ?? false;
      // Admission runs BEFORE the schedule branch: a contradictory read-only +
      // write/test request must be refused before a schedule is persisted or a
      // Cron job installed. `PI_SUBAGENTS_NO_CLAIMS=1` skips this rejection
      // deliberately — that env is the documented emergency override that
      // disables claim coordination entirely (lease acquisition and the parent
      // write guard are skipped under it too); proof gating stays independent
      // of it, so the write-signal derivation below is intentionally NOT
      // overridden by NO_CLAIMS.
      if (
        effectiveAuthorization === "read-only" &&
        claimsDeclareWrite &&
        process.env.PI_SUBAGENTS_NO_CLAIMS !== "1"
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `read-only authorization cannot be combined with write or test claims`,
            },
          ],
          details: {
            phase: "failed" as const,
            error: "read-only authorization cannot be combined with write or test claims",
            task_id: resolvedTaskId ?? resolvedTaskKey,
          },
          isError: true,
        };
      }
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
      const resumedTaskId = resolvedTaskId;
      const persistedWorkspace = resumedRun
        ? (resumedRun.workspaceDirectory ??
          resumedRun.worktree?.repositoryRoot ??
          resumedRun.executionDirectory)
        : undefined;
      const workspaceResolution = resolveTaskCwd(
        ctx.cwd,
        rawParameters.cwd,
        persistedWorkspace,
      );
      if (workspaceResolution.kind === "invalid") {
        return {
          content: [{ type: "text" as const, text: workspaceResolution.message }],
          details: { phase: "failed" as const, error: "invalid cwd" },
          isError: true,
        };
      }
      const workspaceDirectory = workspaceResolution.cwd;
      const orchestrationId =
        orchestration?.id ??
        resumedRun?.correlationId ??
        resumedRun?.invocationId ??
        `run-${invocationId}`;
      const effectiveVerifier = orchestration?.verifier ?? resumedRun?.verifier;
      const effectiveLeaseTtlMs =
        orchestration?.leaseTtlMs ?? resumedRun?.leaseTtlMs;
      let canonicalTaskId = resumedTaskId;
      let lease: ResourceLease | undefined;
      let leaseOwner: string = invocationId;
      let launchLeaseHeartbeat: NodeJS.Timeout | undefined;
      let launchHeartbeatInFlight = false;
      let launchLeaseTransferInFlight = false;
      let launchHeartbeatOperation: Promise<void> | undefined;
      let launchLeaseLostReason: string | undefined;
      let contextPack: ContextPack | undefined;
      const startedAt = new Date().toISOString();
      const explicitProof = orchestration?.proof ?? resumedRun?.proof;
      const isWriteAuthorized =
        orchestration?.context?.authorization === "write-approved" ||
        orchestration?.context?.authorization === "sensitive-approved" ||
        resumedRun?.contextPack?.authorization === "write-approved" ||
        resumedRun?.contextPack?.authorization === "sensitive-approved" ||
        claimsDeclareWrite;
      const honorNoProofEnv =
        process.env.PI_SUBAGENTS_NO_PROOF === "1" &&
        !(isWriteAuthorized && !explicitProof);
      const effectiveProof = honorNoProofEnv
        ? undefined
        : explicitProof ??
          (isWriteAuthorized ? { mode: "evidence-only" as const } : undefined);

      const alignLaunchLeaseOwner = async (
        nextOwner: string,
        missingMessage: string,
      ): Promise<void> => {
        launchLeaseTransferInFlight = true;
        try {
          await launchHeartbeatOperation;
          if (launchLeaseLostReason) throw new Error(launchLeaseLostReason);
          const heldLease = lease;
          if (!heldLease || heldLease.owner === nextOwner) return;
          const transferred = await transferResourceLeaseOwnership({
            storePath: paths.leaseStore,
            leaseId: heldLease.id,
            owner: nextOwner,
            expectedOwner: heldLease.owner,
            expectedFence: heldLease.fence,
          });
          if (!transferred) throw new Error(missingMessage);
          lease = transferred;
          leaseOwner = nextOwner;
          await writeChildClaimGuardState(
            childClaimGuardStatePath(paths, invocationId),
            invocationId,
            transferred,
          );
        } finally {
          launchLeaseTransferInFlight = false;
        }
      };

      try {
        if (effectiveClaims && effectiveClaims.length > 0 && process.env.PI_SUBAGENTS_NO_CLAIMS !== "1") {
          lease = await acquireResourceLease({
            storePath: paths.leaseStore,
            owner: invocationId,
            scope: workspaceDirectory,
            claims: effectiveClaims,
            ttlMs: effectiveLeaseTtlMs,
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
          await writeChildClaimGuardState(
            childClaimGuardStatePath(paths, invocationId),
            invocationId,
            lease,
          );
          launchLeaseHeartbeat = setInterval(() => {
            if (
              launchHeartbeatInFlight ||
              launchLeaseTransferInFlight ||
              launchLeaseLostReason
            ) {
              return;
            }
            const heldLease = lease;
            if (!heldLease) return;
            launchHeartbeatInFlight = true;
            const launchedTaskId = state.launchedTaskIds.get(invocationId);
            const alignOwner =
              launchedTaskId && heldLease.owner !== launchedTaskId
                ? transferResourceLeaseOwnership({
                    storePath: paths.leaseStore,
                    leaseId: heldLease.id,
                    owner: launchedTaskId,
                    expectedOwner: heldLease.owner,
                    expectedFence: heldLease.fence,
                  })
                : Promise.resolve(heldLease);
            const heartbeatOperation = alignOwner
              .then(async (aligned) => {
                if (!aligned) {
                  throw new Error("lease disappeared during ownership alignment");
                }
                lease = aligned;
                leaseOwner = aligned.owner;
                await writeChildClaimGuardState(
                  childClaimGuardStatePath(paths, invocationId),
                  invocationId,
                  aligned,
                );
                const renewed = await renewResourceLease({
                  storePath: paths.leaseStore,
                  leaseId: aligned.id,
                  owner: leaseOwner,
                  expectedFence: aligned.fence,
                  ttlMs: effectiveLeaseTtlMs,
                });
                // A failed renewal during launch is the same loss of mutual
                // exclusion as one during execution. This used to `return`
                // silently — the launch kept believing it held the lease — so
                // it now goes through the same abandon path as the main
                // heartbeat.
                if (!renewed) {
                  if (launchLeaseHeartbeat) clearInterval(launchLeaseHeartbeat);
                  launchLeaseLostReason =
                    "lease renewal failed or the lease expired during launch";
                  lease = undefined;
                  await abandonLostLease(
                    pi,
                    state,
                    {
                      invocationId,
                      orchestrationId,
                      taskId: launchedTaskId ?? invocationId,
                      agentType,
                      startedAt,
                      lease: aligned,
                      leaseTtlMs: effectiveLeaseTtlMs,
                      projectDirectory: ctx.cwd,
                    },
                    paths,
                    launchLeaseLostReason,
                  );
                  return;
                }
                lease = renewed;
                await writeChildClaimGuardState(
                  childClaimGuardStatePath(paths, invocationId),
                  invocationId,
                  renewed,
                );
                const patched = await patchDurableRun(paths.runStore, invocationId, {
                  lease: renewed,
                  heartbeatAt: new Date().toISOString(),
                });
                if (!patched) {
                  throw new Error("durable run disappeared during launch heartbeat");
                }
              })
              .catch(async (error: unknown) => {
                if (launchLeaseLostReason) return;
                launchLeaseLostReason = `launch heartbeat failed: ${errorMessage(error)}`;
                if (launchLeaseHeartbeat) clearInterval(launchLeaseHeartbeat);
                const lostLease = lease ?? heldLease;
                lease = undefined;
                await abandonLostLease(
                  pi,
                  state,
                  {
                    invocationId,
                    orchestrationId,
                    taskId:
                      state.launchedTaskIds.get(invocationId) ?? invocationId,
                    agentType,
                    startedAt,
                    lease: lostLease,
                    leaseTtlMs: effectiveLeaseTtlMs,
                    projectDirectory: ctx.cwd,
                  },
                  paths,
                  launchLeaseLostReason,
                );
              })
              .finally(() => {
                launchHeartbeatInFlight = false;
                if (launchHeartbeatOperation === heartbeatOperation) {
                  launchHeartbeatOperation = undefined;
                }
              });
            launchHeartbeatOperation = heartbeatOperation;
            void heartbeatOperation;
          }, leaseHeartbeatInterval(effectiveLeaseTtlMs));
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
              workspaceDirectory,
              executionDirectory: workspaceDirectory,
              startedAt,
              claims: effectiveClaims,
              lease,
              leaseTtlMs: effectiveLeaseTtlMs,
              proof: effectiveProof,
              verifier: effectiveVerifier,
            }),
          );
        }

        // ── Optional learning context request (fail-open) ──────────
        let contextRequestDigest:
          | ReturnType<typeof makeContextRequestPayload>["requestDigest"]
          | undefined;
        let learningBinding:
          | { projectId: string; trustEpoch: string; sessionGeneration: string }
          | undefined;
        let usageBindings: import("../learning-contract.js").UsageReceiptV1[] | undefined;
        if (pi?.events && !resumedTaskId) {
          const learningClaims = orchestration?.context?.learningClaims;
          const requestArgs = [
            invocationId,
            agentType ?? "unknown",
            description ?? "",
            orchestration?.id ?? invocationId,
            learningClaims,
          ] as const;
          const contextRequest = learningClaims?.[0]?.version === 2
            ? makeContextRequestPayloadV2(...requestArgs)
            : makeContextRequestPayload(...requestArgs);
          contextRequestDigest = contextRequest.requestDigest;
          // The provider may acknowledge then serve after async work, so the
          // handshake must wait asynchronously rather than checking a flag set
          // only during the synchronous emit dispatch. Fails open on any
          // timeout, mismatch, or listener error so learning never blocks the
          // task.
          const handshake = await requestLearningContext(pi.events, contextRequest, {
            ackTimeoutMs: LEARNING_ACK_TIMEOUT_MS,
            servedTimeoutMs: LEARNING_SERVED_TIMEOUT_MS,
            existingFacts: orchestration?.context?.knownFacts,
          });
          if (handshake) {
            learningBinding = handshake.learningBinding;
            usageBindings = handshake.usageBindings;
            if (handshake.factsGrew) {
              // Merge learning facts into the orchestration context as
              // provenance-labelled non-authoritative entries.
              // This never overrides user prompt or policy.
              const contextInput = {
                ...(orchestration?.context ?? { goal: description ?? "", authorization: "read-only" as const, nextStep: "" }),
                knownFacts: handshake.mergedFacts,
              };
              contextPack = await buildContextPack({
                projectDirectory: workspaceDirectory,
                input: contextInput,
              });
            }
          }
        }

        if (!contextPack && orchestration?.context) {
          contextPack = await buildContextPack({
            projectDirectory: workspaceDirectory,
            input: orchestration.context,
          });
        } else if (resumedTaskId) {
          contextPack = await loadContextPack({
            storeDirectory: paths.contextStore,
            key: resumedTaskId,
          });
          if (
            contextPack?.disclosure === "blind-first" &&
            (contextPack.blindDisclosure?.phase === "orientation-recorded" ||
              contextPack.blindDisclosure?.phase === "continuation-dispatching")
          ) {
            contextPack = await beginBlindContinuation({
              storeDirectory: paths.contextStore,
              key: resumedTaskId,
              attemptId:
                contextPack.blindDisclosure.continuationAttemptId ?? randomUUID(),
              correlationId:
                contextPack.blindDisclosure.continuationCorrelationId ??
                `blind-continuation:${resumedRun?.invocationId ?? resumedTaskId}`,
            });
          }
        }

        await putDurableRun(
          paths.runStore,
          createDurableRun({
            invocationId,
            correlationId: orchestration?.id,
            contextRequestDigest,
            learningBinding,
            usageBindings,
            batchId: orchestration?.batchId ?? resumedRun?.batchId,
            joinMode: orchestration?.join ?? resumedRun?.joinMode,
            agentType,
            description,
            projectDirectory: ctx.cwd,
            workspaceDirectory,
            executionDirectory: workspaceDirectory,
            startedAt,
            claims: effectiveClaims,
            lease,
            leaseTtlMs: effectiveLeaseTtlMs,
            contextPack,
            proof: effectiveProof,
            verifier: effectiveVerifier,
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
          const rendered = renderContextPackForPrompt(contextPack, {
            ...(orchestration?.context?.disclosure
              ? { disclosure: orchestration.context.disclosure }
              : {}),
          });
          upstreamParameters.prompt = `${prompt.trim()}\n\n${rendered}`;
          if (
            !resumedTaskId &&
            contextPack.disclosure === "blind-first" &&
            contextPack.blindDisclosure?.phase === "awaiting-orientation"
          ) {
            // Turn one must finish before any sealed token is sent.
            upstreamParameters.background = false;
          }
        }

        let upstreamResult = await upstreamTool.execute(
          toolCallId,
          upstreamParametersValue,
          signal,
          onUpdate,
          ctx,
        );
        if (launchLeaseLostReason) {
          throw new Error(launchLeaseLostReason);
        }
        canonicalTaskId = taskIdFromResult(upstreamResult) ?? resumedTaskId;
        if (!canonicalTaskId) {
          if (isFailedTaskResult(upstreamResult)) {
            if (lease) {
              await releaseLeaseAndRecord(paths, orchestrationId, lease);
              lease = undefined;
            }
            await completeFailedDurableRun(paths.runStore, invocationId, {
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
        if (
          !resumedTaskId &&
          contextPack?.disclosure === "blind-first" &&
          contextPack.blindDisclosure?.phase === "awaiting-orientation"
        ) {
          const orientationTaskId = canonicalTaskId;
          if (isFailedTaskResult(upstreamResult)) {
            throw new Error(
              `Blind-first orientation failed: ${taskResultFailureReason(upstreamResult)}`,
            );
          }
          const orientation = taskResultText(upstreamResult);
          if (!orientation.trim()) {
            throw new Error("Blind-first orientation returned no canonical text");
          }
          await saveContextPack({
            storeDirectory: paths.contextStore,
            key: orientationTaskId,
            pack: contextPack,
          });
          contextPack = await recordBlindOrientation({
            storeDirectory: paths.contextStore,
            key: orientationTaskId,
            text: orientation,
          });
          await patchDurableRun(paths.runStore, invocationId, {
            taskId: orientationTaskId,
            contextPack,
          });
          const continuationAttemptId = randomUUID();
          contextPack = await beginBlindContinuation({
            storeDirectory: paths.contextStore,
            key: orientationTaskId,
            attemptId: continuationAttemptId,
            correlationId: `blind-continuation:${invocationId}`,
          });
          await patchDurableRun(paths.runStore, invocationId, {
            taskId: orientationTaskId,
            contextPack,
          });

          if (lease && lease.owner !== orientationTaskId) {
            await alignLaunchLeaseOwner(
              orientationTaskId,
              "Lease disappeared between blind-first turns",
            );
          }

          const continuationValue = structuredClone(parametersValue);
          const continuation = toRecord(continuationValue);
          delete continuation.orchestration;
          continuation.task_id = orientationTaskId;
          continuation.background = isBackground;
          if (taskToolSupportsLaunchEvents(upstreamTool.parameters)) {
            continuation.__pi_subagents_invocation_id = invocationId;
          }
          continuation.prompt = [
            "Continue the same task. Your independent orientation is now durable; the parent context is disclosed below.",
            renderContextPackForPrompt(contextPack),
          ].join("\n\n");
          upstreamResult = await upstreamTool.execute(
            `${toolCallId}:blind-disclosure`,
            continuationValue,
            signal,
            onUpdate,
            ctx,
          );
          contextPack = await markBlindContinuationStarted({
            storeDirectory: paths.contextStore,
            key: orientationTaskId,
            attemptId: continuationAttemptId,
            continuedInvocationId: invocationId,
          });
          const continuedTaskId = taskIdFromResult(upstreamResult) ?? orientationTaskId;
          if (continuedTaskId !== orientationTaskId) {
            throw new Error(
              `Blind-first continuation changed task identity (${orientationTaskId} -> ${continuedTaskId})`,
            );
          }
          canonicalTaskId = orientationTaskId;
        }
        if (
          resumedTaskId &&
          contextPack?.disclosure === "blind-first" &&
          contextPack.blindDisclosure?.phase === "continuation-dispatching"
        ) {
          contextPack = await markBlindContinuationStarted({
            storeDirectory: paths.contextStore,
            key: resumedTaskId,
            attemptId: contextPack.blindDisclosure.continuationAttemptId!,
            continuedInvocationId: invocationId,
          });
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
          registryEntry?.worktree?.path ?? resultWorktreePath ?? workspaceDirectory;

        if (lease && lease.owner !== taskId) {
          await alignLaunchLeaseOwner(
            taskId,
            "Lease disappeared during canonical owner transfer",
          );
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
          ...(contextPack ? { contextPack } : {}),
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
          try {
            await pi.events.emit(TASK_LIFECYCLE_EVENTS_V1.STARTED, makeTaskStartedEvent({
              protocolVersion: 1,
              taskId,
              invocationId,
              ...(orchestration?.batchId ? { batchId: orchestration.batchId } : {}),
              ...(agentType ? { agentType } : {}),
              ...(description ? { description } : {}),
              ...(registryEntry?.handle?.backend ??
              stringValue(upstreamDetails?.backend)
                ? {
                    backend:
                      registryEntry?.handle?.backend ??
                      stringValue(upstreamDetails?.backend),
                  }
                : {}),
              timestamp: startedAt,
            }));
          } catch {
            // Lifecycle listeners are projections; durable task state already
            // records the start and must not be rolled back by one listener.
          }
        }

        const activeRun: ActiveRun = {
          invocationId,
          orchestrationId,
          taskId,
          agentType,
          startedAt,
          lease,
          leaseTtlMs: effectiveLeaseTtlMs,
          lastHeartbeatAt: Date.now(),
          lastRenewMonotonicMs: monotonicNowMs(),
          contextPack,
          proof: effectiveProof,
          verifier: effectiveVerifier,
          projectDirectory: ctx.cwd,
          workspaceDirectory,
          executionDirectory,
          batchId: orchestration?.batchId ?? resumedRun?.batchId,
          joinMode: orchestration?.join ?? resumedRun?.joinMode,
        };
        if (isFailedTaskResult(upstreamResult)) {
          await recordForegroundCompletion(activeRun, paths, upstreamResult, pi);
          await emitDurableSettlement(pi, paths, invocationId);
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
          pi,
        );
        await emitDurableSettlement(pi, paths, invocationId);
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
          await completeFailedDurableRun(paths.runStore, invocationId, {
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

function taskResultText(result: AgentToolResult<unknown>): string {
  if (isRecord(result.details)) {
    const value =
      stringValue(result.details.full_output) ??
      stringValue(result.details.result) ??
      stringValue(result.details.summary);
    if (value) return value;
  }
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
      item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
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
    try {
      await pi.events.emit(TASK_LIFECYCLE_EVENTS_V1.STARTED, makeTaskStartedEvent({
        protocolVersion: 1,
        taskId,
        invocationId,
        ...(run.batchId ? { batchId: run.batchId } : {}),
        ...(stringValue(payload.agentType) ?? run.agentType
          ? { agentType: stringValue(payload.agentType) ?? run.agentType }
          : {}),
        ...(stringValue(payload.description) ?? run.description
          ? { description: stringValue(payload.description) ?? run.description }
          : {}),
        ...(stringValue(payload.backend)
          ? { backend: stringValue(payload.backend) }
          : {}),
        timestamp: stringValue(payload.timestamp) ?? new Date().toISOString(),
      }));
    } catch {
      // The durable launch event above remains authoritative.
    }
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
    const parsedResult = result ? parseResultXml(result) : undefined;
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
          summary: parsedResult?.summary || result,
          reported_status: parsedResult?.status ?? "unknown",
          ...(parsedResult?.decision_request
            ? { decision_request: parsedResult.decision_request }
            : {}),
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
        expectedOwner: lease.owner,
        expectedFence: lease.fence,
      }).catch(() => undefined);
      if (!transferred) continue;
      lease = transferred;
    } else if (run.claims.length > 0) {
      const reacquired = await acquireResourceLease({
        storePath: paths.leaseStore,
        owner: entry.id,
        scope: run.workspaceDirectory ?? entry.cwd ?? projectDirectory,
        claims: run.claims,
        ttlMs: run.leaseTtlMs,
      }).catch(() => undefined);
      if (!reacquired) continue;
      lease = reacquired;
    }
    if (lease) {
      await writeChildClaimGuardState(
        childClaimGuardStatePath(paths, run.invocationId),
        run.invocationId,
        lease,
      );
    }
    const patch: Partial<DurableTaskRun> = {
      taskId: entry.id,
      executionPhase: "working",
      workspaceDirectory:
        run.workspaceDirectory ?? entry.cwd ?? entry.worktree?.repositoryRoot ?? projectDirectory,
      executionDirectory: entry.worktree?.path ?? entry.cwd ?? projectDirectory,
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
  // Options are sanitized at the RPC boundary; spreading them FIRST is still
  // deliberate, so the named fields always win over anything a caller passes.
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

/** Configuration a parent passes to a child so it can enforce claims on itself. */
export interface ChildClaimGuardConfig {
  version: 2;
  /** The PARENT project directory — where the lease store lives. */
  projectDirectory: string;
  leaseStore: string;
  /** Runtime-owned state updated whenever ownership/fence changes. */
  guardStatePath: string;
  /** A missing state file blocks project writes when this launch owns claims. */
  guardStateRequired: boolean;
}

export interface ChildClaimGuardState {
  version: 1;
  invocationId: string;
  leaseId: string;
  owner: string;
  fence: number;
  claims: ResourceClaim[];
  updatedAt: string;
}

export const CHILD_CLAIM_GUARD_ENV = "PI_SUBAGENTS_CLAIM_GUARD";

export function parseChildClaimGuardConfig(
  raw: string | undefined,
): ChildClaimGuardConfig | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      value !== null &&
      typeof value === "object" &&
      (value as Record<string, unknown>).version === 2 &&
      typeof (value as Record<string, unknown>).projectDirectory === "string" &&
      typeof (value as Record<string, unknown>).leaseStore === "string" &&
      typeof (value as Record<string, unknown>).guardStatePath === "string" &&
      typeof (value as Record<string, unknown>).guardStateRequired === "boolean"
    ) {
      return value as unknown as ChildClaimGuardConfig;
    }
  } catch {
    // Fall through to undefined; the caller decides how loud to be.
  }
  return undefined;
}

/**
 * The write-claim guard for a CHILD Pi process.
 *
 * The parent registers a guard for its own session, but the child launched with
 * `PI_TASK_TOOL_DISABLED=1` returned before that registration — so the process
 * doing the delegated writing was exactly the one whose writes were never
 * checked. A violation was only discovered post-hoc, if at all.
 *
 * The child checks every authoritative write against a runtime-owned state
 * file containing the exact lease id, owner and fence issued to this
 * invocation. A later attempt may reuse the same task id, but it cannot reuse
 * this invocation's fence, so a stale child fails closed after reacquisition.
 */
function registerChildWriteClaimGuard(pi: ExtensionAPI): void {
  const config = parseChildClaimGuardConfig(process.env[CHILD_CLAIM_GUARD_ENV]);
  if (!config) return;

  pi.on("tool_call", async (event) => {
    if (process.env.PI_SUBAGENTS_NO_CLAIMS === "1") return;
    const pathsToCheck = extractWritePaths(event.toolName, event.input);
    if (pathsToCheck.length === 0) return;

    try {
      const guardState = await readChildClaimGuardState(config.guardStatePath);
      if (!guardState && config.guardStateRequired) {
        return {
          block: true,
          reason: "Write blocked because this task's lease generation is unavailable",
        };
      }
      for (const rawPath of pathsToCheck) {
        const absolutePath = isAbsolute(rawPath)
          ? resolve(rawPath)
          : resolve(process.cwd(), rawPath.replace(/^@/u, ""));
        const projectRelativePath = relative(config.projectDirectory, absolutePath);
        if (
          projectRelativePath === ".." ||
          projectRelativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
          isAbsolute(projectRelativePath)
        ) {
          // Outside the parent project — a worktree, a temp dir. Not lease
          // territory; the worktree merge gate owns those writes.
          continue;
        }
        const relativePath = projectRelativePath.replaceAll("\\", "/");
        const covering = await findClaimCoveringPath({
          storePath: config.leaseStore,
          scope: config.projectDirectory,
          path: relativePath,
        });
        const expectedClaim = guardState?.claims.find(
          (claim) =>
            (claim.kind === "write" || claim.kind === "test") &&
            claimCoversPath(claim.resource, relativePath),
        );
        if (expectedClaim && !covering) {
          return {
            block: true,
            reason:
              `Write blocked: ${rawPath} is covered by this task's claim, but its lease is no longer active`,
          };
        }
        if (
          covering &&
          (!guardState ||
            covering.id !== guardState.leaseId ||
            covering.owner !== guardState.owner ||
            covering.fence !== guardState.fence)
        ) {
          return {
            block: true,
            reason:
              `Write blocked: ${rawPath} is covered by lease ${covering.id} owned by ` +
              `${covering.owner} at fence ${covering.fence}; this invocation holds ` +
              `${guardState ? `${guardState.leaseId}/${guardState.owner}/fence ${guardState.fence}` : "no lease generation"}`,
          };
        }
      }
    } catch (error) {
      return {
        block: true,
        reason: `Write blocked because the lease store could not be verified: ${errorMessage(error)}`,
      };
    }
  });
}

function childClaimGuardStatePath(
  paths: OrchestrationPaths,
  invocationId: string,
): string {
  return join(paths.root, "claim-guards", `${invocationId}.json`);
}

async function writeChildClaimGuardState(
  path: string,
  invocationId: string,
  lease: ResourceLease,
): Promise<void> {
  const state: ChildClaimGuardState = {
    version: 1,
    invocationId,
    leaseId: lease.id,
    owner: lease.owner,
    fence: lease.fence,
    claims: lease.claims.map((claim) => ({ ...claim })),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readChildClaimGuardState(
  path: string,
): Promise<ChildClaimGuardState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      typeof value.invocationId !== "string" ||
      typeof value.leaseId !== "string" ||
      typeof value.owner !== "string" ||
      !Number.isSafeInteger(value.fence) ||
      (value.fence as number) < 1 ||
      !Array.isArray(value.claims) ||
      !value.claims.every(
        (claim) =>
          isRecord(claim) &&
          (claim.kind === "write" ||
            claim.kind === "test" ||
            claim.kind === "evidence") &&
          typeof claim.resource === "string" &&
          (claim.mode === "shared" || claim.mode === "exclusive"),
      )
    ) {
      throw new Error("claim guard state failed validation");
    }
    return value as unknown as ChildClaimGuardState;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
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
        const unresolvedPath = isAbsolute(rawPath)
          ? resolve(rawPath)
          : resolve(projectDirectory, rawPath.replace(/^@/u, ""));
        const absolutePath = canonicalizePotentialPath(unresolvedPath);
        const controlScope = realpathSync(resolve(projectDirectory));
        const scopes = [
          controlScope,
          ...activeLeases.flatMap((lease) => lease.scope ? [lease.scope] : []),
        ].sort((left, right) => right.length - left.length);
        const scope = scopes.find((candidate) => pathIsWithin(candidate, absolutePath));
        if (!scope) {
          return {
            block: true,
            reason: `Write blocked: ${rawPath} is outside every project scope with active task leases`,
          };
        }
        const projectRelativePath = relative(scope, absolutePath);
        await assertNoConflictingWrite({
          storePath: paths.leaseStore,
          scope,
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

function canonicalizePotentialPath(absolutePath: string): string {
  let existing = absolutePath;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return resolve(realpathSync(existing), relative(existing, absolutePath));
}

function pathIsWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return !(
    candidate === ".." ||
    candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(candidate)
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
      let terminalOutcome: TerminalTaskOutcomeV1 =
        outcome.awaitingReview
          ? "unknown"
          : outcome.executionPhase === "cancelled"
          ? "cancelled"
          : outcome.executionPhase === "timeout"
            ? "timeout"
            : outcome.executionPhase === "failed"
              ? "failure"
              : outcome.reportedOutcome ?? "unknown";
      if (!outcome.awaitingReview && outcome.proof && !outcome.proof.valid) {
        terminalOutcome = "failure";
      }
      const settled = makeTaskSettledEvent({
        protocolVersion: 1,
        taskId: outcome.taskId,
        terminalOutcome,
        reportedOutcome: outcome.reportedOutcome ?? "unknown",
        executionPhase: outcome.executionPhase,
        ...(outcome.proof &&
        (!outcome.awaitingReview || outcome.proof.valid)
          ? { verificationPassed: outcome.proof.valid }
          : {}),
        awaitingReview: outcome.awaitingReview === true,
        issues: outcome.issues.slice(0, 20),
        ...(outcome.decisionId ? { decisionId: outcome.decisionId } : {}),
        timestamp: new Date().toISOString(),
      });
      try {
        await pi.events.emit(TASK_LIFECYCLE_EVENTS_V1.SETTLED, settled);
      } catch {
        // Settlement is already durable; a projection listener cannot make it
        // fail or trigger an unhandled rejection.
      }
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

/**
 * Foreground calls do not travel through the background completion hook, but
 * they emit the same canonical lifecycle pair. Without this settlement,
 * consumers such as pi-todo durably tracked a started foreground task forever.
 */
async function emitDurableSettlement(
  pi: ExtensionAPI,
  paths: OrchestrationPaths,
  invocationId: string,
): Promise<void> {
  try {
    const run = await getDurableRunByInvocationId(paths.runStore, invocationId);
    if (
      !run?.taskId ||
      !isTerminalExecutionPhase(run.executionPhase)
    ) {
      return;
    }
    const reportedOutcome = run.reportedOutcome ?? "unknown";
    const awaitingReview =
      reportedOutcome === "success" && run.reviewPhase === "awaiting";
    const verificationPassed =
      reportedOutcome === "success" && run.verificationPhase === "passed"
        ? true
        : reportedOutcome === "success" &&
            run.verificationPhase === "failed" &&
            !awaitingReview
          ? false
          : undefined;
    const terminalOutcome: TerminalTaskOutcomeV1 =
      awaitingReview
        ? "unknown"
        : run.executionPhase === "cancelled"
          ? "cancelled"
          : run.executionPhase === "timeout"
            ? "timeout"
            : run.executionPhase === "failed" || verificationPassed === false
              ? "failure"
              : reportedOutcome;
    const settled = makeTaskSettledEvent({
      protocolVersion: 1,
      taskId: run.taskId,
      terminalOutcome,
      reportedOutcome,
      executionPhase: run.executionPhase,
      ...(verificationPassed !== undefined ? { verificationPassed } : {}),
      awaitingReview,
      issues: run.verificationIssues
        .slice(0, 20)
        .map((issue) => clampString(issue, 500))
        .filter(Boolean),
      ...(reportedOutcome === "awaiting-decision" && run.decisionRequest?.id
        ? { decisionId: run.decisionRequest.id }
        : {}),
      timestamp: new Date().toISOString(),
    });
    await pi.events.emit(TASK_LIFECYCLE_EVENTS_V1.SETTLED, settled);
  } catch {
    // Durable run state is authoritative; lifecycle consumers can reconcile
    // it on restart and cannot make task execution fail.
  }
}

function applyCompletionOutcome(
  message: Parameters<ExtensionAPI["sendMessage"]>[0],
  outcome: Awaited<ReturnType<typeof recordBackgroundCompletion>>,
): Parameters<ExtensionAPI["sendMessage"]>[0] {
  if (!outcome.handled) return message;
  const details = isRecord(message.details) ? message.details : {};
  if (outcome.reportedOutcome && outcome.reportedOutcome !== "success") {
    const taskId = outcome.taskId ?? "unknown";
    const outcomeMessage =
      outcome.reportedOutcome === "awaiting-decision"
        ? `Task ${taskId} is awaiting a parent decision${
            outcome.decisionId ? ` (${outcome.decisionId})` : ""
          }.`
        : outcome.reportedOutcome === "failure"
          ? `Task ${taskId} completed with blocking findings; retrieve the review with task_control result. Verification and shipment were not advanced.`
          : `Task ${taskId} completed with status ${outcome.reportedOutcome}; retrieve its result with task_control result. Verification and shipment were not advanced.`;
    return {
      ...message,
      content: outcomeMessage,
      details: {
        ...details,
        phase: outcome.reportedOutcome.replaceAll("-", "_"),
        execution_phase: outcome.executionPhase,
        reported_status: outcome.reportedOutcome,
        ...(outcome.decisionId ? { decision_id: outcome.decisionId } : {}),
      },
    };
  }
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
        lastRenewMonotonicMs: monotonicNowMs(),
        contextPack: stored.contextPack,
        proof: stored.proof,
        semanticAttestations: stored.semanticAttestations,
        verifier: stored.verifier,
        projectDirectory: stored.projectDirectory,
        executionDirectory: stored.executionDirectory,
        batchId: stored.batchId,
        joinMode: stored.joinMode,
        reportedOutcome: stored.reportedOutcome,
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

async function resumeTaskAfterDecision(
  state: RuntimeState,
  payload: unknown,
  mode: "event" | "recovery",
): Promise<void> {
  if (!isRecord(payload)) {
    throw new Error("Decision response payload is malformed");
  }
  const projectDirectory = stringValue(payload.projectDirectory);
  const taskId = stringValue(payload.taskId);
  const decisionId = stringValue(payload.decisionId);
  const response = stringValue(payload.response);
  const responseDigest = stringValue(payload.responseDigest);
  const resumeCorrelationId = stringValue(payload.resumeCorrelationId);
  const resumeAttemptId = stringValue(payload.resumeAttemptId);
  if (
    !projectDirectory ||
    !taskId ||
    !decisionId ||
    !response ||
    !responseDigest ||
    !resumeCorrelationId ||
    !resumeAttemptId
  ) {
    throw new Error("Decision response payload is incomplete");
  }
  const taskTool = state.taskTool;
  const ctx = state.currentContext;
  if (!taskTool || !ctx || ctx.cwd !== projectDirectory) {
    throw new Error("No active task runtime is available to resume the decision");
  }
  const paths = getOrchestrationPaths(projectDirectory);
  const prior = await getDurableRunByDecisionId(
    paths.runStore,
    taskId,
    decisionId,
  );
  if (!prior?.decisionRequest || prior.decisionRequest.id !== decisionId) {
    throw new Error(`Decision ${decisionId} is not bound to task ${taskId}`);
  }
  const optionId = stringValue(payload.optionId);
  if (
    optionId !== undefined &&
    !prior.decisionRequest.options.some((option) => option.id === optionId)
  ) {
    throw new Error(`Decision response selected an unknown option for ${decisionId}`);
  }
  const recordedResponse = prior.decisionRequest.response;
  const expectedDigest = `sha256:v1:${createHash("sha256")
    .update(JSON.stringify({ decisionId, optionId: optionId ?? null, response }))
    .digest("hex")}`;
  // The event bus is an integration boundary, not a source of authority. A
  // listener must only resume the exact response atomically recorded by
  // `task_control respond`; otherwise another extension could replay the
  // decision id with different prose or an option it did not receive.
  if (
    prior.decisionRequest.status !== "resolved" ||
    !recordedResponse ||
    recordedResponse.responseDigest !== responseDigest ||
    responseDigest !== expectedDigest ||
    recordedResponse.response !== response ||
    recordedResponse.optionId !== optionId ||
    recordedResponse.resumeCorrelationId !== resumeCorrelationId ||
    recordedResponse.resumeState !== "dispatching" ||
    recordedResponse.resumeAttemptId !== resumeAttemptId
  ) {
    throw new Error(`Decision response is not bound to ${decisionId}`);
  }
  const dispatchKey = `${prior.invocationId}:${decisionId}:${resumeAttemptId}`;
  if (state.decisionResumesInFlight.has(dispatchKey)) return;
  let acquiredDispatch = false;
  const claimed = await patchDurableRun(
    paths.runStore,
    prior.invocationId,
    (current) => {
      const decision = current.decisionRequest;
      const currentResponse = decision?.response;
      if (
        !decision ||
        decision.id !== decisionId ||
        !currentResponse ||
        currentResponse.resumeState !== "dispatching" ||
        currentResponse.resumeAttemptId !== resumeAttemptId
      ) {
        return {};
      }
      if (
        mode === "event" &&
        currentResponse.resumeDispatcherId &&
        currentResponse.resumeDispatcherId !== state.runtimeInstanceId
      ) {
        return {};
      }
      acquiredDispatch = true;
      return {
        decisionRequest: {
          ...decision,
          response: {
            ...currentResponse,
            resumeDispatcherId: state.runtimeInstanceId,
          },
        },
      };
    },
  );
  if (!claimed || !acquiredDispatch) return;
  state.decisionResumesInFlight.add(dispatchKey);
  try {
  // The wrapper persists a new run before calling the upstream task launcher.
  // A retry after an event-bus/process failure can therefore discover that
  // durable intent by its stable correlation id and must not launch a second
  // continuation.
  const priorRuns = await listDurableRuns(paths.runStore);
  const existingResume = priorRuns
    .filter(
      (candidate) =>
        candidate.invocationId !== prior.invocationId &&
        candidate.correlationId === resumeCorrelationId &&
        candidate.executionPhase !== "failed" &&
        candidate.executionPhase !== "cancelled" &&
        candidate.executionPhase !== "timeout",
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  if (existingResume) {
    await markDecisionResumeStarted(
      paths.runStore,
      prior.invocationId,
      decisionId,
      resumeAttemptId,
      existingResume.invocationId,
    );
    return;
  }
  const result = await taskTool.execute(
    `decision-${decisionId}`,
    {
      agent_type: prior.agentType ?? "general",
      task_id: taskId,
      description: prior.description ?? `Resume ${taskId} after decision`,
      prompt: [
        `Resume the same task after parent decision ${decisionId}.`,
        optionId ? `Selected option: ${optionId}` : "",
        `Parent response: ${response}`,
        "Continue from the existing conversation. Return the normal structured task result when this attempt settles.",
      ]
        .filter(Boolean)
        .join("\n"),
      background: true,
      orchestration: {
        id: resumeCorrelationId,
      },
    },
    new AbortController().signal,
    undefined,
    ctx,
  );
  if (isFailedTaskResult(result)) {
    throw new Error(
      `Decision ${decisionId} was recorded but task resume failed: ${taskResultFailureReason(result)}`,
    );
  }
  const runs = await listDurableRuns(paths.runStore);
  const resumed = runs
    .filter(
      (candidate) =>
        candidate.invocationId !== prior.invocationId &&
        candidate.correlationId === resumeCorrelationId &&
        candidate.executionPhase !== "failed" &&
        candidate.executionPhase !== "cancelled" &&
        candidate.executionPhase !== "timeout",
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  if (!resumed) {
    throw new Error(
      `Decision ${decisionId} resumed without a durable correlated invocation`,
    );
  }
  await markDecisionResumeStarted(
    paths.runStore,
    prior.invocationId,
    decisionId,
    resumeAttemptId,
    resumed.invocationId,
  );
  } catch (error) {
    const correlated = (await listDurableRuns(paths.runStore))
      .filter(
        (candidate) =>
          candidate.invocationId !== prior.invocationId &&
          candidate.correlationId === resumeCorrelationId,
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    if (correlated) {
      await markDecisionResumeStarted(
        paths.runStore,
        prior.invocationId,
        decisionId,
        resumeAttemptId,
        correlated.invocationId,
      );
      return;
    }
    await patchDurableRun(paths.runStore, prior.invocationId, (current) => {
      const decision = current.decisionRequest;
      const currentResponse = decision?.response;
      if (
        !decision ||
        decision.id !== decisionId ||
        !currentResponse ||
        currentResponse.resumeAttemptId !== resumeAttemptId ||
        currentResponse.resumeState === "started"
      ) {
        return {};
      }
      return {
        decisionRequest: {
          ...decision,
          response: {
            ...currentResponse,
            resumeState: "failed",
            resumeError: errorMessage(error).slice(0, 1_000),
          },
        },
      };
    });
    throw error;
  } finally {
    state.decisionResumesInFlight.delete(dispatchKey);
  }
}

async function markDecisionResumeStarted(
  runStore: string,
  priorInvocationId: string,
  decisionId: string,
  resumeAttemptId: string,
  resumedInvocationId: string,
): Promise<void> {
  const patched = await patchDurableRun(
    runStore,
    priorInvocationId,
    (current) => {
      const decision = current.decisionRequest;
      const response = decision?.response;
      if (
        !decision ||
        decision.id !== decisionId ||
        !response ||
        response.resumeAttemptId !== resumeAttemptId
      ) {
        throw new Error(
          `Decision ${decisionId} resume attempt lost its durable ownership`,
        );
      }
      return {
        decisionRequest: {
          ...decision,
          response: {
            ...response,
            resumeState: "started",
            resumedInvocationId,
            resumeError: undefined,
          },
        },
      };
    },
  );
  if (!patched) {
    throw new Error(`Decision ${decisionId} disappeared while recording its resume`);
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
    void Promise.resolve(
      pi.events.emit("pi-subagents:batch-settled", {
        protocolVersion: 1,
        batchId,
        count: completed.length,
        timestamp: new Date().toISOString(),
      }),
    ).catch(() => undefined);
  }, 500);
  timer.unref();
  state.batchTimers.set(batchId, timer);
}

function startLeaseHeartbeats(state: RuntimeState, pi: ExtensionAPI): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    void Promise.all(
      [...state.activeRuns.values()].map((run) =>
        heartbeatActiveRun(pi, state, run, now),
      ),
    ).catch(() => undefined);
  }, 250);
  timer.unref();
  return timer;
}

async function heartbeatActiveRun(
  pi: ExtensionAPI,
  state: RuntimeState,
  run: ActiveRun,
  now: number,
): Promise<void> {
  if (run.leaseLost || run.heartbeatInFlight) return;
  const interval = run.lease ? leaseHeartbeatInterval(run.leaseTtlMs) : 60_000;
  if (now - (run.lastHeartbeatAt ?? 0) < interval) return;
  run.heartbeatInFlight = true;
  const paths = getOrchestrationPaths(run.projectDirectory);
  try {
    let renewed = run.lease;
    if (run.lease) {
      const ttlMs = run.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
      const sinceRenew =
        run.lastRenewMonotonicMs === undefined
          ? 0
          : monotonicNowMs() - run.lastRenewMonotonicMs;
      if (sinceRenew > ttlMs) {
        throw new Error(
          `lease TTL elapsed while the process was suspended (${Math.round(sinceRenew / 1000)}s > ${Math.round(ttlMs / 1000)}s)`,
        );
      }
      renewed = await renewResourceLease({
        storePath: paths.leaseStore,
        leaseId: run.lease.id,
        owner: run.taskId,
        expectedFence: run.lease.fence,
        ttlMs: run.leaseTtlMs,
      });
      if (!renewed) {
        throw new Error("lease renewal failed or the lease expired");
      }
      run.lease = renewed;
      run.lastRenewMonotonicMs = monotonicNowMs();
      if (run.invocationId) {
        await writeChildClaimGuardState(
          childClaimGuardStatePath(paths, run.invocationId),
          run.invocationId,
          renewed,
        );
      }
    }
    const heartbeatAt = new Date(now).toISOString();
    if (run.invocationId) {
      const patched = await patchDurableRun(paths.runStore, run.invocationId, {
        ...(renewed ? { lease: renewed } : {}),
        heartbeatAt,
      });
      if (!patched) throw new Error("durable run disappeared during heartbeat");
    }
    run.lastHeartbeatAt = now;
  } catch (error) {
    await abandonLostLease(
      pi,
      state,
      run,
      paths,
      `heartbeat failed: ${errorMessage(error)}`,
    );
  } finally {
    run.heartbeatInFlight = false;
  }
}

/** Monotonic milliseconds — immune to wall-clock adjustments. */
function monotonicNowMs(): number {
  return Math.round(performance.now());
}

/**
 * Surface a quarantined lease store instead of losing it in a log nobody reads.
 *
 * Quarantining is silent recovery — the system keeps working with an empty
 * store — and silent recovery from a corrupt lock file is exactly the situation
 * where an operator needs to know that mutual exclusion was reset, because any
 * lease held at that moment is gone and the tasks holding them do not know it.
 */
function registerStoreQuarantineReporter(
  pi: ExtensionAPI,
  state: RuntimeState,
): void {
  // Losing the task registry means the panes, processes, and worktrees recorded
  // in it will never be reaped — restore reads this file to find them. That has
  // to reach a human; it used to be indistinguishable from "no tasks".
  setRegistryQuarantineReporter(({ file, quarantinePath, reason }) => {
    void Promise.resolve(
      pi.events.emit("pi-subagents:v1:registry-quarantined", {
        version: 1,
        file,
        quarantinePath,
        reason,
      }),
    ).catch(() => undefined);
    pi.sendMessage(
      {
        customType: "orchestration-registry-quarantined",
        content:
          `The task registry at ${file} was unreadable (${reason}) and has been moved to ` +
          `${quarantinePath}. Background tasks recorded there cannot be restored, so any ` +
          `panes, agent processes, or worktrees they owned are now orphaned and need to be ` +
          `closed by hand.`,
        display: true,
      },
      { triggerTurn: false },
    );
  });

  setRunStoreQuarantineReporter(({ storePath, quarantinePath, reason }) => {
    void Promise.resolve(
      pi.events.emit("pi-subagents:v1:run-store-quarantined", {
        version: 1,
        storePath,
        quarantinePath,
        reason,
      }),
    ).catch(() => undefined);
    pi.sendMessage(
      {
        customType: "orchestration-run-store-quarantined",
        content:
          `The task run store at ${storePath} was unreadable (${reason}) and has been moved ` +
          `to ${quarantinePath}. Durable run state was reset; recovery will re-establish ` +
          `running tasks from panes and session history, but review/ship state recorded ` +
          `there is gone.`,
        display: true,
      },
      { triggerTurn: false },
    );
  });

  setStoreQuarantineReporter(({ storePath, quarantinePath, reason }) => {
    // Every run backed by this store has lost mutual exclusion.  Route it
    // through the same fenced-loss path as a failed renewal: merely marking it
    // lost leaves the child process running, while the heartbeat then returns
    // early forever. Calling `abandonLostLease` flips the in-memory fence
    // synchronously and also blocks the durable run and stops the task.
    const affectedRuns = [...state.activeRuns.values()].filter(
      (run) => getOrchestrationPaths(run.projectDirectory).leaseStore === storePath,
    );
    void Promise.all(
      affectedRuns.map((run) =>
        abandonLostLease(
          pi,
          state,
          run,
          getOrchestrationPaths(run.projectDirectory),
          `lease store quarantined: ${reason}`,
        ),
      ),
    ).catch(() => undefined);

    void appendOrchestrationEvent({
      eventPath: join(dirname(storePath), "events.jsonl"),
      event: {
        type: "claim_store_quarantined",
        orchestrationId: `quarantine-${basename(quarantinePath)}`,
        reason: `${reason} (moved to ${quarantinePath})`,
      },
    }).catch(() => undefined);

    void Promise.resolve(
      pi.events.emit("pi-subagents:v1:claim-store-quarantined", {
        version: 1,
        storePath,
        quarantinePath,
        reason,
      }),
    ).catch(() => undefined);

    pi.sendMessage(
      {
        customType: "orchestration-claim-store-quarantined",
        content:
          `The resource lease store at ${storePath} was unreadable (${reason}) and has been ` +
          `moved to ${quarantinePath}. Orchestration continues with an empty store, but any ` +
          `lease held before this point is gone — re-run tasks that were writing to claimed ` +
          `resources rather than assuming they are still protected.`,
        display: true,
      },
      { triggerTurn: false },
    );
  });
}

/**
 * A run has lost its lease. Move it to `blocked`, stop the task, and say so.
 *
 * `blocked` was previously a dead execution phase. This is what it is for: the
 * run is not failed (nothing went wrong with the work) and not running (it may
 * not touch the resource), and a human or the parent has to decide what next.
 */
async function abandonLostLease(
  pi: ExtensionAPI,
  state: RuntimeState,
  run: ActiveRun,
  paths: OrchestrationPaths,
  reason: string,
): Promise<void> {
  if (run.leaseLost) return;
  run.leaseLost = true;
  const lostLease = run.lease;
  run.lease = undefined;

  if (run.invocationId) {
    await patchDurableRun(paths.runStore, run.invocationId, {
      executionPhase: "blocked",
      blockedReason: reason,
    }).catch(() => undefined);
  }

  await appendOrchestrationEvent({
    eventPath: paths.eventLog,
    event: {
      type: "claim_lease_lost",
      orchestrationId: run.orchestrationId,
      taskId: run.taskId,
      ...(lostLease ? { leaseId: lostLease.id, fence: lostLease.fence } : {}),
      reason,
    },
  }).catch(() => undefined);

  try {
    await pi.events.emit("pi-subagents:v1:lease-lost", {
      version: 1,
      taskId: run.taskId,
      orchestrationId: run.orchestrationId,
      ...(lostLease ? { leaseId: lostLease.id, fence: lostLease.fence } : {}),
      reason,
    });
  } catch {
    // Event listeners are optional projections; losing one must not leave the
    // child running after the durable lease-loss transition.
  }

  try {
    pi.sendMessage(
      {
        customType: "orchestration-lease-lost",
        content:
          `Task ${run.taskId} lost its resource lease (${reason}). It is now blocked and ` +
          `must not write to its claimed resources. Re-run it to re-acquire the lease.`,
        display: true,
      },
      { triggerTurn: false },
    );
  } catch {
    // The durable blocked state and stop request below remain authoritative.
  }

  await stopOwnedTask(run.projectDirectory, run.taskId, `lease lost: ${reason}`).catch(() => undefined);
  state.activeRuns.delete(run.taskId);
}

async function completeFailedDurableRun(
  storePath: string,
  invocationId: string,
  patch: Partial<DurableTaskRun> & { executionPhase: "failed" },
): Promise<DurableTaskRun | undefined> {
  const resultDigest = taggedDigest({ invocationId, terminal: patch });
  return completeDurableRun(storePath, invocationId, resultDigest, patch);
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
