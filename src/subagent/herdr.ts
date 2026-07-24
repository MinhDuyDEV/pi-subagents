import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { HerdrTerminalHandle } from "../types.js";
import { HerdrClient } from "./herdrClient.js";
import {
  createDefaultCommandRunner,
  type CommandRunner,
  type TerminalBackend,
  type TerminalLaunchInput,
} from "./terminalBackend.js";

interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  tab_id?: string;
}

interface HerdrWorkspace {
  workspace_id: string;
  root_pane_id: string;
}

interface HerdrResponse<T> {
  result?: T;
}

let launchQueue: Promise<void> = Promise.resolve();
const groupedWorkspaces = new Map<
  string,
  { workspaceId: string; paneIds: Set<string>; restored?: boolean }
>();

function workspaceGroupKey(
  socketPath: string,
  parentPaneId: string | undefined,
  group: string,
): string {
  return `${socketPath}\u0000${parentPaneId ?? "unknown-parent"}\u0000${group}`;
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
    if (!handle.workspaceId || !handle.workspaceGroup) continue;
    const key = workspaceGroupKey(
      handle.socketPath,
      handle.parentPaneId,
      handle.workspaceGroup,
    );
    const group = groupedWorkspaces.get(key) ?? {
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
}

export function createHerdrTerminalBackend(
  options: HerdrTerminalBackendOptions = {},
): TerminalBackend {
  const env = options.env ?? process.env;
  const runner = options.run ?? createDefaultCommandRunner().run;
  const socketPath = env.HERDR_SOCKET_PATH;
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
        const groupKey = input.workspaceGroup
          ? workspaceGroupKey(socketPath, env.HERDR_PANE_ID, input.workspaceGroup)
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
            await run(["workspace", "close", existingGroup.workspaceId]).catch(
              () => undefined,
            );
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
          groupKey && !existingGroup
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
        try {
          if (workspace) {
            const response = await runWithRetry(
              launchRun,
              ["pane", "get", workspace.root_pane_id],
              { label: "pane get", signal: input.signal },
            );
            created = paneFrom(decode(response.stdout, "pane get"));
          } else {
            const targetPane = existingGroup
              ? existingGroup.paneIds.values().next().value
              : undefined;
            if (existingGroup && !targetPane) {
              throw new Error("HerdR workspace has no live task pane to split");
            }
            const response = await runWithRetry(
              launchRun,
              [
                "pane",
                "split",
                ...(targetPane ? [targetPane] : ["--current"]),
                "--direction",
                input.direction ?? (existingGroup ? "down" : "right"),
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
            await launchRun([
              "agent",
              "prompt",
              created.pane_id,
              input.initialPrompt,
            ]);
          }
          if (groupKey) {
            const group = existingGroup ?? {
              workspaceId: workspace!.workspace_id,
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
            ...(workspace || existingGroup
              ? { workspaceId: workspace?.workspace_id ?? existingGroup!.workspaceId }
              : {}),
            ...(input.workspaceGroup
              ? { workspaceGroup: input.workspaceGroup }
              : {}),
          };
        } catch (error) {
          if (workspace) {
            await run(["workspace", "close", workspace.workspace_id]).catch(
              () => undefined,
            );
          } else if (created) {
            await run(["pane", "close", created.pane_id]).catch(() => undefined);
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
        if (
          handle.backend === "herdr" &&
          handle.workspaceId &&
          handle.workspaceGroup
        ) {
          const key = workspaceGroupKey(
            handle.socketPath,
            handle.parentPaneId,
            handle.workspaceGroup,
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
          await run(["workspace", "close", handle.workspaceId]);
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
      if (
        handle.backend === "herdr" &&
        handle.workspaceId &&
        handle.workspaceGroup
      ) {
        const key = workspaceGroupKey(
          handle.socketPath,
          handle.parentPaneId,
          handle.workspaceGroup,
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
        try {
          run(["workspace", "close", handle.workspaceId], handle.socketPath);
        } catch (error) {
          if (!isMissingWorkspace(error)) throw error;
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
