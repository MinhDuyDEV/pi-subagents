import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "pi-subagents-install-"));
let tarball;
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json"], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  tarball = join(repository, packed.at(-1).filename);
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ name: "pi-subagents-install-test", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", tarball], {
    cwd: temporary,
    encoding: "utf8",
    stdio: "inherit",
  });

  const packageRoot = join(
    temporary,
    "node_modules",
    "@minhduydev",
    "pi-subagents",
  );
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const expectedManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  if (manifest.version !== expectedManifest.version) {
    throw new Error(`Installed package version mismatch: expected ${expectedManifest.version}, got ${manifest.version}`);
  }
  for (const path of [
    "dist/task-runtime.js",
    "dist/api.js",
    "skills/pi-subagents/SKILL.md",
    "herdr-plugin/attention-broker/herdr-plugin.toml",
  ]) {
    if (!existsSync(join(packageRoot, path))) throw new Error(`Packed file missing: ${path}`);
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const runtime = await import("@minhduydev/pi-subagents");',
        'const api = await import("@minhduydev/pi-subagents/api");',
        'if (typeof runtime.default !== "function") throw new Error("runtime export missing");',
        'if (api.TASK_RPC_PROTOCOL_VERSION !== 3) throw new Error("API export mismatch");',
      ].join("\n"),
    ],
    { cwd: temporary, stdio: "inherit" },
  );
  console.log("package install test passed");
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(temporary, { recursive: true, force: true });
}
