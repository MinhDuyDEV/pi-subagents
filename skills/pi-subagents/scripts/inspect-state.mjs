#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const project = resolve(process.argv[2] ?? process.cwd());
const root = resolve(project, ".pi", "artifacts", "tasks", "orchestration");
const runs = await json(`${root}/runs.json`, { runs: [] });
const leases = await json(`${root}/leases.json`, { leases: [] });
const events = await jsonl(`${root}/events.jsonl`);

const output = {
  project,
  runs: runs.runs ?? [],
  activeLeases: (leases.leases ?? []).filter(
    (lease) => Date.parse(lease.expiresAt) > Date.now(),
  ),
  recentEvents: events.slice(-50),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

async function json(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function jsonl(path) {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
