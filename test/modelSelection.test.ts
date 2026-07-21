import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildPiArgs, type AgentConfig } from "../src/helpers.js";
import { resolveSdkModel } from "../src/subagent/runSdk.js";

const bundledAgentDir = fileURLToPath(new URL("../agents/", import.meta.url));

test("bundled agents defer model selection to Pi", () => {
  for (const name of ["explore", "general", "reviewer", "scout"]) {
    const content = readFileSync(`${bundledAgentDir}/${name}.md`, "utf8");
    assert.doesNotMatch(content, /^model:/m, `${name} pins a model`);
  }
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
