import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSdkToolCapability,
  buildAgentToolSelection,
  resolveAgentToolAllowlist,
} from "../src/agent-tools.js";
import { buildPiArgv } from "../src/subagent/buildArgv.js";
import type { AgentConfig } from "../src/helpers.js";

const READONLY_PARENT_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "apply_patch",
  "quick_edit",
  "target_edit",
  "todo",
  "workflow_state",
  "semantic_query",
  "semantic_review",
  "websearch",
  "unknown_mutator",
];

test("readonly agents receive a fail-closed positive tool allowlist", () => {
  const tools = resolveAgentToolAllowlist({
    readonly: true,
    parentToolNames: READONLY_PARENT_TOOLS,
  });

  assert.deepEqual(tools, ["read", "semantic_query", "semantic_review", "websearch"]);
  for (const mutator of [
    "bash",
    "edit",
    "write",
    "apply_patch",
    "quick_edit",
    "target_edit",
    "todo",
    "workflow_state",
    "unknown_mutator",
  ]) {
    assert.equal(tools.includes(mutator), false, `${mutator} must not cross readonly boundary`);
  }
});

test("terminal and SDK backends derive the same effective tool allowlist", () => {
  const agent: AgentConfig = {
    name: "reviewer",
    description: "read-only reviewer",
    body: "Review only",
    source: "project",
    path: "/tmp/reviewer.md",
    readonly: true,
  };
  const parentToolNames = READONLY_PARENT_TOOLS;
  const sdk = buildAgentToolSelection({
    readonly: agent.readonly,
    parentToolNames,
  });
  const argv = buildPiArgv({
    agent,
    sessionName: "review",
    sessionDir: "/tmp/session",
    promptContent: "review",
    parentToolNames,
  });
  const toolFlag = argv.indexOf("--tools");

  assert.notEqual(toolFlag, -1);
  assert.deepEqual(argv[toolFlag + 1]?.split(","), sdk.tools);
});

test("SDK backend fails preflight when no-extensions cannot provide selected tools", () => {
  assert.doesNotThrow(() => assertSdkToolCapability(["read", "grep", "find", "ls"]));
  assert.throws(
    () => assertSdkToolCapability(["read", "semantic_query"]),
    /SDK backend.*extensions are disabled: semantic_query/i,
  );
});

test("interactive ask_user remains parent-only across task backends", () => {
  const selection = buildAgentToolSelection({
    parentToolNames: ["read", "ask_user"],
  });

  assert.deepEqual(selection.tools, ["read"]);
});
