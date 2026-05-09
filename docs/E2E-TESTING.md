# Inkstone — E2E Testing

This is the working reference for Inkstone's end-to-end test layer: how
the harness is wired, what's covered, what isn't (and why), and the
recipe for adding a new test. Replaces the original `E2E-PLAN.md`,
which was a planning doc that's been satisfied — the harness shipped,
the smoke tests landed, and the suite has grown to 28 TUI files +
~25 backend files (~12K LOC, ~480 cases) since.

For the day-to-day "I'm shipping a feature, do I owe a test?" rule,
see `CLAUDE.md` § Test Protocol. This doc is the deeper reference.

---

## Test layers at a glance

| Layer        | Where                  | What it exercises                                                                                  |
| ------------ | ---------------------- | -------------------------------------------------------------------------------------------------- |
| **TUI E2E**  | `test/tui/*.test.tsx`  | Full Solid app via `@opentui/solid` `testRender`. Real reducer, real components, real Solid store. |
| **Backend** | `test/*.test.ts`        | Persistence, permissions, providers, agent compose, mentions, tool renderers, etc.                 |
| **Unit**    | `test/*.test.ts` (some) | Pure functions: `dialog-select-grouping`, `command-slash`, `frontmatter`, `mode-state`.            |
| **Process** | _not implemented_       | See "Deferred layers" below.                                                                       |

The TUI E2E layer is the closest thing to true E2E in this repo:
the same provider stack `src/tui/app.tsx` mounts at boot, with one
exception — the backend `Session` is faked so tests don't hit the
network or LLM.

---

## TUI harness

### `test/tui/harness.tsx` — `renderApp(opts)`

Mounts `Theme → Toast → Dialog → Command → ErrorBoundary →
LayoutProvider → AgentProvider → Layout`, identical to `App` in
`src/tui/app.tsx`. Returns OpenTUI's `testRender` handle plus
`getAgent()` / `getLayout()` accessors that surface the live
context values.

```ts
const fake = makeFakeSession();
const setup = await renderApp({ session: fake.factory, width: 120 });
await setup.renderOnce();
fake.emit(ev_agentStart());
// ... drive a synthetic turn ...
const f = await waitForFrame(setup, "expected substring");
```

Key helpers:

- `setup.mockInput.typeText(s)` / `pressEnter()` / `pressKey("p", { ctrl: true })` / `pressArrow("right")` — keyboard input.
- `setup.captureCharFrame()` — current rendered char grid as a single string.
- `setup.renderOnce()` — drive one paint cycle.
- `setup.getAgent()` / `setup.getLayout()` — live context values, for asserting on `actions` / `store` directly.
- `setup.renderer.destroy()` — call from `afterEach` to tear down.

### `test/tui/harness.tsx` — `waitForFrame(setup, needle, opts?)`

Polls `renderOnce` + `captureCharFrame` until `needle` (string or
regex) appears. **Always prefer this over fixed sleeps.** Markdown
rendering is async (tree-sitter highlighting on a worker), so a
single `renderOnce` after a store mutation is rarely enough. Default
timeout 3000ms; on timeout it prints the final frame to make
debugging fast.

### `test/tui/fake-session.ts` — `makeFakeSession(opts?)`

In-memory `Session` stub. The factory records every action call
(`fake.calls.prompt: string[]`, `fake.calls.abort: number`, etc.) and
exposes `emit(event)` to drive synthetic `AgentEvent`s through the
real reducer. Event builders (`ev_agentStart`, `ev_messageStart`,
`ev_textDelta`, `ev_toolcallEnd`, `ev_toolExecEnd`, `ev_agentEnd`,
…) compose a turn:

```ts
fake.emit(ev_agentStart());
fake.emit(ev_messageStart());
fake.emit(ev_textStart());
fake.emit(ev_textDelta("hello"));
fake.emit(ev_messageEnd({ stopReason: "stop" }));
fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
```

Escape hatches:

