import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { HerdrTerminalHandle } from "../types.js";
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

const WINDOWS_GIT_SHELLS = [
  "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
  "C:\\Program Files\\Git\\bin\\sh.exe",
] as const;

export function resolveHerdrShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const configured = env.PI_TASK_HERDR_SHELL?.trim();
  if (configured) return configured;
  if (platform === "win32") return WINDOWS_GIT_SHELLS.find(fileExists) ?? "sh";
  return "sh";
}

let launchQueue: Promise<void> = Promise.resolve();
const groupedWorkspaces = new Map<
  string,
  { workspaceId: string; references: number }
>();

function workspaceGroupKey(socketPath: string, group: string): string {
  return `${socketPath}\u0000${group}`;
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

function parentTabFrom(value: unknown): string {
  const tabId = paneFrom(value).tab_id;
  if (typeof tabId !== "string")
    throw new Error("HerdR pane get did not include tab_id");
  return tabId;
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

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function requireHerdrHandle(
  handle: Parameters<TerminalBackend["isAlive"]>[0],
): HerdrTerminalHandle {
  if (handle.backend !== "herdr")
    throw new Error("HerdR backend cannot control a non-HerdR handle");
  return handle;
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
  const run = (args: readonly string[]) =>
    runner("herdr", args, {
      env: { ...env, HERDR_SOCKET_PATH: socketPath },
    });

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
      } catch {
        return false;
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
        const label = input.label ?? "pi-task";
        const groupKey = input.workspaceGroup
          ? workspaceGroupKey(socketPath, input.workspaceGroup)
          : undefined;
        const existingGroup = groupKey
          ? groupedWorkspaces.get(groupKey)
          : undefined;
        const workspaceResponse =
          groupKey && !existingGroup
            ? await run([
                "workspace",
                "create",
                "--cwd",
                input.cwd,
                "--label",
                input.workspaceGroup!,
                "--no-focus",
              ])
            : undefined;
        const workspace = existingGroup
          ? { workspace_id: existingGroup.workspaceId, root_pane_id: undefined }
          : workspaceResponse
            ? workspaceFrom(
                decode(workspaceResponse.stdout, "workspace create"),
              )
            : undefined;
        try {
          const placement = workspace
            ? ["--workspace", workspace.workspace_id]
            : [
                "--tab",
                parentTabFrom(
                  decode(
                    (await run(["pane", "get", env.HERDR_PANE_ID])).stdout,
                    "pane get",
                  ),
                ),
              ];
          const response = await run([
            "agent",
            "start",
            label,
            ...placement,
            "--cwd",
            input.cwd,
            "--no-focus",
            "--",
            resolveHerdrShell(env),
            "-lc",
            input.command,
          ]);
          const created = paneFrom(decode(response.stdout, "agent start"));
          if (workspace?.root_pane_id)
            await run(["pane", "close", workspace.root_pane_id]);
          if (groupKey && workspace) {
            groupedWorkspaces.set(groupKey, {
              workspaceId: workspace.workspace_id,
              references: (existingGroup?.references ?? 0) + 1,
            });
          }
          return {
            backend: "herdr" as const,
            resourceId: created.pane_id,
            socketPath,
            terminalId: created.terminal_id,
            ...(workspace ? { workspaceId: workspace.workspace_id } : {}),
            ...(input.workspaceGroup
              ? { workspaceGroup: input.workspaceGroup }
              : {}),
          };
        } catch (error) {
          if (workspaceResponse && workspace)
            await run(["workspace", "close", workspace.workspace_id]).catch(
              () => undefined,
            );
          throw error;
        }
      });
    },

    async isAlive(handle) {
      try {
        await verifyOwnership(handle);
        return true;
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
      await run(["pane", "send-text", owned.resourceId, message]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await run(["pane", "send-keys", owned.resourceId, "enter"]);
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
      if (
        handle.backend === "herdr" &&
        handle.workspaceId &&
        handle.workspaceGroup
      ) {
        const key = workspaceGroupKey(handle.socketPath, handle.workspaceGroup);
        const group = groupedWorkspaces.get(key);
        if (!group || group.workspaceId !== handle.workspaceId) {
          await run(["pane", "close", handle.resourceId]);
          return;
        }
        if (group.references > 1) {
          group.references -= 1;
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
      run(["pane", "send-text", handle.resourceId, message], handle.socketPath);
      sleepSync(300);
      run(["pane", "send-keys", handle.resourceId, "enter"], handle.socketPath);
    },
    close(handle: HerdrTerminalHandle): void {
      if (
        handle.backend === "herdr" &&
        handle.workspaceId &&
        handle.workspaceGroup
      ) {
        const key = workspaceGroupKey(handle.socketPath, handle.workspaceGroup);
        const group = groupedWorkspaces.get(key);
        if (!group || group.workspaceId !== handle.workspaceId) {
          run(["pane", "close", handle.resourceId], handle.socketPath);
          return;
        }
        if (group.references > 1) {
          group.references -= 1;
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
