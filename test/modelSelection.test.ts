import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildPiArgs, type AgentConfig } from "../src/helpers.js";
import { resolveSdkModel } from "../src/subagent/runSdk.js";

const bundledAgentDir = fileURLToPath(new URL("../agents/", import.meta.url));

test("runtime-only: ships no bundled agent profiles", () => {
  // pi-subagents is runtime-only: agents resolve from the consumer's
  // .pi/agents/ and ~/.pi/agent/agents/. The bundled dir must be empty/absent.
  let entries: string[] = [];
  try {
    entries = readdirSync(bundledAgentDir).filter((f) => f.endsWith(".md"));
  } catch {
    // missing dir is the expected runtime-only state in consumers
  }
  assert.equal(
    entries.length,
    0,
    `pi-subagents must ship no bundled agents; found: ${entries.join(", ")}`,
  );
});

test("terminal subagents defer to Pi unless an agent explicitly selects a model", () => {
  const agent: AgentConfig = {
    name: "test",
    description: "test agent",
    body: "",
    source: "bundled",
    path: "/agents/test.md",
  };

  const defaults = buildPiArgs(agent, "task-default", "/tmp", "prompt");
  assert.ok(!defaults.includes("--model"));

  const explicit = buildPiArgs(
    { ...agent, model: "anthropic/claude-sonnet" },
    "task-explicit",
    "/tmp",
    "prompt",
  );
  assert.deepEqual(
    explicit.slice(explicit.indexOf("--model"), explicit.indexOf("--model") + 2),
    ["--model", "anthropic/claude-sonnet"],
  );
});

test("SDK subagents use the current Pi model when their agent has no model", async () => {
  const current = { id: "gpt-5", provider: { id: "openai" } };
  const fallback = { id: "other", provider: { id: "other" } };

  const resolved = await resolveSdkModel({
    model: current,
    modelRegistry: { getAll: () => [fallback] },
  });

  assert.equal(resolved, current);
});

test("SDK subagents preserve an explicitly configured agent model", async () => {
  const current = { id: "gpt-5", provider: { id: "openai" } };
  const configured = { id: "claude-sonnet", provider: { id: "anthropic" } };

  const resolved = await resolveSdkModel(
    {
      model: current,
      modelRegistry: {
        find: (provider: string, modelId: string) =>
          provider === "anthropic" && modelId === "claude-sonnet"
            ? configured
            : undefined,
      },
    },
    "anthropic/claude-sonnet",
  );

  assert.equal(resolved, configured);
});

test("SDK subagents fail clearly when a pinned model is unavailable", async () => {
  const current = { id: "gpt-5", provider: { id: "openai" } };
  const fallback = { id: "other", provider: { id: "other" }, name: "Other" };

  await assert.rejects(
    () =>
      resolveSdkModel(
        {
          model: current,
          modelRegistry: {
            find: () => undefined,
            getAll: () => [fallback],
            getAvailable: () => [fallback],
          },
        },
        "missing/provider-model",
      ),
    /requested subagent model.*not available/i,
  );
});
