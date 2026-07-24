import { describe, expect, it } from "vitest";
import {
  HerdrClient,
  HerdrCommandError,
} from "../src/subagent/herdrClient.ts";

describe("typed HerdR client", () => {
  it("decodes envelopes and submits atomic agent prompts", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const client = new HerdrClient({
      env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      runner: async (_command, args) => {
        mutableCalls.push([...args]);
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: "w1:p2",
                terminal_id: "terminal-2",
                agent_status: "working",
              },
            },
          }),
          stderr: "",
        };
      },
    });
    const agent = await client.prompt("w1:p2", "review now");
    expect(agent.agent_status).toBe("working");
    expect(calls).toEqual([["agent", "prompt", "w1:p2", "review now"]]);
  });

  it("preserves structured error codes and transient classification", async () => {
    const client = new HerdrClient({
      env: {},
      runner: async () => {
        throw Object.assign(new Error("command failed"), {
          stderr: JSON.stringify({
            error: { code: "server_unavailable", message: "server restarting" },
          }),
          exitCode: 1,
        });
      },
    });
    await expect(client.getPane("w1:p2")).rejects.toMatchObject({
      name: "HerdrCommandError",
      code: "server_unavailable",
      transient: true,
    } satisfies Partial<HerdrCommandError>);
  });

  it("rejects malformed success output instead of guessing payload shape", async () => {
    const client = new HerdrClient({
      env: {},
      runner: async () => ({ stdout: "not json", stderr: "" }),
    });
    await expect(client.getPane("w1:p2")).rejects.toMatchObject({
      code: "invalid_json",
    });
  });
});
