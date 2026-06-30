import { createModels, type fauxProvider } from "@earendil-works/pi-ai";
import type { InterpreterDeps } from "../interpreter.js";

// Shared faux-provider wiring for the interpreter (pi-ai 0.80.2). The faux
// provider is instance-scoped — it registers into NO process-global registry —
// so the stream fn must dispatch through a `Models` collection that owns it
// (the old top-level `streamSimple` had a global registry to find it; the modern
// one does not). `resolveModel`/`streamFn` mirror `defaultInterpreterDeps`, but
// over a single faux provider instead of the built-in catalog.
//
// One seam shared by the faux Worker entry (`faux-worker.ts`) and every
// faux-driven test (interpreter/tool-proxy/eval), so the collection wiring lives
// in exactly one place.
export function fauxInterpreterDeps(
	faux: ReturnType<typeof fauxProvider>,
): InterpreterDeps {
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		resolveModel: () => faux.getModel(),
		streamFn: (model, context, options) =>
			models.streamSimple(model, context, options),
	};
}
