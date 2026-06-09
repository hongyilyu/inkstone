import { defaultInterpreterDeps } from "./interpreter.js";
import { runWorkerMain } from "./worker-main.js";

/**
 * The PRODUCTION Worker entry point (ADR-0013 stdin transport, ADR-0018 generic
 * interpreter, ADR-0027 transport seam). Core spawns this via
 * `INKSTONE_WORKER_CMD` for a real Run. It drives the generic interpreter
 * against real provider deps ({@link defaultInterpreterDeps}: real `getModel` +
 * token-injecting `streamSimple`); the entry scaffolding — manifest read, the
 * terminal-event guarantee, the stdio transport — lives in {@link runWorkerMain}.
 *
 * There is no per-Workflow code and NO test-only faux-provider scripting here:
 * faux scripting lives in the dedicated test-only entry `faux-worker.ts`
 * (ADR-0019 as-built), kept off the shipping path. `cli.guard.test.ts` enforces
 * that this file stays faux-free.
 */
runWorkerMain(() => defaultInterpreterDeps());
