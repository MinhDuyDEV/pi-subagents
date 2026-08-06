import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveTaskCwd } from "../src/task-cwd.js";
import { taskParametersSchema } from "../src/tool/schema.js";

test("cwd is an optional documented task parameter", () => {
  const schema = taskParametersSchema() as {
    properties?: Record<string, { description?: string }>;
  };
  const cwd = schema.properties?.cwd;
  assert.ok(cwd);
  assert.match(cwd.description ?? "", /absolute existing directory/i);
  assert.match(cwd.description ?? "", /resume/i);
});

test("resolves explicit and persisted execution directories", () => {
  const controlRoot = mkdtempSync(join(tmpdir(), "pi-subagents-cwd-"));
  const persisted = join(controlRoot, "persisted");
  const explicit = join(controlRoot, "explicit");
  mkdirSync(persisted);
  mkdirSync(explicit);
  try {
    assert.deepEqual(resolveTaskCwd(controlRoot, undefined, persisted), {
      kind: "resolved",
      cwd: realpathSync(persisted),
    });
    assert.equal(resolveTaskCwd(controlRoot, explicit, persisted).kind, "invalid");
    assert.deepEqual(resolveTaskCwd(controlRoot, persisted, persisted), {
      kind: "resolved",
      cwd: realpathSync(persisted),
    });
    assert.deepEqual(resolveTaskCwd(controlRoot, undefined), {
      kind: "resolved",
      cwd: realpathSync(controlRoot),
    });
  } finally {
    rmSync(controlRoot, { recursive: true, force: true });
  }
});

test("rejects relative, missing, control-character, and non-directory cwd values", () => {
  const controlRoot = mkdtempSync(join(tmpdir(), "pi-subagents-invalid-cwd-"));
  const filePath = join(controlRoot, "not-a-directory");
  writeFileSync(filePath, "file");
  try {
    for (const value of [
      "relative/path",
      join(controlRoot, "missing"),
      `${controlRoot}\nchild`,
      filePath,
      "",
    ]) {
      assert.equal(resolveTaskCwd(controlRoot, value).kind, "invalid", String(value));
    }
  } finally {
    rmSync(controlRoot, { recursive: true, force: true });
  }
});