- `fake.failNextPrompt(err)` — schedule the next `actions.prompt` call to reject. Used to exercise the reducer's pre-stream-error recovery path.
- `fake.getSession()` — direct handle to the fake's `Session` for tests that need to mutate state in ways the wrappedActions don't expose (e.g. mid-stream `setThinkingLevel` to validate the snapshot invariant).

### `test/preload.ts` — isolated XDG dirs + vault skeleton

Runs **before** any `@backend/*` import resolves (wired via
`bunfig.toml` `[test] preload`). Creates a unique tmp dir per process
and:

- Sets `XDG_CONFIG_HOME` / `XDG_STATE_HOME` to subdirs of the tmp.
- Seeds `auth.json` with an OpenRouter test key so connected-provider
  paths light up deterministically.
- Seeds `config.json` pointing at the tmp vault.
- Seeds `010 RAW/013 Articles/` with `foo.md`, `bar.md`, a CJK
  filename, a dangling `sneak.md` symlink, and an empty `subfolder/`
  for the `/article` directory-reject branch.

If you need a new vault fixture for a test, add it to `preload.ts`
rather than building it inline — the preload runs once per process,
so per-test setup overhead stays at zero.

---

## What's covered

Listed feature → file. This is the working source of truth; consult
the tests themselves for exact assertions.

**Agent system:**
- System prompt composition — `test/agent-compose.test.ts`, `test/knowledge-base-agent.test.ts`
- Permission dispatch (matrix + zone overlay + `/article` validator) — `test/permissions.test.ts`
- Slash command gating — `test/command-slash.test.ts`
- KB agent registry — `test/knowledge-base-agent.test.ts`

**Agent commands (TUI):**
- Reader `/article` happy path / errors / picker — `test/tui/reader-article.test.tsx`
- KB `/ingest` `/lint` `/query` — `test/tui/kb-commands.test.tsx`
- Suggest-command flow — `test/tui/suggest-command.test.tsx`
- Agent cycling (Tab on open page) — `test/tui/agent-cycle.test.tsx`

**Persistence:**
- Atomic writes / dir modes — `test/persistence-atomic.test.ts`
- Failure rollback / dedup — `test/persistence-failure.test.ts`
- Alternation repair — `test/persistence-repair.test.ts`
- `loadSession` resume integration — `test/resume-repair.test.ts`
- Totals rollup — `test/resume-totals.test.ts`
- DisplayMessage round-trip — `test/display-file-part.test.ts`
- Frontmatter parser — `test/frontmatter.test.ts`

**Providers / auth:**
- Kiro / Codex / OpenRouter — `test/kiro-refresh.test.ts`, `test/openai-codex-{default,refresh}.test.ts`, `test/openrouter-default.test.ts`
- Connect dialog (login / disconnect / re-auth) — `test/tui/connect-manage.test.tsx`
- Codex transport ws/sse — `test/tui/codex-transport.test.tsx`
- Mini-model picker — `test/tui/mini-model.test.tsx`

**Streaming / reducer:**
- Multi-turn + tool use — `test/tui/streaming.test.tsx`, `test/tui/conversation.test.tsx`
- First-paint flash regression (empty assistant shell hidden until first part) — `test/tui/conversation.test.tsx`
- Footer metadata (agent / model / duration / thinking-level) — `test/tui/assistant-footer.test.tsx`, `test/tui/streaming.test.tsx`
- Mid-conversation model switch — `test/tui/streaming.test.tsx` (`next-turn footer reflects new model...`)
- Interrupt (Ctrl+C / ESC-ESC) — `test/tui/interrupt.test.tsx`, `test/tui/prompt-ctrlc.test.ts`

**Permission UI (unified panel for tool approvals + provider disconnect):**
- Agent-tool approval panel mechanics — `test/tui/permission-prompt.test.tsx`
- Diff preview rendering — `test/tui/pending-approval-part.test.tsx`
- Deny → tool-error → next-turn-unblocked propagation — `test/tui/permission-deny-flow.test.tsx`
- Disconnect confirmation (second panel caller, parameterized header / labels) — `test/tui/connect-manage.test.tsx`

