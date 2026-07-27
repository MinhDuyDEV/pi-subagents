import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readRegistry, writeRegistry } from "../conversation.js";
import { findPiDir } from "../helpers.js";
import { createSyncHerdrControl } from "../subagent/herdr.js";
import { steerRunningBackgroundTask } from "../subagent/steer.js";
import { killAgentPane } from "../subagent/tmux.js";
import { releaseResourceLease } from "./claims.js";
import { runOrchestrationDoctor } from "./doctor.js";
import { getOrchestrationPaths } from "./paths.js";
import { listDurableRuns, patchDurableRun } from "./run-store.js";
import { getFinalTaskResult, getTaskSnapshot } from "./task-query.js";
import { TaskScheduler } from "./scheduler.js";
import {
  appendOrchestrationEvent,
  deriveOrchestrationMetrics,
  readOrchestrationEvents,
} from "./telemetry.js";

export async function stopOwnedTask(
  projectDirectory: string,
  taskId: string,
  reason = "Stopped by owner",
): Promise<void> {
  const piDirectory = resolvePiDirectory(projectDirectory);
  const registry = readRegistry(piDirectory);
  const entry = registry.find((candidate) => candidate.id === taskId);
  let cleanupError: unknown;
  try {
    if (entry?.handle?.backend === "herdr") {
      createSyncHerdrControl().close(entry.handle);
    } else if (entry?.paneId) {
      killAgentPane(entry.paneId, null);
    }
  } catch (error) {
    cleanupError = error;
  }
  if (entry) {
    writeRegistry(
      piDirectory,
      registry.filter((candidate) => candidate.id !== taskId),
    );
  }

  const paths = getOrchestrationPaths(projectDirectory);
  const run = (await listDurableRuns(paths.runStore)).find(
    (candidate) => candidate.taskId === taskId,
  );
  if (run?.lease) {
    await releaseResourceLease({
      storePath: paths.leaseStore,
      leaseId: run.lease.id,
      expectedOwner: run.lease.owner,
      expectedFence: run.lease.fence,
    });
  }
  if (run && !["completed", "failed", "cancelled", "timeout"].includes(run.executionPhase)) {
    await patchDurableRun(paths.runStore, run.invocationId, {
      executionPhase: "cancelled",
    });
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: "task_cancelled",
        orchestrationId: run.correlationId ?? run.invocationId,
        taskId,
        reason,
      },
    });
  }
  if (cleanupError) {
    throw new Error(
      `Task ${taskId} state was settled but backend cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      { cause: cleanupError },
    );
  }
}

export function registerTaskCommands(pi: ExtensionAPI): void {
  pi.registerCommand("tasks", {
    description: "Show the durable delegated-task fleet",
    handler: async (_args, ctx) => {
      const paths = getOrchestrationPaths(ctx.cwd);
      const runs = (await listDurableRuns(paths.runStore)).sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      if (runs.length === 0) {
        ctx.ui.notify("No delegated tasks found.", "info");
        return;
      }
      const visible = runs.slice(0, 30);
      const labels = visible.map((run) => {
        const id = run.taskId ?? run.invocationId.slice(0, 8);
        const age = formatAge(Date.now() - Date.parse(run.startedAt));
        const gates = `${run.verificationPhase}/${run.reviewPhase}`;
        return `${statusGlyph(run.executionPhase)} ${id} · ${run.agentType ?? "agent"} · ${run.executionPhase} · ${gates} · ${age}`;
      });
      if (ctx.hasUI) {
        const selected = await ctx.ui.select(
          `Delegated tasks (${runs.length})`,
          labels,
        );
        const index = selected ? labels.indexOf(selected) : -1;
        const run = index >= 0 ? visible[index] : undefined;
        if (run) {
          ctx.ui.notify(
            [
              run.description ?? "No description",
              `Task: ${run.taskId ?? "allocating"}`,
              `Invocation: ${run.invocationId}`,
              `Execution: ${run.executionPhase}`,
              `Verification: ${run.verificationPhase}`,
              `Review: ${run.reviewPhase}`,
              `Directory: ${run.executionDirectory}`,
              `Claims: ${run.claims.map((claim) => `${claim.kind}:${claim.resource}`).join(", ") || "none"}`,
            ].join("\n"),
            "info",
          );
        }
        return;
      }
      ctx.ui.notify(`Delegated tasks (${runs.length}):\n${labels.join("\n")}`, "info");
    },
  });

  pi.registerCommand("task", {
    description: "Inspect one durable task: /task <task-id>",
    handler: async (args, ctx) => {
      const taskId = args.trim();
      if (!taskId) {
        ctx.ui.notify("Usage: /task <task-id>", "warning");
        return;
      }
      const snapshot = await getTaskSnapshot(ctx.cwd, taskId);
      const paths = getOrchestrationPaths(ctx.cwd);
      const run = (await listDurableRuns(paths.runStore)).find(
        (candidate) => candidate.taskId === taskId,
      );
      const text = [
        `Task: ${taskId}`,
        `Status: ${snapshot.status}`,
        ...(run
          ? [
              `Execution: ${run.executionPhase}`,
              `Verification: ${run.verificationPhase}`,
              `Review: ${run.reviewPhase}`,
              `Agent: ${run.agentType ?? "unknown"}`,
              `Claims: ${run.claims.map((claim) => `${claim.kind}:${claim.resource}`).join(", ") || "none"}`,
              ...(run.verificationIssues.length
                ? [`Issues: ${run.verificationIssues.join(" ")}`]
                : []),
            ]
          : []),
        `Session: ${snapshot.sessionReference ?? snapshot.sessionName}`,
      ].join("\n");
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("task-result", {
    description: "Show the canonical final assistant result: /task-result <task-id>",
    handler: async (args, ctx) => {
      const taskId = args.trim();
      if (!taskId) {
        ctx.ui.notify("Usage: /task-result <task-id>", "warning");
        return;
      }
      const snapshot = await getTaskSnapshot(ctx.cwd, taskId);
      const result = await getFinalTaskResult(snapshot);
      ctx.ui.notify(result ?? `Task ${taskId} has no canonical result yet.`, result ? "info" : "warning");
    },
  });

  pi.registerCommand("task-steer", {
    description: "Send an atomic follow-up to a running task: /task-steer <id> <message>",
    handler: async (args, ctx) => {
      const [taskId, ...messageParts] = splitArgs(args);
      const message = messageParts.join(" ");
      if (!taskId || !message) {
        ctx.ui.notify("Usage: /task-steer <task-id> <message>", "warning");
        return;
      }
      const entry = readRegistry(resolvePiDirectory(ctx.cwd)).find(
        (candidate) => candidate.id === taskId,
      );
      if (!entry) {
        ctx.ui.notify(`Running task not found: ${taskId}`, "warning");
        return;
      }
      const result = steerRunningBackgroundTask(
        entry.handle?.resourceId ?? entry.paneId,
        message,
        entry.handle,
      );
      ctx.ui.notify(
        result.ok ? `Steered ${taskId}.` : `Could not steer ${taskId}: ${result.reason}`,
        result.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("task-stop", {
    description: "Stop one owned task and release its lease: /task-stop <task-id>",
    handler: async (args, ctx) => {
      const taskId = args.trim();
      if (!taskId) {
        ctx.ui.notify("Usage: /task-stop <task-id>", "warning");
        return;
      }
      await stopOwnedTask(ctx.cwd, taskId, "Stopped by user command");
      pi.events.emit("pi-subagents:task-stopped", {
        protocolVersion: 1,
        taskId,
        timestamp: new Date().toISOString(),
      });
      ctx.ui.notify(`Stopped task ${taskId}.`, "info");
    },
  });

  pi.registerCommand("task-schedules", {
    description: "List durable scheduled delegated tasks",
    handler: async (_args, ctx) => {
      const paths = getOrchestrationPaths(ctx.cwd);
      const schedules = await new TaskScheduler(paths.scheduleStore).list();
      ctx.ui.notify(
        schedules.length
          ? schedules
              .map(
                (schedule) =>
                  `${schedule.enabled ? "●" : "○"} ${schedule.id} · ${schedule.name} · next ${schedule.nextRunAt ?? "none"} · runs ${schedule.runs}`,
              )
              .join("\n")
          : "No task schedules found.",
        "info",
      );
    },
  });

  pi.registerCommand("task-unschedule", {
    description: "Disable a durable schedule: /task-unschedule <schedule-id>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /task-unschedule <schedule-id>", "warning");
        return;
      }
      const paths = getOrchestrationPaths(ctx.cwd);
      const cancelled = await new TaskScheduler(paths.scheduleStore).cancel(id);
      ctx.ui.notify(
        cancelled ? `Disabled schedule ${id}.` : `Active schedule not found: ${id}`,
        cancelled ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("task-doctor", {
    description: "Validate task runtime state, leases, contexts, and recovery",
    handler: async (_args, ctx) => {
      const result = await runOrchestrationDoctor({ projectDirectory: ctx.cwd });
      ctx.ui.notify(
        result.ok
          ? "Task doctor: healthy."
          : result.issues
              .map((issue) => `[${issue.severity}] ${issue.code}: ${issue.message}`)
              .join("\n"),
        result.ok ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("task-metrics", {
    description: "Show local aggregate task metrics",
    handler: async (_args, ctx) => {
      const paths = getOrchestrationPaths(ctx.cwd);
      const metrics = deriveOrchestrationMetrics({
        events: await readOrchestrationEvents(paths.eventLog),
      });
      ctx.ui.notify(
        [
          `Started: ${metrics.tasksStarted}`,
          `Completed: ${metrics.tasksCompleted}`,
          `Failed: ${metrics.tasksFailed}`,
          `Stale: ${metrics.staleTasks}`,
          `Tokens: ${metrics.totalTokens}`,
          `Cost: ${metrics.totalCost}`,
          `Success rate: ${metrics.taskSuccessRate ?? "n/a"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}

function resolvePiDirectory(cwd: string): string {
  return findPiDir(cwd) ?? `${cwd.replace(/[\\/]$/u, "")}/.pi`;
}

function splitArgs(value: string): string[] {
  return value.match(/(?:[^\s"]+|"[^"]*")+/gu)?.map((part) => part.replace(/^"|"$/gu, "")) ?? [];
}

function statusGlyph(phase: string): string {
  if (phase === "completed") return "✓";
  if (phase === "failed" || phase === "timeout") return "✗";
  if (phase === "blocked") return "!";
  if (phase === "cancelled") return "⊘";
  return "●";
}

function formatAge(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.max(0, Math.round(milliseconds / 1000))}s`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)}m`;
  return `${Math.round(milliseconds / 3_600_000)}h`;
}
