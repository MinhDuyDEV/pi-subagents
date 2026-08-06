import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { HerdrTerminalHandle } from "../types.js";
import { HerdrClient } from "./herdrClient.js";
import {
  createDefaultCommandRunner,
  type CommandRunner,
  type CommandResult,
  type TerminalBackend,
  type TerminalLaunchInput,
} from "./terminalBackend.js";

interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  agent?: string;
  tab_id?: string;
}

interface HerdrWorkspace {
  workspace_id: string;
  root_pane_id: string;
}

interface HerdrResponse<T> {
  result?: T;
}

interface HerdrAgentInfo {
  terminal_id: string;
  pane_id: string;
  name?: string;
  agent?: string;
  agent_status: string;
  state_change_seq: number;
  foreground_process_group_id?: number;
}

type HerdrRun = (args: readonly string[]) => Promise<CommandResult>;

class HerdrIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrIdentityError";
  }
}

let launchQueue: Promise<void> = Promise.resolve();
type HerdrGroupMode = "dedicated" | "attached";

interface HerdrWorkspaceGroup {
  mode: HerdrGroupMode;
  workspaceId?: string;
  paneIds: Set<string>;
  restored?: boolean;
}

const groupedWorkspaces = new Map<string, HerdrWorkspaceGroup>();

function workspaceGroupKey(
  socketPath: string,
  parentPaneId: string | undefined,
  group: string,
  mode: HerdrGroupMode,
): string {
  return `${socketPath}\u0000${parentPaneId ?? "unknown-parent"}\u0000${group}\u0000${mode}`;
}

function nextGridSplit(
  paneIds: readonly string[],
  mode: HerdrGroupMode,
): { targetPane: string; direction: "right" | "down" } {
  const depths = new Map<string, number>();
  for (const paneId of paneIds) {
    if (depths.size === 0) {
      depths.set(paneId, 0);
      continue;
    }
    const target = [...depths].reduce((best, entry) =>
      entry[1] <= best[1] ? entry : best,
    );
    depths.set(target[0], target[1] + 1);
    depths.set(paneId, target[1] + 1);
  }
  const target = [...depths].reduce((best, entry) =>
    entry[1] <= best[1] ? entry : best,
  );
  const direction = mode === "attached"
    ? (target[1] % 2 === 0 ? "down" : "right")
    : (target[1] % 2 === 0 ? "right" : "down");
  return { targetPane: target[0], direction };
}

