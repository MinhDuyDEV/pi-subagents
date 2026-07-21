import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildTaskPrompt } from "../src/tool/prompt.js";
import { TASK_PROMPT_INSTRUCTIONS } from "../src/helpers.js";

{
  const t = "buildTaskPrompt workspace scope";
  const prompt = buildTaskPrompt({
    description: "smoke",
    agentName: "explore",
    agentSource: "project",
    prompt: "Find foo",
    cwd: "/tmp/parent-cwd",
  });
  assert.ok(prompt.includes("/tmp/parent-cwd"), t + " cwd");
  assert.ok(prompt.includes("## Workspace scope"), t + " section");
  assert.ok(prompt.includes("explore"), t + " explore rule");
}

{
  const t = "TASK_PROMPT_INSTRUCTIONS aligned with XML";
  assert.ok(
    !TASK_PROMPT_INSTRUCTIONS.includes("Do not wrap it in XML"),
    t,
  );
  assert.ok(TASK_PROMPT_INSTRUCTIONS.includes("XML envelope"), t);
}

{
  const t = "task tool description includes parent cwd hint";
  const indexSrc = readFileSync(
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(indexSrc.includes("absolute repo path"), t);
  assert.ok(!indexSrc.includes("pi.getAllTools()"), "extension load avoids runtime-only tool enumeration");
}

console.log("prompt.test.ts: all passed");