import { join } from "node:path";

export interface OrchestrationPaths {
  root: string;
  leaseStore: string;
  eventLog: string;
  contextStore: string;
}

export function getOrchestrationPaths(
  projectDirectory: string,
): OrchestrationPaths {
  const root = join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
  );
  return {
    root,
    leaseStore: join(root, "leases.json"),
    eventLog: join(root, "events.jsonl"),
    contextStore: join(root, "contexts"),
  };
}
