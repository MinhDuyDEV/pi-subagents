import type { TaskReportedStatus, ToolCallRecord } from "./helpers.js";
import type { TerminalHandle, TerminalBackendKind } from "./subagent/terminalBackend.js";
import type { WorktreeHandle, WorktreeResult } from "./worktree.js";
export type { TerminalHandle, HerdrTerminalHandle } from "./subagent/terminalBackend.js";

export type ExecutionBackend = "sdk" | TerminalBackendKind;

export interface BackgroundTask {
  dir: string;
  agentType: string;
  sessionName: string;
  /** Legacy tmux field retained while old in-memory callers are migrated. */
  paneId?: string;
  handle?: TerminalHandle;
  exitSentinelPath?: string;
  backend?: ExecutionBackend;
  originalPane: string | null;
  description: string;
  startedAt: number;
  toolUses: number;
  turns: number;
  conversationId?: string;
  worktree?: WorktreeHandle;
  worktreeResult?: WorktreeResult;
  /** Most recent tool calls (capped), updated every COUNT_POLL_MS. */
  recentCalls: ToolCallRecord[];
  /** Consecutive completion-poll failures; reset to 0 on a successful poll. */
  pollErrors?: number;
  status?: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  phase?: string;
  result?: string;
  completedAt?: number;
}

/** Serializable subset for active task registry persistence. */
export interface RegistryEntry {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  startedAt: number;
  handle?: TerminalHandle;
  /** Legacy persisted field accepted by migration only. */
  paneId?: string;
  backend?: TerminalBackendKind;
  piDir: string;
  dir: string;
  conversationId?: string;
  sessionRef?: string;
  worktree?: WorktreeHandle;
  worktreeResult?: WorktreeResult;
}

/** Durable task→session mapping used for resume after task completion. */
export interface TaskSessionHistoryEntry extends RegistryEntry {
  status: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  reportedStatus?: TaskReportedStatus;
  resultValid?: boolean;
  completedAt?: number;
  background: boolean;
}
