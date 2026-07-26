import { assertPiCoreProtocolVersion } from "@minhduydev/pi-core";
import piTaskExtension from "./index.js";
import { createTaskRuntime } from "./orchestration/runtime.js";

// A second pi-core copy with different canonicalization rules would recreate
// the digest divergence the shared package exists to end — refuse to load
// against a core speaking a different protocol.
assertPiCoreProtocolVersion(1);

// pi-subagents is a runtime-only fork of the upstream task extension.
// The "upstream" is in-repo (./index.js). We wrap it with orchestration
// (resource claims/leases, Context Pack + handoff, evidence-only review,
// orchestration doctor, local telemetry, `herdr` companion tool) and export
// the wrapped extension as the package entrypoint (see package.json pi.extensions).
// The wrapper strips the `orchestration` parameter before invoking the upstream
// tool, so the forked task tool sees its original contract.
export default createTaskRuntime(piTaskExtension);