import type { CommandRunner, CommandResult } from "./terminalBackend.js";

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrPaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id?: string;
  tab_id?: string;
  agent?: string;
  agent_status?: HerdrAgentStatus;
  cwd?: string;
  foreground_cwd?: string;
}

export interface HerdrAgentInfo extends HerdrPaneInfo {
  name?: string;
  display_agent?: string;
  agent_status: HerdrAgentStatus;
}

export interface HerdrWorkspaceInfo {
  workspace_id: string;
  label?: string;
  root_pane_id?: string;
}

interface HerdrEnvelope<T> {
  result?: T;
  error?: { code?: string; message?: string; details?: unknown };
  protocol_version?: string | number;
  version?: string;
}

export class HerdrCommandError extends Error {
  readonly code?: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly transient: boolean;

  constructor(input: {
    message: string;
    code?: string;
    args: readonly string[];
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "HerdrCommandError";
    this.code = input.code;
    this.args = [...input.args];
    this.stdout = input.stdout ?? "";
    this.stderr = input.stderr ?? "";
    this.exitCode = input.exitCode;
    this.transient = isTransientHerdrCode(input.code, input.message);
  }
}

export interface HerdrClientOptions {
  runner: CommandRunner["run"];
  env: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
}

export class HerdrClient {
  private readonly runner: CommandRunner["run"];
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultTimeoutMs: number;

  constructor(options: HerdrClientOptions) {
    this.runner = options.runner;
    this.env = { ...options.env };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  }

