/**
 * Barrel for the split agent context. The provider + reducer + actions
 * + commands all live under `./agent/`; this file preserves the
 * `import { ... } from "../context/agent"` seam used by every TUI
 * consumer and the test harness.
 */

export type { Session } from "@backend/agent";
export type { SessionFactory } from "./agent/provider";
export { AgentProvider, useAgent } from "./agent/provider";
