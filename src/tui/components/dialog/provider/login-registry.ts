import type { Api, Model } from "@mariozechner/pi-ai";
import type { useTheme } from "../../../context/theme";
import type { DialogContext } from "../../../ui/dialog";
import type { ToastContext } from "../../../ui/toast";
import { startKiroLogin } from "./login-kiro";
import { startOpenAICodexLogin } from "./login-openai-codex";
import { setOpenRouterKey } from "./set-openrouter-key";

/**
 * Provider login-flow lookup table.
 *
 * Keeps `ProviderInfo` free of a `login()` method by resolving login
 * flows TUI-side: the backend layer cannot import from `src/tui/` per
 * the Biome boundary rule (see `biome.json`'s `noRestrictedImports`),
 * and login flows intrinsically need `DialogContext`, `ToastContext`,
 * and theme colors — TUI-level concerns. A lookup table keyed by
 * provider id gives us the behavioral collapse (single dispatch call
 * at each call site) without crossing the boundary.
 *
 * Every currently-shipped provider has an entry. The dispatcher in
 * `manage-menu.tsx` / `provider/index.tsx` checks `LOGIN_FLOWS[id]`
 * before invoking; `undefined` is a programming error (a provider
 * was added to the registry without a login flow), not a user-facing
 * path, because today every registered provider needs explicit
 * credentials.
 *
 * All three flows declare the canonical 5-arg `LoginFlow` signature
 * directly. `primaryColor` is unused in every flow today (each
 * description themes inline via `DialogAuthWait`'s own theme lookup
 * or only reads `mutedColor`), so each flow names the parameter
 * `_primaryColor` to satisfy Biome's `noUnusedVariables`. Threading
 * the color through is one fewer context lookup deep in the call
 * chain when a future flow does want to theme an inline link.
 */
export type LoginFlow = (
	dialog: DialogContext,
	toast: ToastContext,
	mutedColor: ReturnType<typeof useTheme>["theme"]["textMuted"],
	primaryColor: ReturnType<typeof useTheme>["theme"]["primary"],
	onModelSelected: (model: Model<Api>) => void,
) => void | Promise<void>;

export const LOGIN_FLOWS: Record<string, LoginFlow> = {
	kiro: startKiroLogin,
	"openai-codex": startOpenAICodexLogin,
	openrouter: setOpenRouterKey,
};