  async command<T>(
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs?: number; allowEmpty?: boolean } = {},
  ): Promise<T> {
    let result: CommandResult;
    try {
      result = await this.runner("herdr", args, {
        env: this.env,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      });
    } catch (error) {
      throw commandError(args, error);
    }
    const output = result.stdout.trim();
    if (!output) {
      if (options.allowEmpty) return undefined as T;
      throw new HerdrCommandError({
        message: `HerdR ${args.join(" ")} returned no JSON`,
        args,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
    let envelope: HerdrEnvelope<T>;
    try {
      envelope = JSON.parse(output) as HerdrEnvelope<T>;
    } catch (error) {
      throw new HerdrCommandError({
        message: `HerdR ${args.join(" ")} returned invalid JSON`,
        code: "invalid_json",
        args,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        cause: error,
      });
    }
    if (envelope.error) {
      throw new HerdrCommandError({
        message:
          envelope.error.message ??
          envelope.error.code ??
          `HerdR ${args.join(" ")} failed`,
        code: envelope.error.code,
        args,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }
    if (!("result" in envelope)) {
      // Some mutation commands historically returned a raw success object. Keep
      // compatibility while requiring all failures to use the structured path.
      return envelope as T;
    }
    return envelope.result as T;
  }

  async probe(signal?: AbortSignal): Promise<{
    current: HerdrPaneInfo;
    protocolVersion?: string | number;
    version?: string;
    capabilities: string[];
  }> {
    const snapshot: Record<string, unknown> = await this.command<Record<string, unknown>>(
      ["api", "snapshot"],
      { signal, timeoutMs: 5_000 },
    ).catch(async (error: unknown) => {
      if (!(error instanceof HerdrCommandError) || !isUnsupported(error)) throw error;
      return {};
    });
    const current = await this.currentPane(signal);
    return {
      current,
      capabilities: Array.isArray(snapshot.capabilities)
        ? snapshot.capabilities.filter(
            (capability): capability is string => typeof capability === "string",
          )
        : ["agent.prompt", "agent.wait", "pane.report-metadata"],
      ...(typeof snapshot.protocol_version === "string" ||
      typeof snapshot.protocol_version === "number"
        ? { protocolVersion: snapshot.protocol_version }
        : {}),
      ...(typeof snapshot.version === "string" ? { version: snapshot.version } : {}),
    };
  }

  async currentPane(signal?: AbortSignal): Promise<HerdrPaneInfo> {
    const result = await this.command<{ pane: HerdrPaneInfo }>(
      ["pane", "current", "--current"],
      { signal },
    );
    return requirePane(result.pane, "pane current");
  }

  async getPane(target: string, signal?: AbortSignal): Promise<HerdrPaneInfo> {
    const result = await this.command<{ pane: HerdrPaneInfo }>(
      ["pane", "get", target],
      { signal },
    );
    return requirePane(result.pane, "pane get");
  }

  async getAgent(target: string, signal?: AbortSignal): Promise<HerdrAgentInfo> {
    const result = await this.command<{ agent: HerdrAgentInfo }>(
      ["agent", "get", target],
      { signal },
    );
    return requireAgent(result.agent, "agent get");
  }

  async prompt(target: string, text: string, signal?: AbortSignal): Promise<HerdrAgentInfo> {
    const result = await this.command<{ agent: HerdrAgentInfo }>(
      ["agent", "prompt", target, text],
      { signal },
    );
    return requireAgent(result.agent, "agent prompt");
  }

  async wait(
    target: string,
    options: {
      until?: readonly HerdrAgentStatus[];
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<HerdrAgentInfo> {
    const args = ["agent", "wait", target];
    for (const status of options.until ?? []) args.push("--until", status);
    if (options.timeoutMs !== undefined) {
      args.push("--timeout", String(options.timeoutMs));
    }
    const result = await this.command<{ agent: HerdrAgentInfo }>(args, {
      signal: options.signal,
      timeoutMs:
        options.timeoutMs === undefined ? 30 * 60_000 : options.timeoutMs + 1_000,
    });
    return requireAgent(result.agent, "agent wait");
  }

  async createWorktree(input: {
    cwd: string;
    branch: string;
    base?: string;
    label?: string;
    signal?: AbortSignal;
  }): Promise<{
    workspace: HerdrWorkspaceInfo;
    rootPane: HerdrPaneInfo;
    path?: string;
    branch?: string;
    baseSha?: string;
  }> {
    const args = [
      "worktree",
      "create",
      "--cwd",
      input.cwd,
      "--branch",
      input.branch,
      "--no-focus",
    ];
    if (input.base) args.push("--base", input.base);
    if (input.label) args.push("--label", input.label);
    const result = await this.command<{
      workspace: HerdrWorkspaceInfo;
      root_pane: HerdrPaneInfo;
      worktree?: { path?: string; branch?: string; base_sha?: string };
    }>(args, { signal: input.signal, timeoutMs: 30_000 });
    return {
      workspace: result.workspace,
      rootPane: requirePane(result.root_pane, "worktree create"),
      ...(result.worktree?.path ? { path: result.worktree.path } : {}),
      ...(result.worktree?.branch ? { branch: result.worktree.branch } : {}),
      ...(result.worktree?.base_sha ? { baseSha: result.worktree.base_sha } : {}),
    };
  }

  async reportTaskMetadata(input: {
    paneId: string;
    sequence: number;
    taskId: string;
    phase: string;
    agentType?: string;
    parentPaneId?: string;
    ttlMs?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const args = [
      "pane",
      "report-metadata",
      input.paneId,
      "--source",
      "pi-subagents",
      "--seq",
      String(input.sequence),
      "--token",
      `task_id=${input.taskId}`,
      "--token",
      `task_phase=${input.phase}`,
    ];
    if (input.agentType) args.push("--token", `task_agent=${input.agentType}`);
    if (input.parentPaneId) args.push("--token", `task_parent=${input.parentPaneId}`);
    if (input.ttlMs) args.push("--ttl-ms", String(input.ttlMs));
    await this.command(args, { signal: input.signal, allowEmpty: true });
  }

  async notify(input: {
    title: string;
    body?: string;
    sound?: "none" | "done" | "request";
    signal?: AbortSignal;
  }): Promise<void> {
    const args = ["notification", "show", input.title];
    if (input.body) args.push("--body", input.body);
    args.push("--sound", input.sound ?? "none");
    await this.command(args, { signal: input.signal, allowEmpty: true });
  }
}

export function isTransientHerdrCode(
  code: string | undefined,
  message: string,
): boolean {
  if (
    code &&
    [
      "server_unavailable",
      "connection_reset",
      "timeout",
      "agent_pane_busy",
      "pane_busy",
      "temporarily_unavailable",
    ].includes(code)
  ) {
    return true;
  }
  return /temporar|timed? out|connection reset|agent_pane_busy|pane busy/iu.test(
    message,
  );
}

function commandError(args: readonly string[], error: unknown): HerdrCommandError {
  if (error instanceof HerdrCommandError) return error;
  const details = error as Error & {
    stdout?: unknown;
    stderr?: unknown;
    exitCode?: unknown;
    code?: unknown;
  };
  const stdout = typeof details.stdout === "string" ? details.stdout : "";
  const stderr = typeof details.stderr === "string" ? details.stderr : "";
  const parsed = parseErrorEnvelope(stderr) ?? parseErrorEnvelope(stdout);
  return new HerdrCommandError({
    message:
      parsed?.message ??
      parsed?.code ??
      (error instanceof Error ? error.message : String(error)),
    code: parsed?.code,
    args,
    stdout,
    stderr,
    exitCode: typeof details.exitCode === "number" ? details.exitCode : undefined,
    cause: error,
  });
}

function parseErrorEnvelope(
  value: string,
): { code?: string; message?: string } | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as HerdrEnvelope<unknown>;
    return parsed.error;
  } catch {
    return undefined;
  }
}

function requirePane(value: HerdrPaneInfo | undefined, operation: string): HerdrPaneInfo {
  if (!value || typeof value.pane_id !== "string" || typeof value.terminal_id !== "string") {
    throw new Error(`HerdR ${operation} response did not include pane identity`);
  }
  return value;
}

function requireAgent(
  value: HerdrAgentInfo | undefined,
  operation: string,
): HerdrAgentInfo {
  const pane = requirePane(value, operation);
  if (!isAgentStatus(value?.agent_status)) {
    throw new Error(`HerdR ${operation} response did not include agent status`);
  }
  return { ...pane, ...value, agent_status: value.agent_status };
}

function isAgentStatus(value: unknown): value is HerdrAgentStatus {
  return ["idle", "working", "blocked", "done", "unknown"].includes(String(value));
}

function isUnsupported(error: HerdrCommandError): boolean {
  return (
    error.code === "unknown_command" ||
    error.code === "unsupported" ||
    /unknown command|unsupported/iu.test(error.message)
  );
}
