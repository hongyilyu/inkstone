import { initLogger } from "@backend/logger";
import { render } from "@opentui/solid";
import { App } from "@tui/app";

await initLogger();
render(() => <App />, { exitOnCtrlC: false });
