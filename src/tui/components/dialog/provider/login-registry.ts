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
 * All three flows share the same 5-arg signature so the dispatcher
 * doesn't need a per-provider branch. `primaryColor` is ignored by
 * `startKiroLogin` and `startOpenAICodexLogin` today — their
 * descriptions theme inline via `DialogAuthWait`'s own theme lookup.
 * `setOpenRouterKey` also ignores it today (the description uses
 * only `mutedColor`), but accepts the arg for signature parity. If
 * a future flow wants to theme an inline link, threading the color
 * through is one fewer context lookup deep in the call chain.
 */
export type LoginFlow = (
	dialog: DialogContext,
	toast: ToastContext,
	mutedColor: ReturnType<typeof useTheme>["theme"]["textMuted"],
	primaryColor: ReturnType<typeof useTheme>["theme"]["primary"],
	onModelSelected: (model: Model<Api>) => void,
) => void | Promise<void>;

/**
 * Adapt 4-arg Kiro / Codex flows to the shared 5-arg signature by
 * dropping the unused primaryColor arg. Cheaper than changing the
 * login-flow signatures to match — those flows have stable, well-
 * reviewed call paths and the wrapper costs nothing at runtime.
 */
const kiroLogin: LoginFlow = (
	dialog,
	toast,
	mutedColor,
	_primaryColor,
	onModelSelected,
) => startKiroLogin(dialog, toast, mutedColor, onModelSelected);

const codexLogin: LoginFlow = (
	dialog,
	toast,
	mutedColor,
	_primaryColor,
	onModelSelected,
) => startOpenAICodexLogin(dialog, toast, mutedColor, onModelSelected);

export const LOGIN_FLOWS: Record<string, LoginFlow> = {
	kiro: kiroLogin,
	"openai-codex": codexLogin,
	openrouter: setOpenRouterKey,
};
