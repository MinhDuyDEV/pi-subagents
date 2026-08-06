import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import taskExtension from "../src/index.js";
import { removeTaskWorktree, type WorktreeHandle } from "../src/worktree.js";

interface TaskResult {
  isError?: boolean;
  details?: { error?: string; task_id?: string };
}

type RegisteredTask = {
  execute: (...args: unknown[]) => Promise<TaskResult>;
};

function installExploreProfile(root: string): void {
  const agentDirectory = join(root, ".pi", "agents");
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(
    join(agentDirectory, "explore.md"),
    "---\ndescription: Read-only explorer\nreadonly: true\n---\nInspect only.\n",
  );
}

function registerTaskTool(): { tool: RegisteredTask; shutdown: () => void } {
  let tool: RegisteredTask | undefined;
  let shutdown = () => undefined;
  const eventHandlers = new Map<string, (payload: unknown) => void>();
  taskExtension({
    events: {
      on(event: string, handler: (payload: unknown) => void) {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      },
      emit() {},
    },
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerMessageRenderer() {},
    registerTool(value: RegisteredTask) {
      tool = value;
    },
    registerCommand() {},
    appendEntry() {},
    getAllTools() {
      return [];
    },
  } as never);
  assert.ok(tool);
  return { tool, shutdown };
}

function installFakeTmux(root: string): string {
  const binDirectory = join(root, "bin");
  mkdirSync(binDirectory);
  const executable = join(binDirectory, "tmux");
  writeFileSync(
    executable,
    "#!/bin/sh\ncase \"$1\" in\n  -V) printf '%s\\n' 'tmux 3.4' ;;\n  display-message) case \"$*\" in *pane_width*) printf '%s\\n' '120 40' ;; *) printf '%s\\n' '%pane-1' ;; esac ;;\n  split-window) printf '%s\\n' '%pane-1' ;;\n  *) exit 0 ;;\nesac\n",
  );
  chmodSync(executable, 0o755);
  return binDirectory;
}

test("active durable conversations reject foreground relaunch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-active-"));
  const piDirectory = join(root, ".pi");
  const artifactsDirectory = join(piDirectory, "artifacts", "tasks");
  const oldPath = process.env.PATH;
  const oldTmux = process.env.TMUX;
  const oldBackend = process.env.PI_TASK_BACKEND;
  let shutdown = () => undefined;
  try {
    installExploreProfile(root);
    mkdirSync(artifactsDirectory, { recursive: true });
    process.env.PATH = `${installFakeTmux(root)}:${oldPath ?? ""}`;
    process.env.TMUX = join(root, "tmux.sock");
    process.env.PI_TASK_BACKEND = "invalid-after-active-check";
    const common = {
      id: "active-task",
      agentType: "explore",
      description: "active task",
      sessionName: "active-conversation",
      startedAt: Date.now() - 1_000,
      piDir: piDirectory,
      dir: artifactsDirectory,
      cwd: root,
      conversationId: "active-conversation",
    };
    writeFileSync(join(piDirectory, "task-registry.json"), JSON.stringify([{
      ...common,
      handle: { backend: "tmux", resourceId: "%pane-1" },
    }]));
    writeFileSync(join(piDirectory, "task-session-history.json"), JSON.stringify([{
      ...common,
      status: "running",
      background: true,
    }]));
    writeFileSync(join(piDirectory, "artifacts", "task-sessions.json"), JSON.stringify({
      "active-conversation": {
        task_id: "active-task",
        updated_at: new Date().toISOString(),
      },
    }));

    const registered = registerTaskTool();
    shutdown = registered.shutdown;
    const result = await registered.tool.execute(
      "active-foreground",
      {
        agent_type: "explore",
        prompt: "Continue",
        description: "Continue active task",
        conversation_id: "active-conversation",
        background: false,
      },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(result.isError, true);
    assert.equal(result.details?.error, "active task cannot run foreground");
  } finally {
    shutdown();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = oldTmux;
    if (oldBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = oldBackend;
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent durable launches create one child and preserve its cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagents-concurrent-"));
  const target = join(root, "target-repo");
  const oldPath = process.env.PATH;
  const oldTmux = process.env.TMUX;
  const oldBackend = process.env.PI_TASK_BACKEND;
  let shutdown = () => undefined;
  try {
    installExploreProfile(root);
    mkdirSync(target);
    process.env.PATH = `${installFakeTmux(root)}:${oldPath ?? ""}`;
    process.env.TMUX = join(root, "tmux.sock");
    process.env.PI_TASK_BACKEND = "tmux";
    const registered = registerTaskTool();
    shutdown = registered.shutdown;
    const input = {
      agent_type: "explore",
      prompt: "Inspect",
      description: "Concurrent task",
      conversation_id: "shared-conversation",
      cwd: target,
      background: true,
    };
    const [first, second] = await Promise.all([
      registered.tool.execute("first", input, undefined, undefined, { cwd: root }),
      registered.tool.execute("second", input, undefined, undefined, { cwd: root }),
    ]);
    assert.equal(first.isError, undefined);
    assert.equal(second.isError, undefined);
    assert.ok(first.details?.task_id);
    assert.equal(second.details?.task_id, first.details?.task_id);

    const registry = JSON.parse(
      readFileSync(join(root, ".pi", "task-registry.json"), "utf8"),
    ) as Array<{ cwd?: string }>;
    assert.equal(registry.length, 1);
    assert.equal(registry[0]?.cwd, realpathSync(target));
  } finally {
    shutdown();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = oldTmux;
    if (oldBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = oldBackend;
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree isolation is created from the selected repository", async () => {
  const control = mkdtempSync(join(tmpdir(), "pi-subagents-control-"));
  const target = mkdtempSync(join(tmpdir(), "pi-subagents-target-"));
  const oldPath = process.env.PATH;
  const oldTmux = process.env.TMUX;
  const oldBackend = process.env.PI_TASK_BACKEND;
  let shutdown = () => undefined;
  let worktree: WorktreeHandle | undefined;
  try {
    installExploreProfile(control);
    execFileSync("git", ["init", "-q"], { cwd: target });
    writeFileSync(join(target, "README.md"), "target\n");
    execFileSync("git", ["add", "README.md"], { cwd: target });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"],
      { cwd: target },
    );
    process.env.PATH = `${installFakeTmux(control)}:${oldPath ?? ""}`;
    process.env.TMUX = join(control, "tmux.sock");
    process.env.PI_TASK_BACKEND = "tmux";
    const registered = registerTaskTool();
    shutdown = registered.shutdown;

    const result = await registered.tool.execute(
      "isolated-target",
      {
        agent_type: "explore",
        prompt: "Inspect",
        description: "Isolated target",
        cwd: target,
        isolation: "worktree",
        background: true,
      },
      undefined,
      undefined,
      { cwd: control },
    );
    assert.equal(result.isError, undefined);
    const registry = JSON.parse(
      readFileSync(join(control, ".pi", "task-registry.json"), "utf8"),
    ) as Array<{ cwd?: string; worktree?: WorktreeHandle }>;
    worktree = registry[0]?.worktree;
    assert.equal(registry[0]?.cwd, realpathSync(target));
    assert.equal(worktree?.repositoryRoot, realpathSync(target));
    assert.ok(worktree && existsSync(worktree.path));
  } finally {
    shutdown();
    if (worktree) removeTaskWorktree(worktree, true);
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = oldTmux;
    if (oldBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = oldBackend;
    rmSync(control, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