**Session lifecycle:**
- List panel + resume — `test/tui/session-list.test.tsx`
- Resume → totals → sidebar render — `test/tui/resume-totals-sidebar.test.tsx`
- Title generation — `test/session-title.test.ts`, `test/tui/session-list.test.tsx`
- Lifecycle (bootstrap / suspend) — `test/tui/agent-lifecycle.test.tsx`

**Prompt + autocomplete:**
- Submit / slash dispatch / Ctrl+C — `test/tui/prompt.test.tsx`
- Mention + slash autocomplete — `test/tui/autocomplete.test.tsx`, `test/tui/autocomplete-overlap.test.tsx`
- Dialog state transitions — `test/tui/dialogs.test.tsx`, `test/tui/mode-state.test.ts`

**Rendering / display:**
- Markdown / theming — `test/tui/markdown-theme.test.tsx`
- Secondary page (article view) — `test/tui/secondary-page.test.tsx`, `test/tui/secondary-page-markdown.test.tsx`
- Tool arg rendering — `test/tool-renderers.test.ts`

**Hardening / boot:**
- ANSI / symlink rejection — `test/ui-hardening.test.ts`
- No-provider fallback — `test/tui/no-provider-boot.test.tsx`
- Open page — `test/tui/open-page.test.tsx`

---

## What's NOT covered (and why)

These are the known untestable corners. Each one has a real reason —
either upstream tooling, terminal-emulator quirks, or a genuine seam
mismatch. If you find a way to bring one of these in, update both
this list and the relevant `docs/TODO.md` Known Issue.

### Bun-segfault: `renderer.destroy()` while a `confirmFn` Promise is pending

The provider's `onCleanup` resolves any in-flight `confirmFn` to
`false` via `queueMicrotask`. Calling `setup.renderer.destroy()`
while a Promise consumer is still attached to the owner tree hangs
the test runner indefinitely on Bun 1.3.4 (originally segfaulted on
older Bun; current behavior is hang-without-output). Skipped
scaffold lives in `test/tui/permission-prompt.test.tsx`
(`test.skip("renderer.destroy() while pending...")`). Toggle
`.skip` → `()` to retry on a future Bun bump. Tracked in
`docs/TODO.md` Known Issues.

### Click-to-refocus across terminal emulators

Mouse-down on the conversation refocuses the prompt input via
`onMouseUp`. Whether the click event fires depends on the terminal's
mouse-tracking mode and how OpenTUI translates SGR sequences. Some
emulators don't deliver the events at all. Not testable from
`testRender` (no real terminal) and not deterministic in PTY tests
either. Tracked in `docs/TODO.md` Known Issues.

### Real provider / OAuth / LLM calls

Faked at the `Session` boundary by design. Real provider calls
require network, real credentials, and would make tests
non-deterministic / non-hermetic. The provider abstraction is
exercised at unit level (`kiro-refresh.test.ts` etc.); the TUI
above it is exercised against the fake. If a provider regression
escapes both layers, that's a seam-design problem worth fixing — not
a "we need real-network tests" problem.

### Backend per-model thinking-level auto-restore on `setModel`

The backend's `setModel` (in `src/backend/agent/index.ts:338-350`)
re-applies the per-model stored thinking level and the TUI wrapper
reads it back via `agentSession.getThinkingLevel()`. The fake
`Session` doesn't model per-model storage — its `getThinkingLevel()`
just returns whatever was last set via `setThinkingLevel`.
Modelling per-model storage in the fake would duplicate production
logic in test code. The invariant lives in the real backend; an
appropriate test would be a backend-unit test against `createSession`
directly, not a TUI test. Open work.

### Dynamic terminal resize

