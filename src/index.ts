/**
 * Task Tool — Delegate complex work to specialist agents.
 *
 * Spawns pi CLI in a tmux split pane (foreground) or background.
 * Completion is detected from the subagent's final assistant message
 * in the persistent session JSONL (stopReason gating). The final message
 * is the authoritative result; no RESULT.md is used.
 *
 * Three agent sources:
 *   - .pi/agents/*.md        project-local agents
 *   - ~/.pi/agent/agents/*.md user-global agents (fallback)
 *
 * P0: Persistent task registry (appendEntry + JSON), --session resume,
 *     sendMessage completion notification, Ctrl+O expand/collapse.
 * P1: Foreground mode (background:false), pane death detection, timeout.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentSession,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { buildAgentToolSelection } from "./agent-tools.js";
import {
  BACKGROUND_CHECK_MS,
  COUNT_POLL_MS,
  MAX_POLL_ERRORS,
  TASK_TIMEOUT_MS,
} from "./constants.js";
import {
  findJsonlSessionByName,
  normalizeConversationId,
  findTaskSessionHistory,
  readRegistry,
  readTaskSessionsRegistry,
  upsertTaskSessionHistory,
  writeRegistry,
  writeTaskSessionsRegistry,
} from "./conversation.js";
import {
  TASK_BACKGROUND_DEFAULT,
  buildPiArgs,
  buildTaskToolDescription,
      countToolUses,
      discoverAgents,
      subscribeToolEvents,
  resolveTaskAgentPreflight,
  assessTaskResult,
  buildTaskEnvelope,
  formatBackgroundReceipt,
  parseResultXml,
  shellQuote,
} from "./helpers.js";
import {
  completeTask,
  createTaskWidgetController,
  restoreActiveBackgroundTasks,
  startBackgroundPolling,
  startToolStatsPolling,
} from "./lifecycle/index.js";
import { listActiveResourceLeases } from "./orchestration/claims.js";
import { getOrchestrationPaths } from "./orchestration/paths.js";
import {
  CHILD_CLAIM_GUARD_ENV,
  type ChildClaimGuardConfig,
} from "./orchestration/runtime.js";
import { formatSdkBackgroundReceipt, startSdkBackgroundTask } from "./subagent/sdkBackground.js";
import { runSdkSubagent } from "./subagent/runSdk.js";
import {
  createDefaultHerdrTerminalBackend,
  createSyncHerdrControl,
  restoreHerdrWorkspaceGroups,
} from "./subagent/herdr.js";
import { selectTerminalBackend } from "./subagent/terminalBackend.js";
import { steerRunningBackgroundTask } from "./subagent/steer.js";
import {
  checkTaskCompletion,
  waitForTaskCompletion as waitForSessionTaskCompletion,
} from "./subagent/waitCompletion.js";
import {
  hasTmux,
  killAgentPane,
  paneExists,
  setPaneRemainOnExit,
  setPaneSelfDestruct,
  splitWindowPane,
  wrapWithPaneExitWatcher,
} from "./subagent/tmux.js";
import {
  buildTaskPrompt,
  createTaskCompleteRenderer,
  renderCall,
  renderResult,
  startForegroundProgressPolling,
  taskParametersSchema,
} from "./tool/index.js";
import type {
  BackgroundTask,
  RegistryEntry,
  TerminalHandle,
} from "./types.js";
import { ignoreStaleExtensionCtx } from "./stale-ctx.js";
import {
  createTaskWorktree,
  finalizeTaskWorktree,
  removeTaskWorktree,
  type WorktreeHandle,
  type WorktreeResult,
} from "./worktree.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BUNDLED_AGENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents",
);
// Conversation helpers live in ./conversation.js.

// ─── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Prevent recursive loading
  if (process.env.PI_TASK_TOOL_DISABLED === "1") return;

  const taskToolName = process.env.PI_TASK_TOOL_NAME?.trim() || "task";
  const herdrWaitController = new AbortController();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskToolName)) {
    throw new Error(`Invalid PI_TASK_TOOL_NAME: ${taskToolName}`);
  }
  // ── Background task tracker ────────────────────────────────────────────
      const { piDir } = discoverAgents(process.cwd(), BUNDLED_AGENT_DIR);
      const backgroundTasks = new Map<string, BackgroundTask>();
      const foregroundTasks = new Map<string, BackgroundTask>();
  const unsubscribeTaskStopped = pi.events.on(
    "pi-subagents:task-stopped",
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const taskId = (payload as { taskId?: unknown }).taskId;
      if (typeof taskId !== "string") return;
      backgroundTasks.delete(taskId);
      foregroundTasks.delete(taskId);
    },
  );
  const taskWidget = createTaskWidgetController(foregroundTasks, backgroundTasks);
  const { ensureTaskWidget, clearTaskWidgetIfIdle } = taskWidget;

  // ── Restore active tasks from registry on load ──────────────────────────

  const syncHerdr = createSyncHerdrControl();
  const registryEntryAlive = (entry: RegistryEntry): boolean => entry.handle?.backend === "herdr"
    ? syncHerdr.exists(entry.handle)
    : Boolean(entry.paneId && paneExists(entry.paneId));
  const registryEntryStatus = (entry: RegistryEntry): "alive" | "missing" | "unavailable" => {
    try {
      return registryEntryAlive(entry) ? "alive" : "missing";
    } catch (error) {
      if (error instanceof Error && error.name === "HerdrUnavailableError") return "unavailable";
      throw error;
    }
  };
  restoreHerdrWorkspaceGroups(
    readRegistry(piDir)
      .filter(
        (entry) =>
          entry.handle?.backend === "herdr" &&
          registryEntryStatus(entry) !== "missing",
      )
      .map((entry) => entry.handle)
      .filter(
        (handle): handle is Extract<TerminalHandle, { backend: "herdr" }> =>
          handle?.backend === "herdr",
      ),
  );
  restoreActiveBackgroundTasks(
    piDir,
    backgroundTasks,
    registryEntryAlive,
    (entry) => {
      if (entry.handle?.backend === "herdr") syncHerdr.close(entry.handle);
      else if (entry.paneId) killAgentPane(entry.paneId, null);
    },
  );


  // ── Widget / timer setup ───────────────────────────────────────────────

  const countInterval = startToolStatsPolling(
    foregroundTasks,
    backgroundTasks,
    COUNT_POLL_MS,
        taskWidget.requestRender,
  );

  // ── Polling loop (background task completion, pane death, timeout) ──────

  const stopBackgroundPolling = startBackgroundPolling(
    {
      backgroundTasks,
      checkTaskCompletion,
      resourceExists: (task) => task.handle?.backend === "herdr"
        ? createDefaultHerdrTerminalBackend().isAlive(task.handle)
        : task.paneId
          ? paneExists(task.paneId)
          : false,
      killAgentPane: (paneId, originalPane) => {
        if (paneId) killAgentPane(paneId, originalPane);
      },
      clearTaskWidgetIfIdle,
      completeTask,
      TASK_TIMEOUT_MS,
      MAX_POLL_ERRORS,
      piDir,
      pi,
    },
    BACKGROUND_CHECK_MS,
  );

  // ── Cleanup on shutdown ────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    herdrWaitController.abort();
    unsubscribeTaskStopped?.();
    stopBackgroundPolling();
    clearInterval(countInterval);
    taskWidget.dispose();
  });

      // ── Custom notification renderer ───────────────────────────────────────
      pi.registerMessageRenderer?.("task-complete", createTaskCompleteRenderer());

  // ── Tool Registration ──────────────────────────────────────────────────

  pi.registerTool({
    name: taskToolName,
    label: taskToolName,
    description: buildTaskToolDescription(discoverAgents(process.cwd(), BUNDLED_AGENT_DIR).agents),
    promptSnippet: "Delegate work to a specialist agent via the task tool",
    promptGuidelines: [
      "Delegate complex multi-step work to a specialist agent when the work benefits from isolated context",
      "Launch multiple agents concurrently by making multiple tool calls in a single message",
      "Do NOT duplicate work you've delegated — wait for the result or work on non-overlapping tasks",
      "Use agent_type to route to the right specialist",
      "Tell the agent whether to write code or just research",
      "For background tasks: DO NOT sleep, poll, or check on progress. You'll be notified",
      "After delegated work completes, read changed files, review diff, verify scope, and run relevant checks",
      "Send the user a concise summary of the result since the agent's output is not user-visible",
      "For repo-local search (explore/general), name an absolute repo path in the prompt when the parent cwd is not the target (e.g. pi-task extension repo vs app repo)",
        ],
        parameters: taskParametersSchema(),

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { agents, piDir } = discoverAgents(ctx.cwd, BUNDLED_AGENT_DIR);
      const parentToolNames = pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter(Boolean);
      const preflight = resolveTaskAgentPreflight(agents, params.agent_type);
      if (!preflight.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: preflight.result.text,
            },
          ],
          details: {
            phase: "failed" as const,
            error: preflight.result.error,
          },
          isError: true,
        };
      }
      const agent = preflight.agent;

      // ── Resolve task identity: new, task resume, or conversation resume ──
      const conversationId = normalizeConversationId(params.conversation_id);
      const taskSessionsRegistry = conversationId
        ? readTaskSessionsRegistry(piDir)
        : {};
      const registeredTaskId = conversationId
        ? taskSessionsRegistry[conversationId]?.task_id
        : undefined;

      if (
        params.task_id &&
        registeredTaskId &&
        params.task_id !== registeredTaskId
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `conversation_id "${conversationId}" maps to ${registeredTaskId}, not ${params.task_id}. Omit task_id or use the mapped task id.`,
            },
          ],
          details: {
            phase: "failed" as const,
            error: "conversation_id/task_id mismatch",
          },
          isError: true,
        };
      }

          let id: string;
          let sessionName: string;
          let resume = false;
          let resumeSessionRef: string | undefined;
          let resumeWorktree: WorktreeHandle | undefined;
    
          const artifactsDir = join(piDir, "artifacts", "tasks");
    
          if (registeredTaskId) {
            id = registeredTaskId;
            sessionName = conversationId ?? `task-${id}`;
            const previous = findTaskSessionHistory(piDir, id);
            const metadataAgent = previous?.agentType;
            if (metadataAgent && metadataAgent !== agent.name) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `conversation_id "${conversationId}" belongs to agent "${metadataAgent}", not "${agent.name}". Use the original agent_type or start a different conversation_id.`,
                  },
                ],
                details: {
                  phase: "failed" as const,
                  error: "conversation_id agent_type mismatch",
                  conversation_id: conversationId,
                },
                isError: true,
              };
            }
            resume = true;
            resumeWorktree = previous?.worktree;

        const entry = readRegistry(piDir).find(
          (candidate) => candidate.id === id,
        );
        const entryStatus = entry ? registryEntryStatus(entry) : "missing";
        if (entryStatus === "unavailable") {
          return {
            content: [{ type: "text" as const, text: "The HerdR session for this conversation is temporarily unavailable. The durable task record was preserved; retry when HerdR reconnects." }],
            details: { phase: "failed" as const, error: "HerdR temporarily unavailable" },
            isError: true,
          };
        }
        if (
          params.background !== false &&
          entry &&
          entryStatus === "alive"
        ) {
          const bgtask: BackgroundTask = {
            dir: artifactsDir,
            agentType: entry.agentType,
            sessionName,
            paneId: entry.handle?.resourceId ?? entry.paneId,
            handle: entry.handle,
            backend: entry.handle?.backend ?? "tmux",
            originalPane: null,
            description: params.description || entry.description,
            startedAt: entry.startedAt,
            toolUses: 0,
            turns: 0,
            conversationId,
            worktree: entry.worktree,
            recentCalls: [],
          };
                    backgroundTasks.set(id, bgtask);
          const steerResult = steerRunningBackgroundTask(bgtask.paneId, params.prompt, bgtask.handle);
          if (!steerResult.ok) {
            return {
              content: [{ type: "text" as const, text: `Conversation "${conversationId}" was restored, but the follow-up prompt could not be delivered (${steerResult.reason}).` }],
              details: { phase: "failed" as const, error: `resume steering failed: ${steerResult.reason}` },
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Resumed conversation "${conversationId}" via ${sessionName} and delivered the follow-up prompt. The subagent is running in background and will notify on completion.`,
              },
            ],
            details: {
              task_id: id,
              agent_type: agent.name,
              description: params.description,
              conversation_id: conversationId,
              tmux_session: sessionName,
              background: true,
            },
          };
        }
      } else if (params.task_id) {
        // Look up active tasks first, then durable completed-session history.
        const entries = readRegistry(piDir);
        let entry =
          entries.find(
            (e) => e.id === params.task_id || e.sessionName === params.task_id,
          ) ??
          findTaskSessionHistory(piDir, params.task_id) ??
          findJsonlSessionByName(piDir, params.task_id, agent.name);

        // Older history entries were written before we stored the
        // actual JSONL path needed by `pi --session`. Repair them by
        // resolving the display session name to a session file.
        if (entry && !entry.sessionRef) {
          const discovered = findJsonlSessionByName(
            piDir,
            entry.sessionName,
            entry.agentType,
          );
          if (discovered?.sessionRef) {
            entry = { ...entry, sessionRef: discovered.sessionRef };
            upsertTaskSessionHistory(piDir, {
              ...entry,
              status: "done",
              background: false,
            });
          }
        }
        if (!entry) {
          params = { ...params, task_id: undefined };
          id = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
          sessionName = conversationId ?? `task-${id}`;
        } else {
        if (!existsSync(entry.dir)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Task "${params.task_id}" artifact directory no longer exists: ${entry.dir}`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "Task artifact dir missing",
            },
            isError: true,
          };
        }
        // Resume: reuse the existing session name; runtime files are
        // flat in artifactsDir, no per-task subdir.
         id = entry.id;
         sessionName = entry.sessionName;
         resume = true;
         resumeSessionRef = entry.sessionRef;
         resumeWorktree = entry.worktree;

        // If background and the terminal resource is still alive, reattach to the tracker.
        const entryStatus = registryEntryStatus(entry);
        if (entryStatus === "unavailable") {
          return {
            content: [{ type: "text" as const, text: "The HerdR session for this task is temporarily unavailable. The durable task record was preserved; retry when HerdR reconnects." }],
            details: { phase: "failed" as const, error: "HerdR temporarily unavailable" },
            isError: true,
          };
        }
        if (
          params.background !== false &&
          entryStatus === "alive"
        ) {
          const bgtask: BackgroundTask = {
            dir: artifactsDir,
            agentType: entry.agentType,
            sessionName,
            paneId: entry.handle?.resourceId ?? entry.paneId,
            handle: entry.handle,
            backend: entry.handle?.backend ?? "tmux",
            originalPane: null,
            description: params.description || entry.description,
            startedAt: entry.startedAt,
            toolUses: 0,
            turns: 0,
            conversationId: entry.conversationId,
            worktree: entry.worktree,
            recentCalls: [],
          };
          backgroundTasks.set(id, bgtask);
          const steerResult = steerRunningBackgroundTask(bgtask.paneId, params.prompt, bgtask.handle);
          if (!steerResult.ok) {
            return {
              content: [{ type: "text" as const, text: `Task "${params.task_id}" was restored, but the follow-up prompt could not be delivered (${steerResult.reason}).` }],
              details: { phase: "failed" as const, error: `resume steering failed: ${steerResult.reason}` },
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Resumed task "${params.task_id}" and delivered the follow-up prompt. The subagent is still running in background; avoid relaunching overlapping work. Use /task-sessions to inspect it, and it will notify on completion.`,
              },
            ],
            details: {
              task_id: id,
              agent_type: entry.agentType,
              description: params.description || entry.description,
              conversation_id: entry.conversationId ?? conversationId,
              tmux_session: sessionName,
              background: true,
            },
          };
        }

        if (!resumeSessionRef) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Task "${params.task_id}" was found, but its session JSONL file could not be resolved. Cannot resume without a --session file path.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "Task session file missing",
            },
            isError: true,
          };
        }
        }
       } else {
         id = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
         sessionName = conversationId ?? `task-${id}`;
       }

      const durableBackendPreference = (process.env.PI_TASK_BACKEND ?? "auto").trim().toLowerCase();
      const herdrContextAvailable = process.env.HERDR_ENV === "1"
        && Boolean(process.env.HERDR_PANE_ID)
        && Boolean(process.env.HERDR_SOCKET_PATH);
      if (conversationId && (durableBackendPreference === "sdk" || (!hasTmux() && !herdrContextAvailable))) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Durable conversations require an active HerdR or tmux terminal backend so Pi can save and reopen the subagent session. Start Pi inside HerdR, start tmux, or omit conversation_id for a one-shot SDK task.",
            },
          ],
          details: {
            phase: "failed" as const,
            error: "tmux required for durable conversation",
            conversation_id: conversationId,
          },
          isError: true,
        };
      }

      if (conversationId) {
        await mkdir(artifactsDir, { recursive: true });
        const taskSessionsRegistry = readTaskSessionsRegistry(piDir);
        taskSessionsRegistry[conversationId] = {
              task_id: id,
              updated_at: new Date().toISOString(),
            };
        writeTaskSessionsRegistry(piDir, taskSessionsRegistry);
      }

      const descText = params.description || "";
      const isBackground = params.background ?? TASK_BACKGROUND_DEFAULT;
      // default true

      let worktree = resumeWorktree;
      if (worktree && !existsSync(worktree.path)) {
        return {
          content: [{ type: "text" as const, text: `The isolated worktree for task ${id} no longer exists: ${worktree.path}` }],
          details: { phase: "failed" as const, error: "Task worktree missing", task_id: id },
          isError: true,
        };
      }
      if (!worktree && params.isolation === "worktree") {
        try {
          worktree = createTaskWorktree({ cwd: ctx.cwd, taskIdHint: id });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { phase: "failed" as const, error: message, task_id: id },
            isError: true,
          };
        }
      }
      const executionCwd = worktree?.path ?? ctx.cwd;

      // Everything the child needs to enforce write claims on itself: where
      // the parent's lease store is, and which identities it may write under.
      // Without this, the child — the process doing the delegated writing —
      // was the one process whose writes were never checked (audit S-A).
      const claimGuardConfig: ChildClaimGuardConfig = {
        version: 2,
        projectDirectory: ctx.cwd,
        leaseStore: getOrchestrationPaths(ctx.cwd).leaseStore,
        guardStatePath: join(
          getOrchestrationPaths(ctx.cwd).root,
          "claim-guards",
          `${params.__pi_subagents_invocation_id ?? id}.json`,
        ),
        guardStateRequired: false,
      };
      const claimOwnerIds = [
        id,
        ...(params.__pi_subagents_invocation_id
          ? [params.__pi_subagents_invocation_id]
          : []),
      ];
      try {
        const leases = await listActiveResourceLeases({
          storePath: claimGuardConfig.leaseStore,
        });
        claimGuardConfig.guardStateRequired = leases.some(
          (lease) =>
            claimOwnerIds.includes(lease.owner) &&
            lease.claims.some(
              (claim) => claim.kind === "write" || claim.kind === "test",
            ),
        );
      } catch {
        claimGuardConfig.guardStateRequired = true;
      }
      const claimGuardEnvValue = JSON.stringify(claimGuardConfig);

      /**
       * Does this launch hold write claims in the shared project directory?
       * Owner is still the invocation id at this point — ownership transfers
       * to the task id only after the tool result returns.
       */
      const holdsSharedWriteClaims = async (): Promise<boolean> => {
        if (worktree) return false;
        try {
          const leases = await listActiveResourceLeases({
            storePath: claimGuardConfig.leaseStore,
          });
          return leases.some(
            (lease) =>
              claimOwnerIds.includes(lease.owner) &&
              lease.claims.some((claim) => claim.kind === "write"),
          );
        } catch {
          // The store being unreadable is reported elsewhere; for backend
          // selection, assume claims exist and take the enforceable path.
          return true;
        }
      };

          // ── Build the prompt (instructions are inlined; no CONTEXT.md file) ─
          const promptContent = buildTaskPrompt({
            description: descText,
            agentName: agent.name,
            agentSource: agent.source,
            prompt: params.prompt,
            cwd: executionCwd,
          });

          const sessionDir = join(artifactsDir, "sessions", id);
          await mkdir(sessionDir, { recursive: true });

      // ─── Build and run the sub-agent pi process ──────────────────────────
      const legacyRequestedBackend = process.env.PI_TASK_USE_TMUX_BACKEND === "1"
        ? "tmux"
        : process.env.PI_TASK_USE_SDK_BACKEND === "1"
          ? "sdk"
          : undefined;
      const requestedBackend = (legacyRequestedBackend ?? process.env.PI_TASK_BACKEND ?? "auto").trim().toLowerCase();
      if (!["auto", "sdk", "tmux", "herdr"].includes(requestedBackend)) {
        return {
          content: [{ type: "text", text: `Invalid PI_TASK_BACKEND=${requestedBackend}. Expected auto, sdk, tmux, or herdr.` }],
          details: { phase: "failed" as const, error: "invalid backend" },
        };
      }
      const herdrBackend = createDefaultHerdrTerminalBackend();
      const hasHerdr = requestedBackend === "auto" || requestedBackend === "herdr"
        ? await herdrBackend.available()
        : false;
      const selectedBackend = selectTerminalBackend({
        requested: requestedBackend as "auto" | "sdk" | "tmux" | "herdr",
        hasHerdr,
        hasTmux: hasTmux(),
      });
      if (!selectedBackend) {
        const error = requestedBackend === "herdr"
          ? "HerdR backend requires Pi to run inside an active HerdR pane with HERDR_SOCKET_PATH set. Start Pi from HerdR; `herdr integration install pi` is optional."
          : `Requested ${requestedBackend} backend is unavailable.`;
        return {
          content: [{ type: "text", text: error }],
          details: { phase: "failed" as const, error },
        };
      }
      let promptLaunch:
        | { systemPromptPath: string; deferTaskPrompt: boolean }
        | undefined;
      if (selectedBackend === "herdr") {
        promptLaunch = {
          systemPromptPath: join(sessionDir, "agent-system-prompt.md"),
          deferTaskPrompt: true,
        };
        await writeFile(promptLaunch.systemPromptPath, agent.body, "utf8");
      }
      const piArgs = buildPiArgs(
        agent,
        sessionName,
        sessionDir,
        promptContent,
        resume,
        parentToolNames,
        taskToolName,
        resumeSessionRef,
        promptLaunch,
      );
      const useSdkBackend = selectedBackend === "sdk";

          const toolSelection = buildAgentToolSelection({
            tools: agent.tools,
            disallowedTools: agent.disallowedTools,
            parentToolNames,
            taskToolName,
          });
          const runSdkFallback = async (
            foregroundTask?: BackgroundTask,
            onSession?: (session: AgentSession) => () => void,
          ) => {
            // The SDK subagent runs in-process with `noExtensions: true`, so no
            // guard can see its writes. A launch holding write claims in the
            // shared project directory is refused here rather than run
            // unenforced — worktree isolation or a terminal backend both work.
            if (await holdsSharedWriteClaims()) {
              throw new Error(
                "This task holds write claims but the SDK backend cannot enforce them. " +
                  'Run inside tmux/Herdr, or pass isolation: "worktree" to isolate the writes.',
              );
            }
            return runSdkSubagent({
              onSession: foregroundTask
                ? (session) => subscribeToolEvents(session, foregroundTask, 10, taskWidget.requestRender)
                : onSession,
              prompt: promptContent,
              agent,
              cwd: executionCwd,
              ctx,
              model: agent.model,
              thinkingLevel: agent.thinking,
              tools: toolSelection.tools,
              excludeTools: toolSelection.excludeTools,
              systemPrompt: agent.body,
            });
          };

      const foregroundTask: BackgroundTask | undefined = isBackground
        ? undefined
        : {
            dir: artifactsDir,
            agentType: agent.name,
            sessionName,
                    backend: selectedBackend,
            originalPane: null,
            description: descText,
            startedAt: Date.now(),
            toolUses: 0,
            turns: 0,
            conversationId,
            worktree,
            recentCalls: [],
          };

      if (foregroundTask) {
        foregroundTasks.set(id, foregroundTask);
        ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));
      }

          // Prefer tmux when the parent Pi is running inside tmux so users can watch
          // the subagent's interactive Pi TUI. Fall back to the SDK only when tmux is
          // unavailable, or when explicitly forced with PI_TASK_BACKEND=sdk.
          if (useSdkBackend) {
            if (isBackground) {

              const backgroundTask: BackgroundTask = {
                dir: artifactsDir,
                agentType: agent.name,
                sessionName,
                backend: "sdk",
                originalPane: null,
                description: descText,
                startedAt: Date.now(),
                toolUses: 0,
                turns: 0,
                conversationId,
                worktree,
                recentCalls: [],
              };
              backgroundTasks.set(id, backgroundTask);
              ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));
              const bgOnSession = (session: AgentSession) =>
                subscribeToolEvents(session, backgroundTask, 10, taskWidget.requestRender);

              startSdkBackgroundTask({
                id,
                agentType: agent.name,
                description: descText,
                sessionName,
                startedAt: backgroundTask.startedAt,
                piDir,
                artifactsDir,
                conversationId,
                worktree,
                run: async () => runSdkFallback(undefined, bgOnSession),
                onComplete: (result, worktreeResult) => {
                  const parsed = parseResultXml(result.output);
                  const assessment = assessTaskResult(parsed);
                  const summary = parsed.summary || "SDK subagent completed without assistant text.";
                  ignoreStaleExtensionCtx(() =>
                    pi.sendMessage(
                      {
                        customType: "task-complete",
                        content: `Background task ${id} (${agent.name}) done.\n\n${summary}`,
                        display: true,
                        details: {
                          task_id: id,
                          agent_type: agent.name,
                          description: descText,
                          phase: "done",
                          execution_phase: "done",
                          status: assessment.reportedStatus,
                          reported_status: assessment.reportedStatus,
                          result_valid: assessment.valid,
                          result: result.output,
                          summary: parsed.summary,
                          findings: parsed.findings,
                          evidence: parsed.evidence,
                          files: parsed.files,
                          caveats: parsed.caveats,
                          next_steps: parsed.next_steps,
                          confidence: parsed.confidence,
                          ...(parsed.needs_decision
                            ? { needs_decision: parsed.needs_decision }
                            : {}),
                          ...(parsed.decision_request
                            ? { decision_request: structuredClone(parsed.decision_request) }
                            : {}),
                          duration_ms: Date.now() - backgroundTask.startedAt,
                          tool_uses: backgroundTask.toolUses,
                          turn_count: backgroundTask.turns,
                          background: true,
                          structured_result: assessment.valid,
                          full_output: parsed.raw.trim() || result.output.trim(),
                          worktree: worktreeResult,
                        },
                      },
                      { triggerTurn: true, deliverAs: "followUp" },
                    ),
                  );
                },
                onFailed: (error, worktreeResult) => {
                  const message = error instanceof Error ? error.message : String(error);
                  ignoreStaleExtensionCtx(() =>
                    pi.sendMessage(
                      {
                        customType: "task-complete",
                        content: `Background task ${id} (${agent.name}) failed.\n\n${message}`,
                        display: true,
                        details: {
                          task_id: id,
                          agent_type: agent.name,
                          description: descText,
                          phase: "failed",
                          execution_phase: "failed",
                          status: "unknown",
                          reported_status: "unknown",
                          result_valid: false,
                          summary: message,
                          duration_ms: Date.now() - backgroundTask.startedAt,
                          tool_uses: backgroundTask.toolUses,
                          turn_count: backgroundTask.turns,
                          background: true,
                          worktree: worktreeResult,
                        },
                      },
                      { triggerTurn: true, deliverAs: "followUp" },
                    ),
                  );
                },
                onSettled: () => {
                  backgroundTasks.delete(id);
                  ignoreStaleExtensionCtx(() => clearTaskWidgetIfIdle());
                },
              });

          return {
            content: [{ type: "text" as const, text: formatSdkBackgroundReceipt(id) }],
            details: {
              phase: "running" as const,
              backend: "sdk" as const,
              background: true,
              task_id: id,
              agent_type: agent.name,
              description: descText,
              conversation_id: conversationId,
            },
          };
        }

            try {
              const { output, sessionPath } = await runSdkFallback(foregroundTask);
              const worktreeResult = worktree
                ? finalizeTaskWorktree(worktree)
                : undefined;

          const finalOutput = output || "SDK subagent completed without assistant text.";
              const parsed = parseResultXml(finalOutput);
              const assessment = assessTaskResult(parsed);
              const envelope = buildTaskEnvelope(parsed, {
                agent_type: agent.name,
                description: descText,
                tool_uses: foregroundTask!.toolUses,
                duration_ms: Date.now() - foregroundTask!.startedAt,
                background: false,
              });
              return {
                content: envelope.content,
                details: {
                  ...envelope.details,
                  phase: "done" as const,
                  execution_phase: "done" as const,
                  reported_status: assessment.reportedStatus,
                  result_valid: assessment.valid,
                  backend: "sdk" as const,
                  session_path: sessionPath,
                  conversation_id: conversationId,
                  full_output: parsed.raw.trim() || finalOutput,
                  worktree: worktreeResult,
                },
              };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          let failedWorktreeResult: WorktreeResult | undefined;
          try {
            failedWorktreeResult = worktree ? finalizeTaskWorktree(worktree) : undefined;
          } catch {
            failedWorktreeResult = undefined;
          }
          return {
            content: [
              { type: "text" as const, text: `SDK task failed: ${message}` },
            ],
            details: {
              phase: "failed" as const,
              execution_phase: "failed" as const,
              status: "unknown",
              reported_status: "unknown",
              result_valid: false,
              backend: "sdk" as const,
              error: message,
              worktree: failedWorktreeResult,
            },
            isError: true,
          };
        } finally {
          foregroundTasks.delete(id);
          clearTaskWidgetIfIdle();
        }
      }

      let paneId: string;
      let originalPane: string | null;
      let handle: TerminalHandle;
      try {
        if (selectedBackend === "herdr") {
          handle = await herdrBackend.launch({
            agentArgs: piArgs,
            initialPrompt: promptContent,
            cwd: executionCwd,
            env: {
              PI_TASK_TOOL_DISABLED: "1",
              [CHILD_CLAIM_GUARD_ENV]: claimGuardEnvValue,
            },
            label: `${agent.name}-${id.slice(0, 8)}`,
            workspaceGroup: params.workspace_group,
            signal,
          });
          paneId = handle.resourceId;
          originalPane = process.env.HERDR_PANE_ID ?? null;
        } else {
          const shellCommand = `PI_TASK_TOOL_DISABLED=1 ${CHILD_CLAIM_GUARD_ENV}=${shellQuote(claimGuardEnvValue)} pi ${piArgs.map((a) => shellQuote(a)).join(" ")}`;
          const sessionFile = join(sessionDir, sessionName + ".jsonl");
          const childCommand = `cd ${shellQuote(executionCwd)} && ${shellCommand}`;
          const terminalCommand = wrapWithPaneExitWatcher(sessionFile, childCommand);
          const splitResult = splitWindowPane(executionCwd, terminalCommand);
          paneId = splitResult.paneId;
          originalPane = splitResult.originalPane;
          handle = { backend: "tmux", resourceId: paneId };
          setPaneRemainOnExit(paneId, Boolean(foregroundTask));
        }
        if (foregroundTask) {
          foregroundTask.backend = selectedBackend;
          foregroundTask.paneId = paneId;
          foregroundTask.handle = handle;
          foregroundTask.originalPane = originalPane;
        } else if (selectedBackend === "tmux") {
          setPaneSelfDestruct(paneId, true);
        }
      } catch {
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        if (worktree && !resumeWorktree) {
          try {
            removeTaskWorktree(worktree, true);
          } catch {
            // Preserve the original launch failure; doctor can report leaked worktrees.
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create ${selectedBackend} execution pane for the agent.`,
            },
          ],
          details: { phase: "failed" as const, error: `${selectedBackend} launch failed` },
          isError: true,
        };
      }

      if (params.__pi_subagents_invocation_id) {
        pi.events.emit("pi-subagents:task-launched", {
          protocolVersion: 1,
          invocationId: params.__pi_subagents_invocation_id,
          taskId: id,
          resumed: Boolean(params.task_id),
          agentType: agent.name,
          description: descText,
          backend: selectedBackend,
          executionDirectory: executionCwd,
          worktree,
          timestamp: new Date().toISOString(),
        });
      }

      // ── FOREGROUND MODE: block until result, return directly ────────────
      if (!isBackground) {
        const startedAt = foregroundTask?.startedAt ?? Date.now();
        upsertTaskSessionHistory(piDir, {
          id,
          agentType: agent.name,
          description: descText,
          sessionName,
          startedAt,
          paneId,
          handle,
          piDir,
          dir: artifactsDir,
          conversationId,
          worktree,
          status: "running",
          background: false,
        });

                        const stopProgress = startForegroundProgressPolling({
                              taskId: id,
                              sessionDir,
                              sessionName,
                              agentType: agent.name,
                              description: descText,
                              startedAt,
                              onUpdate: onUpdate ?? (() => {}),
                            });

                        const onAbort = () => stopProgress();
                        signal?.addEventListener("abort", onAbort, { once: true });

            const completion = await waitForSessionTaskCompletion({
              sessionDir,
              sessionName,
              paneId,
              signal,
              timeoutMs: TASK_TIMEOUT_MS,
              pollMs: 1000,
              sinceMs: startedAt,
              resourceExists: selectedBackend === "herdr"
                ? () => herdrBackend.isAlive(handle as Extract<TerminalHandle, { backend: "herdr" }>)
                : undefined,
            });
        stopProgress();
        signal?.removeEventListener("abort", onAbort);
        const content = completion.content;
        const parsed = parseResultXml(content);
        const assessment = assessTaskResult(parsed);
        const phase =
          completion.status === "completed"
            ? "done"
            : completion.status === "cancelled"
              ? "cancelled"
              : "failed";
        const completedSessionRef = findJsonlSessionByName(
          piDir,
          sessionName,
          agent.name,
        )?.sessionRef;
        let worktreeResult: WorktreeResult | undefined;
        if (worktree) {
          try {
            worktreeResult = finalizeTaskWorktree(worktree);
          } catch {
            // Keep the worktree handle in history for manual recovery.
          }
        }
        upsertTaskSessionHistory(piDir, {
          id,
          agentType: agent.name,
          description: descText,
          sessionName,
          startedAt,
          paneId,
          handle,
          piDir,
          dir: artifactsDir,
          conversationId,
          sessionRef: completedSessionRef,
          worktree,
          worktreeResult,
          status: phase,
          reportedStatus: assessment.reportedStatus,
          resultValid: assessment.valid,
          completedAt: Date.now(),
          background: false,
        });
        if (phase === "done") {
          if (handle.backend === "herdr") await herdrBackend.close(handle);
          else killAgentPane(paneId, originalPane);
        } else {
          // The subagent pane is still alive after a cancel/failed/timeout
          // (we never reached the done branch). Without this, a user-initiated
          // session replacement while the foreground wait was in flight would
          // abort the wait → return cancelled → leave the pane orphaned. Always
          // tear down the pane on any terminal status so the user never ends up
          // with a dangling tmux split. Best-effort: ignore failures (pane may
          // already be gone).
          try {
            if (handle.backend === "herdr") await herdrBackend.close(handle);
            else killAgentPane(paneId, originalPane);
          } catch {
            // ignore
          }
        }
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        const durationMs = Date.now() - startedAt;
        const { toolUses, turns } = countToolUses(sessionDir, sessionName);
        const envelope = buildTaskEnvelope(parsed, {
          agent_type: agent.name,
          description: descText,
          tool_uses: toolUses,
          duration_ms: durationMs,
          background: false,
        });
        return {
          ...envelope,
          details: {
            ...envelope.details,
            task_id: id,
            phase,
            execution_phase: phase,
            reported_status: assessment.reportedStatus,
            result_valid: assessment.valid,
            confidence: parsed.confidence || "",
            turn_count: turns,
            conversation_id: conversationId,
            full_output: parsed.raw.trim() || content.trim(),
            worktree: worktreeResult,
          },
        };
          }

      // ── BACKGROUND MODE (default): add to tracker, return immediately ─────

      const bgtask: BackgroundTask = {
        dir: artifactsDir,
        agentType: agent.name,
        sessionName,
        paneId,
        handle,
        originalPane,
        description: descText,
        startedAt: Date.now(),
        toolUses: 0,
        turns: 0,
        conversationId,
        worktree,
        recentCalls: [],
        backend: selectedBackend,
      };

      backgroundTasks.set(id, bgtask);

      // ── P0: Persistent registry ────────────────────────────────────────
      const entry: RegistryEntry = {
        id,
        agentType: agent.name,
        description: descText,
        sessionName,
        startedAt: bgtask.startedAt,
        paneId,
        handle,
        piDir,
        dir: artifactsDir,
        conversationId,
        worktree,
      };

      // Write to JSON registry for on-load restore
      const entries = readRegistry(piDir);
      entries.push(entry);
      writeRegistry(piDir, entries);
      upsertTaskSessionHistory(piDir, {
        ...entry,
        status: "running",
        background: true,
      });
      // Also persist to session store via appendEntry (audit trail). This is
      // best-effort because OpenPi can replace sessions while an older pi-task
      // closure is still unwinding, making captured extension APIs stale. The
      // JSON registry/history above are the durable source of truth.
      ignoreStaleExtensionCtx(() => pi.appendEntry("task-registry", entry));

      // Do not kill a background subagent when the parent session aborts or is
      // replaced. Background tasks are intentionally detached; the registry and
      // polling loop own their lifecycle after the pane is spawned.

      // ── Sticky widget ──────────────────────────────────────────────────
      ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));

      if (handle.backend === "herdr" && herdrBackend.waitForAttention) {
        void herdrBackend
          .waitForAttention(handle, {
            signal: herdrWaitController.signal,
            timeoutMs: TASK_TIMEOUT_MS,
          })
          .then(async ({ status }) => {
            const active = backgroundTasks.get(id);
            if (!active) return;
            active.phase = status;
            taskWidget.requestRender();
            // Herdr is the wake-up signal; Pi JSONL remains completion truth.
            await stopBackgroundPolling.tick();
          })
          .catch((error: unknown) => {
            if (herdrWaitController.signal.aborted) return;
            if (error instanceof Error && /timeout/iu.test(error.message)) return;
            // Reconciliation polling remains active if the wait stream is interrupted.
          });
      }

      return {
        content: [
          {
            type: "text" as const,
                text: formatBackgroundReceipt({
                  taskId: id,
                  agentType: agent.name,
                  sessionPath: join(sessionDir, `${sessionName}.jsonl`),
                  backend: selectedBackend,
                  backendReason: requestedBackend === "auto" && selectedBackend !== "herdr"
                    ? "HerdR unavailable"
                    : undefined,
                }),
          },
        ],
        details: {
          task_id: id,
          agent_type: agent.name,
          description: descText,
          tmux_session: sessionName,
          background: true,
        },
      };
    },

        renderCall,
        renderResult,
  });

  pi.registerCommand("task-sessions", {
    description: "List durable pi-task conversations",
    handler: async (_args, ctx) => {
      const cwd = ctx.sessionManager?.getCwd?.() ?? process.cwd();
      const { piDir } = discoverAgents(cwd);
      const registry = readTaskSessionsRegistry(piDir);
      const rows = Object.entries(registry)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([conversationId, entry]) => `- ${conversationId} -> ${entry.task_id}`);
      ctx.ui.notify(
        rows.length > 0
          ? `Durable pi-task conversations:\n${rows.join("\n")}`
          : "No durable pi-task conversations found.",
        "info",
      );
    },
  });
}
