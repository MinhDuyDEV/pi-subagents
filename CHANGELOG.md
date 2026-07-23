# Changelog

All notable changes to `@minhduydev/pi-subagents` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-23

### Added
- Runtime-only delegation package: `task` tool (foreground/background, HerdR/tmux/SDK backends).
- Machine-checkable orchestration: resource claims/leases (`write`/`test`/`evidence`, exclusive/shared, hierarchical conflict), Context Pack + handoff (provenance, SHA-256, secret redaction, out-of-repo rejection), evidence-only review, orchestration doctor, local telemetry.
- `herdr` companion tool: `status`/`result`/`handoff`/`metrics`/`doctor`/`record_review`/`release`.
- Opt-out envs: `PI_SUBAGENTS_NO_CLAIMS`, `PI_SUBAGENTS_NO_PROOF`, `PI_SUBAGENTS_NO_TELEMETRY`.

### Changed
- Runtime-only: no bundled agent profiles; agents resolve from the consumer's `.pi/agents/`.
- `peerDependencies` floor: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `>=0.81.1`.
- Additive kernel: never injects policy into a consumer's system prompt.

### Removed
- Bundled starter agents (`scout`, `explore`, `general`, `reviewer`) — owned by consuming repos now.