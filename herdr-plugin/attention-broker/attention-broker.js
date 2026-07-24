#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const mode = process.argv[2] ?? "event";
const stateRoot = process.env.HERDR_PLUGIN_STATE_DIR;
const configRoot = process.env.HERDR_PLUGIN_CONFIG_DIR;
const socketPath = process.env.HERDR_SOCKET_PATH;
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
if (!stateRoot || !configRoot || !socketPath) fail("must run through Herdr's plugin runtime");

const sessionKey = crypto.createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
const stateDir = path.join(stateRoot, "sessions", sessionKey);
const statePath = path.join(stateDir, "state.json");
const lockPath = path.join(stateDir, "state.lock");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(configRoot, { recursive: true });
const config = readJson(path.join(configRoot, "config.json"), {});
const rootName = text(config.root_name) ?? "Root";
const dedupeMs = positiveInteger(config.dedupe_window_ms) ?? 5000;

if (mode === "status") {
  process.stdout.write(`${JSON.stringify({ session_key: sessionKey, ...readState() }, null, 2)}\n`);
  process.exit(0);
}
if (mode !== "event") fail(`unknown mode: ${mode}`);

const envelope = parseJsonEnv("HERDR_PLUGIN_EVENT_JSON");
const context = parseJsonEnv("HERDR_PLUGIN_CONTEXT_JSON", {});
if (!envelope?.event || !envelope?.data) fail("missing Herdr event envelope");
const eventName = text(process.env.HERDR_PLUGIN_EVENT) ?? normalizeEvent(envelope.event);
const agents = listAgents();
const workspaceId = envelope.data.workspace_id ?? context.workspace_id;
const paneId = envelope.data.pane_id ?? context.focused_pane_id;
const roots = agents.filter(
  (agent) => agent.name === rootName && (!workspaceId || agent.workspace_id === workspaceId),
);
if (roots.length !== 1) {
  note(`ignored ${eventName}: expected one ${rootName}, found ${roots.length}`);
  process.exit(0);
}
const root = roots[0];
const subject = agents.find((agent) => agent.pane_id === paneId);
const status = text(envelope.data.agent_status) ?? text(subject?.agent_status) ?? terminalStatus(eventName);

withLock(() => {
  const state = readState();
  prune(state, Date.now());
  if (paneId === root.pane_id) {
    if (status === "idle" || status === "done") flush(state, root);
    writeState(state);
    return;
  }
  if (!shouldQueue(eventName, status, subject)) {
    writeState(state);
    return;
  }
  const signature = [eventName, workspaceId, paneId, status].join(":");
  const now = Date.now();
  if (state.recent[signature] && now - state.recent[signature] < dedupeMs) {
    writeState(state);
    return;
  }
  state.recent[signature] = now;
  const owner = root.terminal_id;
  state.pending[owner] ??= [];
  state.pending[owner].push({
    signature,
    event: eventName,
    workspace_id: workspaceId,
    pane_id: paneId,
    task_id: subject?.tokens?.task_id,
    agent: subject?.name ?? subject?.agent,
    status,
    observed_at: new Date(now).toISOString(),
  });
  flush(state, root);
  writeState(state);
});

function flush(state, root) {
  const pending = state.pending[root.terminal_id] ?? [];
  if (!pending.length) return;
  const summary = pending
    .map((item) => `${item.task_id ?? item.agent ?? item.pane_id}:${item.status}`)
    .join(", ");
  const prompt =
    `PI_SUBAGENTS_ATTENTION ${summary}. Reconcile durable task state once; ` +
    "do not poll or duplicate delegated work.";
  const result = run(["agent", "prompt", root.pane_id, prompt]);
  if (result.status !== 0) {
    note(`wake queued: ${result.stderr.trim()}`);
    return;
  }
  delete state.pending[root.terminal_id];
  note(`woke ${root.name ?? root.pane_id} for ${pending.length} event(s)`);
}

function shouldQueue(eventName, status, subject) {
  if (!subject?.agent && !subject?.name) return false;
  if (eventName === "pane.agent_status_changed") {
    return ["idle", "done", "blocked"].includes(status);
  }
  return eventName === "pane.exited" || eventName === "pane.closed";
}

function listAgents() {
  const result = run(["agent", "list"]);
  if (result.status !== 0) fail(`agent list failed: ${result.stderr.trim()}`);
  try {
    return JSON.parse(result.stdout)?.result?.agents ?? [];
  } catch (error) {
    fail(`agent list returned invalid JSON: ${error.message}`);
  }
}

function run(args) {
  return spawnSync(herdr, args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}

function readState() {
  const value = readJson(statePath, {});
  return {
    pending: value.pending && typeof value.pending === "object" ? value.pending : {},
    recent: value.recent && typeof value.recent === "object" ? value.recent : {},
  };
}

function writeState(state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function withLock(callback) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = lockAge();
      if (age !== null && age > 30000) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) fail("timed out acquiring state lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function lockAge() {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function prune(state, now) {
  const keep = Math.max(dedupeMs * 12, 60000);
  for (const [key, observed] of Object.entries(state.recent)) {
    if (!Number.isFinite(observed) || now - observed > keep) delete state.recent[key];
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function parseJsonEnv(name, fallback = null) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${name} is invalid JSON: ${error.message}`);
  }
}

function normalizeEvent(value) {
  return ({
    pane_agent_status_changed: "pane.agent_status_changed",
    pane_exited: "pane.exited",
    pane_closed: "pane.closed",
  })[value] ?? value;
}
function terminalStatus(event) {
  return event === "pane.closed" ? "closed" : "exited";
}
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}
function note(message) {
  process.stdout.write(`[pi-subagents-attention] ${message}\n`);
}
function fail(message) {
  process.stderr.write(`[pi-subagents-attention] ${message}\n`);
  process.exit(1);
}
