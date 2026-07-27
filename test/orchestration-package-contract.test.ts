import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package host contract", () => {
  it("pins one tested Pi and TypeBox host while accepting only that Pi minor", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      engines?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.engines?.node).toBe(">=22.19.0");
    expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe(">=0.81.1 <0.82.0");
    expect(pkg.peerDependencies?.["@earendil-works/pi-tui"]).toBe(">=0.81.1 <0.82.0");
    expect(pkg.peerDependencies?.typebox).toBe("1.1.38");
    expect(pkg.devDependencies?.["@earendil-works/pi-coding-agent"]).toBe("0.81.1");
    expect(pkg.devDependencies?.["@earendil-works/pi-tui"]).toBe("0.81.1");
    expect(pkg.devDependencies?.typebox).toBe("1.1.38");
  });
});
