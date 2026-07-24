import { existsSync } from "node:fs";
import {
  readRegistry,
  upsertTaskSessionHistory,
  writeRegistry,
} from "../conversation.js";
import {
  getAgentTerminalStopReason,
  hasAgentFinished,
} from "../session-text.js";
import { killAgentPane, paneExists } from "../subagent/tmux.js";
import type { BackgroundTask, RegistryEntry } from "../types.js";
import {
  finalizeTaskWorktree,
  type WorktreeResult,
} from "../worktree.js";

export function restoreActiveBackgroundTasks(
  piDir: string,
  backgroundTasks: Map<string, BackgroundTask>,
  resourceExists?: (entry: RegistryEntry) => boolean,
  closeResource?: (entry: RegistryEntry) => void,
): void {
  const registry = readRegistry(piDir);
  const staleIds: string[] = [];

  for (const entry of registry) {
    if (!existsSync(entry.dir)) {
      staleIds.push(entry.id);
      continue;
    }

    const sessionFinished = hasAgentFinished(
      entry.dir,
      entry.sessionName,
      entry.startedAt,
    );
    const terminalStopReason = sessionFinished
      ? getAgentTerminalStopReason(entry.dir, entry.sessionName, entry.startedAt)
      : undefined;
    const terminalStatus =
      terminalStopReason === "error"
        ? "failed"
        : terminalStopReason === "aborted"
          ? "cancelled"
          : "done";
    const paneId = entry.handle?.resourceId ?? entry.paneId;
    let paneAlive: boolean;
    try {
      paneAlive = resourceExists
        ? resourceExists(entry)
        : entry.handle?.backend === "herdr"
          ? false
          : Boolean(paneId && paneExists(paneId));
    } catch {
      // A temporary backend outage must not destroy the durable task record.
      continue;
    }

    if (sessionFinished) {
      const worktreeResult = settleWorktree(entry);
      upsertTaskSessionHistory(piDir, {
        id: entry.id,
        status: terminalStatus,
        background: true,
        agentType: entry.agentType,
        description: entry.description,
        sessionName: entry.sessionName,
        startedAt: entry.startedAt,
        piDir: entry.piDir,
        dir: entry.dir,
                paneId: entry.paneId,
        worktree: entry.worktree,
        worktreeResult,
        completedAt: Date.now(),
      });
      if (entry.handle?.backend === "herdr" && entry.handle.workspaceId) {
        try {
          closeResource?.(entry);
        } catch {
          // A missing resource is still removed from durable state below.
        }
      } else if (paneAlive && paneId) {
        try {
          if (closeResource) closeResource(entry);
          else if (entry.handle?.backend !== "herdr") killAgentPane(paneId, null);
        } catch {
          // A missing resource is still removed from durable state below.
        }
      }

      staleIds.push(entry.id);
      continue;
    }

    if (!paneAlive) {
      const worktreeResult = settleWorktree(entry);
      if (entry.handle?.backend === "herdr" && entry.handle.workspaceId) {
        try {
          closeResource?.(entry);
        } catch {
          // A missing resource is still removed from durable state below.
        }
      }
      upsertTaskSessionHistory(piDir, {
        id: entry.id,
        status: "failed",
        background: true,
        agentType: entry.agentType,
        description: entry.description,
        sessionName: entry.sessionName,
        startedAt: entry.startedAt,
        piDir: entry.piDir,
        dir: entry.dir,
        paneId: entry.paneId,
        worktree: entry.worktree,
        worktreeResult,
        completedAt: Date.now(),
      });
      staleIds.push(entry.id);
      continue;
    }

    backgroundTasks.set(entry.id, {
      dir: entry.dir,
      agentType: entry.agentType,
      sessionName: entry.sessionName,
        paneId,
        handle: entry.handle,
        backend: entry.handle?.backend ?? "tmux",
        originalPane: null,
      description: entry.description,
      startedAt: entry.startedAt,
      toolUses: 0,
      turns: 0,
      conversationId: entry.conversationId,
      worktree: entry.worktree,
      worktreeResult: entry.worktreeResult,
      recentCalls: [],
    });
  }

  if (staleIds.length) {
    writeRegistry(
      piDir,
      registry.filter((entry) => !staleIds.includes(entry.id)),
    );
  }
}

function settleWorktree(entry: RegistryEntry): WorktreeResult | undefined {
  if (entry.worktreeResult) return entry.worktreeResult;
  if (!entry.worktree) return undefined;
  try {
    return finalizeTaskWorktree(entry.worktree);
  } catch {
    return {
      ...entry.worktree,
      changedPaths: [],
      diffDigest: "unavailable",
      retained: true,
    };
  }
}
