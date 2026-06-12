import { defaultInterpreterDeps } from "./interpreter.js";
import { runWorkerMain } from "./worker-main.js";

// PRODUCTION Worker entry point — drives the generic interpreter against real provider deps; stays faux-free
// (enforced by cli.guard.test.ts) — see docs/design/worker.md (ADR-0013, ADR-0018, ADR-0019, ADR-0027).
runWorkerMain(() => defaultInterpreterDeps());
