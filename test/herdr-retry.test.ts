import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { runWithRetry } from "../src/subagent/herdr.js";

const env = process.env;

describe("runWithRetry (pane-creation retry)", () => {
  beforeEach(() => {
    delete env.PI_SUBAGENTS_PANE_RETRIES;
  });
  afterEach(() => {
    delete env.PI_SUBAGENTS_PANE_RETRIES;
  });

  test("retries a transient failure and succeeds within the budget", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      if (calls < 3) throw new Error("Failed to create herdr execution pane");
      return "pane-abc";
    };
    const result = await runWithRetry(run, ["pane", "split", "--current"], {
      label: "pane split",
      backoffMs: [1, 1, 1],
    });
    assert.equal(result, "pane-abc");
    assert.equal(calls, 3);
  });

  test("does not retry when PI_SUBAGENTS_PANE_RETRIES=0", async () => {
    env.PI_SUBAGENTS_PANE_RETRIES = "0";
    let calls = 0;
    const run = async () => {
      calls += 1;
      throw new Error("Failed to create herdr execution pane");
    };
    await assert.rejects(
      runWithRetry(run, ["pane", "split"], { label: "pane split", backoffMs: [1, 1, 1] }),
      /pane split failed after 1 attempt\(s\)/,
    );
    assert.equal(calls, 1);
  });

  test("throws a labeled error after exhausting retries", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      throw new Error("boom");
    };
    await assert.rejects(
      runWithRetry(run, ["workspace", "create"], {
        label: "workspace create",
        backoffMs: [1, 1, 1],
      }),
      /workspace create failed after 1 attempt\(s\): boom/,
    );
    assert.equal(calls, 1);
  });

  test("succeeds on the first attempt when no error occurs", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { stdout: "ok" };
    };
    const result = await runWithRetry(run, ["pane", "get", "x"], {
      label: "pane get",
      backoffMs: [1, 1, 1],
    });
    assert.deepEqual(result, { stdout: "ok" });
    assert.equal(calls, 1);
  });
});