`testRender` accepts an initial `{ width, height }` but doesn't
expose a public resize API. Static-width assertions (e.g. narrow
terminal toast for the session list panel at width 70 in
`session-list.test.tsx:85`) work; mid-test resize would need an
OpenTUI fix or a different harness shape. Not blocking real testing
needs today.

---

## Recipes

### Adding a TUI E2E test

```tsx
import { afterEach, describe, expect, test } from "bun:test";
import { ev_agentStart, ev_messageStart, /* ... */ makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

describe("my feature", () => {
  test("does the thing", async () => {
    const fake = makeFakeSession();
    setup = await renderApp({ session: fake.factory, width: 120 });
    await setup.renderOnce();

    // 1. Drive input.
    await setup.mockInput.typeText("hello");
    setup.mockInput.pressEnter();

    // 2. (If needed) Emit synthetic events to simulate the assistant turn.
    fake.emit(ev_agentStart());
    // ...

    // 3. Assert against the rendered frame.
    const f = await waitForFrame(setup, "expected output");
    expect(f).toContain("expected output");
    // (Optional) Assert against recorded actions.
    expect(fake.calls.prompt).toEqual(["hello"]);
  });
});
```

Things to remember:

- **Width 120 for sidebar tests.** The sidebar gates on `dimensions.width >= 100`.
- **`Bun.sleep(20-40ms)` after submission.** Slash dispatch and `actions.prompt` go through async `persist`; give the microtask queue a tick before checking `fake.calls.prompt`.
- **Anchor on stable substrings.** Footer glyph `▣` to skip the prompt statusline; tool icon `⚙` for completed/error tool parts; `~` for pending. Avoid asserting on truncated labels — use the suffix that survives clipping.
- **For tool-state assertions, drive a real `actions.prompt()` first.** `applyToolResult` and `sweepPendingTools` gate on a non-null sessionId. Without a real prompt to satisfy `ensureSession()`, tool mutations silently no-op. See `permission-deny-flow.test.tsx`'s `seedSessionForToolStateMutation` helper.

### Adding a backend test

If the unit doesn't need the renderer, write a plain Bun test in
`test/`. Pattern files:

- Pure unit (no fixture): `test/command-slash.test.ts`, `test/frontmatter.test.ts`
- Persistence integration (real DB, seeded rows): `test/resume-repair.test.ts`, `test/resume-totals.test.ts`
- Provider with mocked OAuth: `test/kiro-refresh.test.ts`

### Flake debugging

Per `CLAUDE.md` Test Protocol: streaming-sensitive tests should pass 3
times back-to-back before commit. If a test flakes, prefer widening
the `waitForFrame` timeout or polling on a stable post-condition over
`Bun.sleep` band-aids. Don't ship a flaky test.

---

## Deferred layers

### Process-level smoke (`bun start` + PTY)

Spawn the real binary, attach a PTY, assert the open page renders.
**Not implemented.** Real value when:

- Inkstone gains a server boundary (none today).
- Inkstone gains an embedded shell or detached runtime materially
  different from `testRender`.
- A regression escapes the in-process harness in a way that maps to
  PTY-level behavior (terminal write codes, signal handling, exit
  cleanup).

Tracked in `docs/TODO.md` Future Work. Until any of those land, the
PTY harness would catch nothing the in-process layer doesn't already,
at meaningful test-runtime cost.

### Cross-OS / cross-emulator

The harness is OS-portable (Bun + OpenTUI's `testRender`). Real
terminal differences (Alacritty vs iTerm2 vs Konsole) only matter
for click-event delivery and ANSI sequence support — neither is
testable from `testRender`. Defer until a real cross-emulator bug
report lands.

---

## Cross-references

- `CLAUDE.md` § Test Protocol — when to write a test
- `CLAUDE.md` § Pre-Commit Protocol — `bun run check` + `bun run ci`
- `docs/ARCHITECTURE.md` — system-level component map; tells you what to test against
- `docs/TODO.md` Known Issues — current testable-but-skipped + untestable items
- `docs/SQL.md` — persistence layer contracts that backend tests pin