async function serializeLaunch<T>(operation: () => Promise<T>): Promise<T> {
  const previous = launchQueue;
  let release!: () => void;
  launchQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function decode<T>(stdout: string, operation: string): T {
  try {
    const parsed = JSON.parse(stdout) as T | HerdrResponse<T>;
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      return (parsed as HerdrResponse<T>).result as T;
    }
    return parsed as T;
  } catch (error) {
    throw new Error(
      `HerdR ${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function paneFrom(value: unknown): HerdrPane {
  const candidate = value as {
    pane?: Partial<HerdrPane>;
    agent?: Partial<HerdrPane>;
  };
  const pane = candidate.pane ?? candidate.agent;
  if (
    typeof pane?.pane_id !== "string" ||
    typeof pane.terminal_id !== "string"
  ) {
    throw new Error("HerdR response did not include pane_id and terminal_id");
  }
  return pane as HerdrPane;
}

function paneHostsPi(value: unknown): boolean {
  const candidate = value as { pane?: { agent?: unknown } };
  return candidate.pane?.agent === "pi";
}

function workspaceFrom(value: unknown): HerdrWorkspace {
  const candidate = value as {
    workspace?: { workspace_id?: unknown };
    root_pane?: { pane_id?: unknown };
  };
  if (
    typeof candidate.workspace?.workspace_id !== "string" ||
    typeof candidate.root_pane?.pane_id !== "string"
  ) {
    throw new Error(
      "HerdR response did not include workspace_id and root pane_id",
    );
  }
  return {
    workspace_id: candidate.workspace.workspace_id,
    root_pane_id: candidate.root_pane.pane_id,
  };
}

function isMissingWorkspace(error: unknown): boolean {
  return /workspace_not_found|workspace not found/i.test(String(error));
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const output = error as Error & { stdout?: unknown; stderr?: unknown };
  return [error.message, output.stdout, output.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function herdrError(
  error: unknown,
): { code: string; message?: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const output = error as Error & { stdout?: unknown; stderr?: unknown };
  for (const value of [output.stderr, output.stdout]) {
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof parsed.error?.code === "string") {
        return {
          code: parsed.error.code,
          ...(typeof parsed.error.message === "string"
            ? { message: parsed.error.message }
            : {}),
        };
      }
    } catch {
      // Non-JSON command diagnostics are never eligible for prompt retry.
    }
  }
  return undefined;
}

function stalledPromptBaseline(error: unknown): number | undefined {
  const details = herdrError(error);
  if (details?.code !== "agent_prompt_stalled" || !details.message) return undefined;
  const match = /state_change_seq remained (\d+)\s*$/u.exec(details.message);
  if (!match) return undefined;
  const baseline = Number(match[1]);
  return Number.isSafeInteger(baseline) ? baseline : undefined;
}

function agentFrom(value: unknown): HerdrAgentInfo {
  const agent = (value as { agent?: Partial<HerdrAgentInfo> }).agent;
  if (
    typeof agent?.terminal_id !== "string" ||
    typeof agent.pane_id !== "string" ||
    typeof agent.agent_status !== "string" ||
    typeof agent.state_change_seq !== "number"
  ) {
    throw new Error("HerdR response did not include a complete agent identity");
  }
  return agent as HerdrAgentInfo;
}

function processInfoFrom(value: unknown): {
  pane_id: string;
  foreground_process_group_id: number;
} {
  const processInfo = (value as {
    process_info?: {
      pane_id?: unknown;
      foreground_process_group_id?: unknown;
    };
  }).process_info;
  if (
    typeof processInfo?.pane_id !== "string" ||
    typeof processInfo.foreground_process_group_id !== "number"
  ) {
    throw new Error(
      "HerdR response did not include pane_id and foreground process group id",
    );
  }
  return {
    pane_id: processInfo.pane_id,
    foreground_process_group_id: processInfo.foreground_process_group_id,
  };
}

function sameAgentIdentity(
  expected: HerdrAgentInfo,
  current: HerdrAgentInfo,
): boolean {
  return (
    expected.pane_id === current.pane_id &&
    expected.terminal_id === current.terminal_id &&
    (expected.name === undefined || expected.name === current.name) &&
    (expected.agent === undefined || expected.agent === current.agent) &&
    expected.foreground_process_group_id !== undefined &&
    expected.foreground_process_group_id === current.foreground_process_group_id
  );
}

function assertSameAgentIdentity(
  expected: HerdrAgentInfo,
  current: HerdrAgentInfo,
): void {
  if (!sameAgentIdentity(expected, current)) {
    throw new HerdrIdentityError(
      `HerdR agent identity changed for ${expected.pane_id}`,
    );
  }
}

function isSettledPromptState(status: string): boolean {
  return ["idle", "working", "blocked", "done"].includes(status);
}

async function readAgent(
  run: HerdrRun,
  paneId: string,
): Promise<HerdrAgentInfo> {
  const readProcess = async () =>
    processInfoFrom(
      decode(
        (await run(["pane", "process-info", "--pane", paneId])).stdout,
        "pane process-info",
      ),
    );
  const processBefore = await readProcess();
  const agent = agentFrom(
    decode((await run(["agent", "get", paneId])).stdout, "agent get"),
  );
  const processAfter = await readProcess();
  if (
    processBefore.pane_id !== agent.pane_id ||
    processAfter.pane_id !== agent.pane_id ||
    processBefore.foreground_process_group_id !==
      processAfter.foreground_process_group_id
  ) {
    throw new HerdrIdentityError(
      `HerdR process identity changed for ${agent.pane_id}`,
    );
  }
  return {
    ...agent,
    foreground_process_group_id: processAfter.foreground_process_group_id,
  };
}

async function waitForRetryTransition(
  run: HerdrRun,
  expected: HerdrAgentInfo,
  baseline: number,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let current: HerdrAgentInfo;
    try {
      current = await readAgent(run, expected.pane_id);
    } catch (error) {
      throw new HerdrIdentityError(
        `HerdR could not verify retry identity: ${errorText(error)}`,
      );
    }
    assertSameAgentIdentity(expected, current);
    if (
      current.state_change_seq > baseline &&
      isSettledPromptState(current.agent_status)
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `HerdR retry produced no confirmed lifecycle transition for ${expected.pane_id}`,
      );
    }
    await sleep(pollMs, signal);
  }
}

async function verifyPromptTimeout(
  run: HerdrRun,
  promptIdentity: HerdrAgentInfo,
): Promise<void> {
  let current: HerdrAgentInfo;
  try {
    current = await readAgent(run, promptIdentity.pane_id);
  } catch (error) {
    throw new HerdrIdentityError(
      `HerdR could not verify prompt timeout identity: ${errorText(error)}`,
    );
  }
  assertSameAgentIdentity(promptIdentity, current);
  if (current.state_change_seq <= promptIdentity.state_change_seq) {
    throw new Error(
      `HerdR prompt timeout did not prove activity for ${promptIdentity.pane_id}`,
    );
  }
}

async function retryStalledPrompt(
  run: HerdrRun,
  promptIdentity: HerdrAgentInfo,
  error: unknown,
  timeoutMs: number,
  pollMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const stalledBaseline = stalledPromptBaseline(error);
  if (stalledBaseline === undefined) {
    throw new HerdrIdentityError(
      "HerdR stalled prompt did not include HerdR's state sequence baseline",
    );
  }
  let beforeRetry: HerdrAgentInfo;
  try {
    beforeRetry = await readAgent(run, promptIdentity.pane_id);
  } catch (readError) {
    throw new HerdrIdentityError(
      `HerdR could not verify retry identity: ${errorText(readError)}`,
    );
  }
  assertSameAgentIdentity(promptIdentity, beforeRetry);
  if (beforeRetry.state_change_seq < stalledBaseline) {
    throw new HerdrIdentityError(
      `HerdR retry state sequence regressed for ${promptIdentity.pane_id}`,
    );
  }
  if (beforeRetry.state_change_seq > stalledBaseline) {
    await waitForRetryTransition(
      run,
      beforeRetry,
      stalledBaseline,
      timeoutMs,
      pollMs,
      signal,
    );
    return;
  }
  if (!beforeRetry.name) {
    throw new HerdrIdentityError(
      `HerdR cannot safely retry an unnamed agent in ${promptIdentity.pane_id}`,
    );
  }
  try {
    await run(["agent", "send-keys", beforeRetry.name, "enter"]);
  } catch (sendError) {
    throw new HerdrIdentityError(
      `HerdR could not verify retry submission: ${errorText(sendError)}`,
    );
  }
  await waitForRetryTransition(
    run,
    beforeRetry,
    beforeRetry.state_change_seq,
    timeoutMs,
    pollMs,
    signal,
  );
}

async function readStartedAgent(
  run: HerdrRun,
  created: HerdrPane,
): Promise<HerdrAgentInfo> {
  const identity = await readAgent(run, created.pane_id);
  if (
    identity.terminal_id !== created.terminal_id ||
    (identity.agent !== undefined && identity.agent !== "pi")
  ) {
    throw new HerdrIdentityError(
      `HerdR agent identity did not match started pane ${created.pane_id}`,
    );
  }
  return identity;
}

async function submitInitialPrompt(
  run: HerdrRun,
  created: HerdrPane,
  identity: HerdrAgentInfo,
  prompt: string,
  promptTimeoutMs: number,
  retryTimeoutMs: number,
  retryPollMs: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await run([
      "agent",
      "prompt",
      created.pane_id,
      prompt,
      "--wait",
      "--until",
      "working",
      "--until",
      "blocked",
      "--until",
      "done",
      "--timeout",
      String(promptTimeoutMs),
    ]);
  } catch (error) {
    const code = herdrError(error)?.code;
    if (code === "timeout") {
      await verifyPromptTimeout(run, identity);
      return;
    }
    if (code === "agent_prompt_stalled") {
      await retryStalledPrompt(
        run,
        identity,
        error,
        retryTimeoutMs,
        retryPollMs,
        signal,
      );
      return;
    }
    throw error;
  }
}

async function closeCreatedResource(
  run: HerdrRun,
  workspace: HerdrWorkspace | undefined,
  created: HerdrPane | undefined,
  expectedAgent: HerdrAgentInfo | undefined,
): Promise<void> {
  if (!expectedAgent) return;
  try {
    assertSameAgentIdentity(
      expectedAgent,
      await readAgent(run, expectedAgent.pane_id),
    );
    if (created) {
      const current = paneFrom(
        decode((await run(["pane", "get", created.pane_id])).stdout, "pane get"),
      );
      if (current.terminal_id !== created.terminal_id || current.agent !== "pi") {
        return;
      }
    }
  } catch {
    return;
  }
  if (workspace) {
    await run(["workspace", "close", workspace.workspace_id]).catch(
      () => undefined,
    );
  } else if (created) {
    await run(["pane", "close", created.pane_id]).catch(() => undefined);
  }
}

function isAgentPaneBusy(error: unknown): boolean {
  return /agent_pane_busy|not an available shell/i.test(errorText(error));
}

function isTransientLaunchError(error: unknown): boolean {
  return /failed to create herdr execution pane|agent_pane_busy|pane_busy|temporar|timed? out|connection reset|not an available shell/iu.test(
    errorText(error),
  );
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runWithRetry<T>(
  run: (args: readonly string[]) => Promise<T>,
  args: readonly string[],
  options: {
    label: string;
    backoffMs?: readonly number[];
    signal?: AbortSignal;
  },
): Promise<T> {
  // Retry a HerdR command on transient failure (e.g. `Failed to create herdr
  // execution pane` under concurrent pane splits). Backoff is short and bounded.
  // `PI_SUBAGENTS_PANE_RETRIES` overrides the retry count (default 3; 0 disables).
  const maxRetries = Math.max(0, Number(process.env.PI_SUBAGENTS_PANE_RETRIES ?? 3));
  const backoff = options.backoffMs ?? [200, 500, 1000];
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attempts += 1;
    try {
      return await run(args);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isTransientLaunchError(error)) break;
      const delay =
        backoff[Math.min(attempt, backoff.length - 1)] ?? backoff[backoff.length - 1];
      await sleep(delay, options.signal);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `HerdR ${options.label} failed after ${attempts} attempt(s): ${message}`,
    { cause: lastError },
  );
}

function requireHerdrHandle(
  handle: Parameters<TerminalBackend["isAlive"]>[0],
): HerdrTerminalHandle {
  if (handle.backend !== "herdr")
    throw new Error("HerdR backend cannot control a non-HerdR handle");
  return handle;
}

export function restoreHerdrWorkspaceGroups(
  handles: readonly HerdrTerminalHandle[],
): void {
  for (const handle of handles) {
    if (!handle.workspaceGroup) continue;
    const mode: HerdrGroupMode = handle.herdrLayout === "attached" ? "attached" : "dedicated";
    if (mode === "dedicated" && !handle.workspaceId) continue;
    const key = workspaceGroupKey(
      handle.socketPath,
      handle.parentPaneId,
      handle.workspaceGroup,
      mode,
    );
    const group = groupedWorkspaces.get(key) ?? {
      mode,
      workspaceId: handle.workspaceId,
      paneIds: new Set<string>(),
      restored: true,
    };
    if (group.workspaceId !== handle.workspaceId) continue;
    group.paneIds.add(handle.resourceId);
    groupedWorkspaces.set(key, group);
  }
}

export interface HerdrTerminalBackendOptions {
  run?: CommandRunner["run"];
  env?: NodeJS.ProcessEnv;
  promptTimeoutMs?: number;
  retryTimeoutMs?: number;
  retryPollMs?: number;
}

export function createHerdrTerminalBackend(
  options: HerdrTerminalBackendOptions = {},
): TerminalBackend {
  const env = options.env ?? process.env;
  const runner = options.run ?? createDefaultCommandRunner().run;
  const socketPath = env.HERDR_SOCKET_PATH;
  const promptTimeoutMs = options.promptTimeoutMs ?? 8_000;
  const retryTimeoutMs = options.retryTimeoutMs ?? promptTimeoutMs;
  const retryPollMs = options.retryPollMs ?? 100;
  const commandEnv = { ...env, HERDR_SOCKET_PATH: socketPath };
  const run = (
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) =>
    runner("herdr", args, {
      env: commandEnv,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
  const client = new HerdrClient({ runner, env: commandEnv });

  const verifyOwnership = async (
    rawHandle: Parameters<TerminalBackend["isAlive"]>[0],
  ): Promise<HerdrTerminalHandle> => {
    const handle = requireHerdrHandle(rawHandle);
    if (!socketPath || handle.socketPath !== socketPath) {
      throw new Error("HerdR ownership mismatch: session socket changed");
    }
    const response = await run(["pane", "get", handle.resourceId]);
    const current = paneFrom(decode(response.stdout, "pane get"));
    if (current.terminal_id !== handle.terminalId) {
      throw new Error("HerdR ownership mismatch: terminal changed");
    }
    return handle;
  };

  return {
    kind: "herdr",

    async available() {
      if (
        env.HERDR_ENV !== "1" ||
        !env.HERDR_PANE_ID ||
        !socketPath ||
        !isAbsolute(socketPath)
      )
        return false;
      try {
        await run(["status", "server"]);
        await run(["pane", "current", "--current"]);
        return true;
      } catch (error) {
        const message = errorText(error);
        if (/ENOENT|command not found|not found on PATH/iu.test(message)) return false;
        const unavailable = new Error(`HerdR control unavailable: ${message}`);
        unavailable.name = "HerdrUnavailableError";
        throw unavailable;
      }
    },

    async launch(input: TerminalLaunchInput) {
      return serializeLaunch(async () => {
        if (
          env.HERDR_ENV !== "1" ||
          !env.HERDR_PANE_ID ||
          !socketPath ||
          !isAbsolute(socketPath)
        ) {
          throw new Error(
            "HerdR backend requires Pi to run inside an active HerdR pane",
          );
        }
        const launchRun = (args: readonly string[]) =>
          run(args, { signal: input.signal, timeoutMs: input.timeoutMs });
        if (input.herdrLayout === "attached" && !input.workspaceGroup) {
          throw new Error("HerdR attached layout requires workspace_group");
        }
        const groupMode: HerdrGroupMode = input.herdrLayout === "attached"
          ? "attached"
          : "dedicated";
        const groupKey = input.workspaceGroup
          ? workspaceGroupKey(
              socketPath,
              env.HERDR_PANE_ID,
              input.workspaceGroup,
              groupMode,
            )
          : undefined;
        let existingGroup = groupKey
          ? groupedWorkspaces.get(groupKey)
          : undefined;
        if (existingGroup?.restored) {
          for (const paneId of [...existingGroup.paneIds]) {
            try {
              await launchRun(["pane", "get", paneId]);
            } catch (error) {
              if (!/not[_ -]?found|no such pane/iu.test(errorText(error))) throw error;
              existingGroup.paneIds.delete(paneId);
            }
          }
          if (existingGroup.paneIds.size === 0) {
            if (existingGroup.mode === "dedicated" && existingGroup.workspaceId) {
              await run(["workspace", "close", existingGroup.workspaceId]).catch(
                () => undefined,
              );
            }
            if (groupKey) groupedWorkspaces.delete(groupKey);
            existingGroup = undefined;
          } else {
            existingGroup.restored = false;
          }
        }
        const terminalEnvArgs = Object.entries(input.env ?? {}).flatMap(
          ([name, value]) => ["--env", `${name}=${value}`],
        );
        const workspaceResponse =
          groupKey && !existingGroup && groupMode === "dedicated"
            ? await runWithRetry(
                launchRun,
                [
                  "workspace",
                  "create",
                  "--cwd",
                  input.cwd,
                  ...terminalEnvArgs,
                  "--label",
                  input.workspaceGroup!,
                  "--no-focus",
                ],
                { label: "workspace create", signal: input.signal },
              )
            : undefined;
        const workspace = workspaceResponse
          ? workspaceFrom(decode(workspaceResponse.stdout, "workspace create"))
          : undefined;
        let created: HerdrPane | undefined;
        let expectedAgent: HerdrAgentInfo | undefined;
        try {
          if (workspace) {
            const response = await runWithRetry(
              launchRun,
              ["pane", "get", workspace.root_pane_id],
              { label: "pane get", signal: input.signal },
            );
            created = paneFrom(decode(response.stdout, "pane get"));
          } else {
            const panes = existingGroup ? [...existingGroup.paneIds] : [];
            const gridSplit = panes.length > 0
              ? nextGridSplit(panes, groupMode)
              : undefined;
            const targetPane = gridSplit?.targetPane
              ?? (groupMode === "attached" ? env.HERDR_PANE_ID : undefined);
            if (groupMode === "attached" && !targetPane) {
              throw new Error("HerdR attached layout requires a parent pane");
            }
            const response = await runWithRetry(
              launchRun,
              [
                "pane",
                "split",
                ...(targetPane ? [targetPane] : ["--current"]),
                "--direction",
                groupKey
                  ? (gridSplit?.direction ?? "right")
                  : (input.direction ?? "right"),
                ...(groupKey ? ["--ratio", "0.5"] : []),
                "--cwd",
                input.cwd,
                ...terminalEnvArgs,
                "--no-focus",
              ],
              { label: "pane split", signal: input.signal },
            );
            created = paneFrom(decode(response.stdout, "pane split"));
          }
          const startArgs = [
            "agent",
            "start",
            input.label ?? "pi-task",
            "--kind",
            "pi",
            "--pane",
            created.pane_id,
            "--",
            ...(input.agentArgs ?? []),
          ];
          const deadline = Date.now() + 3_000;
          while (true) {
            try {
              const response = await launchRun(startArgs);
              created = paneFrom(decode(response.stdout, "agent start"));
              break;
            } catch (error) {
              if (!isAgentPaneBusy(error) || Date.now() >= deadline) throw error;
              await sleep(50, input.signal);
            }
          }
          if (input.initialPrompt !== undefined) {
            expectedAgent = await readStartedAgent(launchRun, created);
            await submitInitialPrompt(
              launchRun,
              created,
              expectedAgent,
              input.initialPrompt,
              promptTimeoutMs,
              retryTimeoutMs,
              retryPollMs,
              input.signal,
            );
          }
          if (groupKey) {
            const group = existingGroup ?? {
              mode: groupMode,
              workspaceId: workspace?.workspace_id,
              paneIds: new Set<string>(),
            };
            group.paneIds.add(created.pane_id);
            groupedWorkspaces.set(groupKey, group);
          }
          try {
            await client.reportTaskMetadata({
              paneId: created.pane_id,
              sequence: Date.now(),
              taskId: input.label ?? "pi-task",
              phase: "working",
              parentPaneId: env.HERDR_PANE_ID,
              ttlMs: 60 * 60_000,
              signal: input.signal,
            });
          } catch (error) {
            if (input.signal?.aborted) throw error;
            // Metadata is observability-only after the owned Pi agent is live.
          }
          return {
            backend: "herdr" as const,
            resourceId: created.pane_id,
            socketPath,
            terminalId: created.terminal_id,
            parentPaneId: env.HERDR_PANE_ID,
            agentName: input.label ?? "pi-task",
            ...(created.tab_id ? { tabId: created.tab_id } : {}),
            ...((workspace?.workspace_id ?? existingGroup?.workspaceId)
              ? { workspaceId: workspace?.workspace_id ?? existingGroup?.workspaceId }
              : {}),
            ...(input.workspaceGroup
              ? { workspaceGroup: input.workspaceGroup }
              : {}),
            ...(input.herdrLayout ? { herdrLayout: input.herdrLayout } : {}),
          };
        } catch (error) {
          if (!(error instanceof HerdrIdentityError)) {
            await closeCreatedResource(
              launchRun,
              workspace,
              created,
              expectedAgent,
            );
          }
          throw error;
        }
      });
    },

    async isAlive(handle) {
      try {
        const owned = requireHerdrHandle(handle);
        if (!socketPath || owned.socketPath !== socketPath) return false;
        const response = await run(["pane", "get", owned.resourceId]);
        const payload = decode(response.stdout, "pane get");
        if (paneFrom(payload).terminal_id !== owned.terminalId) return false;
        return paneHostsPi(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ownership mismatch|not[_ -]?found/i.test(message)) return false;
        const unavailable = new Error(`HerdR control unavailable: ${message}`);
        unavailable.name = "HerdrUnavailableError";
        throw unavailable;
      }
    },

    async send(handle, message) {
      const owned = await verifyOwnership(handle);
      await client.prompt(owned.resourceId, message);
    },

    async waitForAttention(handle, options = {}) {
      const owned = await verifyOwnership(handle);
      const agent = await client.wait(owned.resourceId, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 30 * 60_000,
      });
      return { status: agent.agent_status };
    },

    async readTail(handle, lines) {
      const owned = await verifyOwnership(handle);
      const response = await run([
        "pane",
        "read",
        owned.resourceId,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(Math.max(1, Math.floor(lines))),
      ]);
      try {
        const result = decode<{ text?: string; output?: string }>(
          response.stdout,
          "pane read",
        );
        return result.text ?? result.output ?? response.stdout;
      } catch {
        return response.stdout;
      }
    },

    async close(handle) {
      return serializeLaunch(async () => {
        if (handle.backend === "herdr" && handle.workspaceGroup) {
          const mode: HerdrGroupMode = handle.herdrLayout === "attached" ? "attached" : "dedicated";
          const key = workspaceGroupKey(
            handle.socketPath,
            handle.parentPaneId,
            handle.workspaceGroup,
            mode,
          );
          const group = groupedWorkspaces.get(key);
          if (!group || group.workspaceId !== handle.workspaceId) {
            await run(["pane", "close", handle.resourceId]);
            return;
          }
          if (!group.paneIds.delete(handle.resourceId)) {
            const owned = await verifyOwnership(handle);
            await run(["pane", "close", owned.resourceId]);
            return;
          }
          if (group.paneIds.size > 0) {
            await run(["pane", "close", handle.resourceId]);
            return;
          }
          groupedWorkspaces.delete(key);
          if (mode === "attached") {
            await run(["pane", "close", handle.resourceId]);
          } else if (handle.workspaceId) {
            await run(["workspace", "close", handle.workspaceId]);
          }
          return;
        }
        if (handle.backend === "herdr" && handle.workspaceId) {
          await run(["workspace", "close", handle.workspaceId]);
          return;
        }

        const owned = await verifyOwnership(handle);
        await run(["pane", "close", owned.resourceId]);
      });
    },
  };
}

export function createDefaultHerdrTerminalBackend(
  env: NodeJS.ProcessEnv = process.env,
): TerminalBackend {
  return createHerdrTerminalBackend({ env });
}

function syncRun(args: readonly string[], socketPath: string): string {
  return execFileSync("herdr", args, {
    encoding: "utf8",
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function createSyncHerdrControl(
  env: NodeJS.ProcessEnv = process.env,
  run: (args: readonly string[], socketPath: string) => string = syncRun,
) {
  return {
    exists(handle: HerdrTerminalHandle): boolean {
      if (!env.HERDR_SOCKET_PATH || env.HERDR_SOCKET_PATH !== handle.socketPath)
        return false;
      try {
        return (
          paneFrom(
            decode(
              run(["pane", "get", handle.resourceId], handle.socketPath),
              "pane get",
            ),
          ).terminal_id === handle.terminalId
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not[_ -]?found/i.test(message)) return false;
        const unavailable = new Error(`HerdR control unavailable: ${message}`);
        unavailable.name = "HerdrUnavailableError";
        throw unavailable;
      }
    },
    send(handle: HerdrTerminalHandle, message: string): void {
      if (!this.exists(handle)) throw new Error("HerdR ownership mismatch");
      run(["agent", "prompt", handle.resourceId, message], handle.socketPath);
    },
    notify(
      title: string,
      body: string,
      sound: "none" | "done" | "request" = "none",
    ): void {
      if (!env.HERDR_SOCKET_PATH) return;
      run(
        ["notification", "show", title, "--body", body, "--sound", sound],
        env.HERDR_SOCKET_PATH,
      );
    },
    close(handle: HerdrTerminalHandle): void {
      if (handle.backend === "herdr" && handle.workspaceGroup) {
        const mode: HerdrGroupMode = handle.herdrLayout === "attached" ? "attached" : "dedicated";
        const key = workspaceGroupKey(
          handle.socketPath,
          handle.parentPaneId,
          handle.workspaceGroup,
          mode,
        );
        const group = groupedWorkspaces.get(key);
        if (!group || group.workspaceId !== handle.workspaceId) {
          run(["pane", "close", handle.resourceId], handle.socketPath);
          return;
        }
        if (!group.paneIds.delete(handle.resourceId)) {
          if (!this.exists(handle)) throw new Error("HerdR ownership mismatch");
          run(["pane", "close", handle.resourceId], handle.socketPath);
          return;
        }
        if (group.paneIds.size > 0) {
          run(["pane", "close", handle.resourceId], handle.socketPath);
          return;
        }
        groupedWorkspaces.delete(key);
        if (mode === "attached") {
          run(["pane", "close", handle.resourceId], handle.socketPath);
        } else if (handle.workspaceId) {
          try {
            run(["workspace", "close", handle.workspaceId], handle.socketPath);
          } catch (error) {
            if (!isMissingWorkspace(error)) throw error;
          }
        }
        return;
      }
      if (handle.backend === "herdr" && handle.workspaceId) {
        try {
          run(["workspace", "close", handle.workspaceId], handle.socketPath);
        } catch (error) {
          if (!isMissingWorkspace(error)) throw error;
        }
        return;
      }
      if (!this.exists(handle)) throw new Error("HerdR ownership mismatch");
      run(["pane", "close", handle.resourceId], handle.socketPath);
    },
  };
}
