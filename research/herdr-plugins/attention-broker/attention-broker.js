#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const mode = process.argv[2] ?? "event";
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const socketPath = process.env.HERDR_SOCKET_PATH;

if (!stateDir || !configDir || !socketPath) {
  fail("Attention Broker must run through Herdr's plugin runtime.");
}

fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

const sessionKey = crypto.createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
const sessionStateDir = path.join(stateDir, "sessions", sessionKey);
fs.mkdirSync(sessionStateDir, { recursive: true });
const statePath = path.join(sessionStateDir, "state.json");
const lockPath = path.join(sessionStateDir, "state.lock");
const config = readJson(path.join(configDir, "config.json"), {});
const rootName = stringValue(config.root_name) ?? "Root";
const dedupeWindowMs = positiveInteger(config.dedupe_window_ms) ?? 5000;

if (mode === "status") {
  process.stdout.write(`${JSON.stringify({ session_key: sessionKey, ...readState() }, null, 2)}\n`);
  process.exit(0);
}

if (mode !== "event") {
  fail(`Unknown mode: ${mode}`);
}

const event = parseEnvJson("HERDR_PLUGIN_EVENT_JSON");
const context = parseEnvJson("HERDR_PLUGIN_CONTEXT_JSON", {});
if (!event || !event.event || !event.data) {
  fail("HERDR_PLUGIN_EVENT_JSON did not contain a Herdr event envelope.");
}
const eventName =
  stringValue(process.env.HERDR_PLUGIN_EVENT) ?? normalizeEventName(event.event);

const agents = listAgents();
const workspaceId = event.data.workspace_id ?? context.workspace_id;
const eventPaneId = event.data.pane_id ?? context.focused_pane_id;
const roots = agents.filter(
  (agent) => agent.name === rootName && (!workspaceId || agent.workspace_id === workspaceId),
);

if (roots.length !== 1) {
  note(`ignored ${event.event}: expected one ${rootName} in workspace, found ${roots.length}`);
  process.exit(0);
}

const root = roots[0];
const subject = agents.find((agent) => agent.pane_id === eventPaneId);
const subjectAgent =
  stringValue(event.data.agent) ??
  stringValue(subject?.agent) ??
  stringValue(context.focused_pane_agent);
const subjectName = stringValue(subject?.name);
const status = stringValue(event.data.agent_status) ?? stringValue(subject?.agent_status);
const rootEvent = eventPaneId === root.pane_id;

note(
  `received ${eventName} pane=${eventPaneId ?? "unknown"} status=${status ?? "none"} ` +
    `subject=${subjectName ?? subjectAgent ?? "unknown"} root=${root.name ?? root.pane_id}`,
);

withStateLock(() => {
  const state = readState();
  pruneRecent(state, Date.now());

  if (rootEvent) {
    if (status === "idle" || status === "done") {
      flushRoot(state, root);
    }
    writeState(state);
    return;
  }

  if (!shouldQueue(eventName, status, subjectAgent)) {
    writeState(state);
    return;
  }

  const signature = [eventName, workspaceId, eventPaneId, status ?? "none"].join(":");
  const now = Date.now();
  if (state.recent[signature] && now - state.recent[signature] < dedupeWindowMs) {
    note(`deduplicated ${signature}`);
    writeState(state);
    return;
  }
  state.recent[signature] = now;

  const key = root.terminal_id;
  state.pending[key] ??= [];
  state.pending[key].push({
    signature,
    event: eventName,
    workspace_id: workspaceId,
    pane_id: eventPaneId,
    agent: subjectAgent,
    name: subjectName,
    status: status ?? terminalReason(eventName),
    observed_at: new Date(now).toISOString(),
  });

  flushRoot(state, root);
  writeState(state);
});

function shouldQueue(eventName, agentStatus, agentLabel) {
  if (eventName === "pane.agent_status_changed") {
    return Boolean(agentLabel) && ["idle", "done", "blocked"].includes(agentStatus);
  }
  return Boolean(agentLabel) && ["pane.exited", "pane.closed"].includes(eventName);
}

function flushRoot(state, root) {
  const pending = state.pending[root.terminal_id] ?? [];
  if (pending.length === 0) return;

  const summary = pending
    .map((item) => {
      const seat = item.name ?? item.agent ?? item.pane_id ?? "unknown-seat";
      return `${seat}:${item.status}`;
    })
    .join(", ");
  const prompt =
    `HERDR_ATTENTION_EVENT ${summary}. ` +
    "Consume the current handback or lifecycle gate once. Do not launch a polling loop; " +
    "re-arm attention only after making the next supervision decision.";
  const result = runHerdr(["pane", "run", root.pane_id, prompt]);
  if (result.status !== 0) {
    note(`wake failed for ${root.name ?? root.pane_id}: ${result.stderr.trim()}`);
    return;
  }
  delete state.pending[root.terminal_id];
  note(`woke ${root.name ?? root.pane_id} for ${pending.length} event(s)`);
}

function listAgents() {
  const result = runHerdr(["agent", "list"]);
  if (result.status !== 0) {
    fail(`herdr agent list failed: ${result.stderr.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    fail(`herdr agent list returned invalid JSON: ${error.message}`);
  }
  return parsed?.result?.agents ?? [];
}

function runHerdr(args) {
  return spawnSync(herdr, args, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readState() {
  const state = readJson(statePath, {});
  return {
    pending: state.pending && typeof state.pending === "object" ? state.pending : {},
    recent: state.recent && typeof state.recent === "object" ? state.recent : {},
  };
}

function writeState(state) {
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, statePath);
}

function withStateLock(callback) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const age = lockAgeMs();
      if (age !== null && age > 30000) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) fail("timed out acquiring the plugin state lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function lockAgeMs() {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function pruneRecent(state, now) {
  const keepForMs = Math.max(dedupeWindowMs * 12, 60000);
  for (const [key, observedAt] of Object.entries(state.recent)) {
    if (!Number.isFinite(observedAt) || now - observedAt > keepForMs) {
      delete state.recent[key];
    }
  }
}

function parseEnvJson(name, fallback = null) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${name} contained invalid JSON: ${error.message}`);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    fail(`could not read ${file}: ${error.message}`);
  }
}

function terminalReason(eventName) {
  return eventName === "pane.closed" ? "closed" : "exited";
}

function normalizeEventName(value) {
  const known = {
    pane_agent_status_changed: "pane.agent_status_changed",
    pane_exited: "pane.exited",
    pane_closed: "pane.closed",
  };
  return known[value] ?? value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function note(message) {
  process.stdout.write(`[attention-broker] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[attention-broker] ${message}\n`);
  process.exit(1);
}
