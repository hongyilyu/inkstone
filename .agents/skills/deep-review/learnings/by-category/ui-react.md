# Learned rules — UI (React/Solid) (`ui-react`)

_40 rules. Loaded by the `dr-ui-react` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Don't replace a wired feature with a placeholder shell on the mainline  ·  `do-not-orphan-wired-feature-behind-placeholder-shell`
- **Severity:** blocking  ·  **Support:** 3  ·  **Seen in:** #10, #70, #2037
- **Rule:** When restructuring an app shell or repointing navigation, do not drop existing wired functionality (chat composer, message list, runtime props, SettingsPanel/provider-connection card) into an empty placeholder that renders only scaffold copy. Either preserve the working feature inside the new layout or gate the mock shell behind a flag, so the only path to a core user action (start a run, send a message, provider login) stays reachable. Cross-check e2e specs that target the old route/testids.
- **Detect:** A component/route diff deletes runtime/state wiring (props, send handlers, subscribeRun, message list) or repoints a nav target to a component rendering only placeholder text, and does not mount the prior feature component. Grep tests for the old route/testids. Ask: does this remove the only path to a core feature without replacement?

## Use the correct reactive primitive: effects for side effects, iterate memoized results directly  ·  `correct-reactive-primitive-for-side-effects-and-iteration`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #30672, #30678
- **Rule:** In a Solid-style reactive component, flag a createMemo whose body performs side effects (mutates state, calls setup/ensure) and whose return value is unused — use createEffect instead. Also flag array re-allocation (e.g. accessor().map(x => x())) applied to a reactive accessor inside JSX iteration. Only apply to Solid-style (createMemo/createEffect/For) code, not plain React useMemo.
- **Detect:** Flag a createMemo whose body performs side effects (mutates a Map, calls ensureX/setup) and whose return value is discarded. Flag .map(x => x()) or other array re-allocation applied to a reactive accessor result inside JSX (<For each={...}>) or a memo body.

## Keep cache/persistence keys and observed data reactive, not snapshotted at init  ·  `keep-cache-keys-reactive-not-init-snapshot`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #28938, #30678
- **Rule:** Do not invoke a reactive accessor once and store the result in a plain const at provider/component init when that value keys caches or persistence (e.g. const scope = server.scope()) — it captures a stale snapshot and leaks across later changes. Keep it a memo/accessor so derived caches re-key. Likewise, ensure a memo/effect that reads async/lazy store data (existing(), cache.get()) also reads a signal that changes when that data arrives (a version/loaded signal or reactive map), or it will silently serve stale data and never re-run.
- **Detect:** Flag where a reactive accessor is invoked once and assigned to a const used to key caches/persistence (previously a memo). Flag a memo/effect that reads a non-reactive lookup like existing()/cache.get() whose population is async, without also reading a related version/loaded signal — ask 'what re-triggers this when the data loads?'

## Keep a guard on map lookups in render; don't non-null-assert  ·  `guard-transient-map-lookups-no-non-null-assertion`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #28422
- **Rule:** Do not apply a non-null assertion (!) to a Map.get()/dictionary lookup keyed by a prop or signal in a render path. During reactive/virtualized updates the key can transiently miss, making the lookup undefined and crashing the render. Keep a Show when=.../early-return-null guard instead.
- **Detect:** Flag a non-null assertion (!) applied to a Map.get()/dictionary lookup keyed by a prop/signal in a render path, especially when the diff removes a surrounding Show/guard.

## Give interactive elements an accessible name and keyboard support  ·  `interactive-elements-need-accessible-name-and-keyboard`
- **Severity:** important  ·  **Support:** 5  ·  **Seen in:** #20, #27890, #28788, #30961, #31157
- **Rule:** Ensure interactive/labelled UI has a programmatic accessible name and keyboard operability: associate visible <label>s with their input via for/id (or aria-labelledby); give inputs that rely on placeholder an explicit aria-label or <label> (placeholder is not an accessible name); for div/span elements with role="button" or onClick, prefer a native <button>, or add tabIndex={0}, onKeyDown for Enter/Space, and appropriate aria state (e.g. aria-expanded); make any element that reveals content on focus actually focusable.
- **Detect:** Flag: (1) <label> siblings (not wrapping) an input with no for/htmlFor; (2) <input> with placeholder but no aria-label/aria-labelledby/associated <label>; (3) div/span with role="button" or onClick lacking tabIndex+onKeyDown, or a toggle missing aria-expanded; (4) a non-interactive div/span whose descendant relies on group-focus/focus-visible styling but has no tabindex/role/aria-label.

## Do not replace theme/config-driven values with hardcoded constants  ·  `preserve-theme-config-driven-values`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #112, #13224, #25375
- **Rule:** Flag hunks where an argument previously passed a theme/config/values()/token expression and now passes a hardcoded literal (hex, rgba, fixed px), or where overriding a themed selector silently drops inherited declarations. Only raise when a theme/config source clearly existed before; ignore brand-new styles with no prior token.
- **Detect:** Flag hunks where a call previously passed a values()/config/theme expression and now passes a hardcoded literal (RGBA.fromInts(0,0,0,0), fixed hex). When a diff adds a style rule for a selector already styled by a theme/base, ask which base declarations are not re-stated and whether dropping them is intentional.

## Don't render a trigger/action that resolves to nothing or an unavailable capability  ·  `no-clickable-control-that-does-nothing`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #20, #23407, #31191
- **Rule:** Do not ship a clickable control that has no effect. When broadening the condition that renders a menu/overflow trigger to include a new item type, verify at least one menu item is actually visible for that type (otherwise keep the trigger guarded). When a switch/lookup maps an optional/undefined or missing-capability state to a default branch, ensure that branch is inert/disabled (same shape as the explicit disabled state) rather than presenting an actionable affordance that does nothing.
- **Detect:** In a diff, find a Show/conditional that gained a new type in its predicate guarding a dropdown/menu trigger, and check whether all inner menu items exclude that same type (empty menu). In a switch(state?.status) ask: does the default case return an actionable result (label+run) while undefined/missing means the feature is unavailable?

## Wire new prop/context dependencies at every call site; don't hide missing wiring  ·  `wire-new-optional-prop-or-context-at-all-call-sites`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #13, #23407, #30574
- **Rule:** When required behavior starts depending on a new optional prop/callback, audit every existing call site that renders the component and pass it — optional-chaining a callback (props.onX?.()) hides missing wiring at compile time but silently drops the behavior at runtime. For reusable components, prefer injecting needed values as optional props (or reading context only in the route-level wrapper that guarantees the provider) rather than hard-requiring a context that may be absent in other routes/harnesses.
- **Detect:** A diff adds props.someCallback?.() for behavior that previously ran unconditionally, or adds a useContext/useXProvider() call for data only one route needs. Grep all usages of the component; ask whether every call site passes the prop, or whether the component is reused where the provider is absent.

## Initialize observer-derived state synchronously and re-run on all relevant changes  ·  `initialize-observer-derived-state-synchronously`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #28664, #32082
- **Rule:** When wiring a ResizeObserver/IntersectionObserver/MutationObserver, trigger an initial measurement immediately after creating it rather than relying on the first callback, which may be delayed or never fire (offscreen, display:none, RO unavailable). Also confirm any state set from a layout/measurement callback re-runs on all relevant input changes (children positions/sizes), not only on resize, so the derived value can't desync until an unrelated event fires.
- **Detect:** Flag where measurement state is updated only inside an observer callback with no explicit initial measurement call right after the observer is created; and flag setState inside layout/measurement callbacks whose inputs (children sizes/positions) may change without re-triggering the callback.

## Apply gating conditions consistently across a group of derived values  ·  `consistent-gating-across-sibling-derived-values`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #132, #30678
- **Rule:** When a flag suppresses some derived UI indicators (e.g. activeServer() gating), apply the same gating to all related derived values in the group and avoid reading inactive/underlying stores unconditionally; otherwise sibling indicators (isWorking, tint) stay live for inactive entities and the UI state becomes incoherent.
- **Detect:** Within one factory/component, flag where several derived memos guard on a condition (e.g. activeServer()) but a peer memo computing related UI state omits the guard.

## Use CSS visibility (not conditional render) for purely visual collapse  ·  `visual-collapse-keep-mounted`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #137, #27890
- **Rule:** Flag a Show/ternary that unmounts content whose hiding is purely visual/collapse, where unmount/remount would lose internal state, scroll, or focus — prefer CSS visibility ([hidden]/display:none/max-height:0). Only raise when state/scroll/focus loss is plausible; do not flag genuine conditional rendering of distinct content or unmounting done deliberately to reset state.
- **Detect:** Flag <Show when={!minimized/collapsed}> or {!collapsed && ...} wrapping content whose collapse is described as visual; ask whether unmount/remount would lose scroll/focus/internal component state.

## Don't render <img> with an empty src  ·  `no-empty-img-src`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #30722
- **Rule:** Do not render an <img> with src="" or a fallback to empty string when the URL is missing — it triggers a spurious request to the current document URL and shows a broken-image icon. Omit the src attribute entirely, render no image, or use a harmless placeholder like src="data:,".
- **Detect:** Grep for src="" or src="${x ?? ""}" patterns in img-building strings/JSX; ask whether an empty src can be produced.

## Add min-w-0 to a truncating flex child so long tokens don't overflow siblings  ·  `add-min-w-0-to-truncating-flex-child`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #79, #416
- **Rule:** A flex child using truncate/ellipsis (or holding a sibling that must stay visible) needs min-w-0, otherwise its default min-width:auto refuses to shrink, and a long unbroken token (URL/ID/path) pushes siblings (copy button, icon) out of a fixed-width overflow-hidden parent.
- **Detect:** A flex child with `truncate` and `flex-1` (or text + a sibling button) inside a fixed-width / overflow-hidden parent, whose class list lacks `min-w-0`. Ask: can a long unbroken token here push siblings outside the parent?

## Keep status/privacy labels honest about the scope the code can guarantee  ·  `honest-status-privacy-labels-matching-actual-scope`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #90, #2426
- **Rule:** Status/privacy UI labels must not assert a scope the code can't guarantee. If a tool may operate on a different target than the current context (read_thread accepting an arbitrary thread id), use a neutral label ('Reading a thread') rather than one claiming the current scope ('Reading this thread'), unless the UI actually has the target identity.
- **Detect:** Hardcoded present-tense tool/status labels containing 'this' or current-context scope words; cross-check whether the tool accepts an id/param pointing elsewhere. Ask: does the label claim a scope the tool input can violate?

## Add new translation keys to every locale dictionary, not just en/zh  ·  `add-new-translation-keys-to-all-locales`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #28442
- **Rule:** When a diff adds user-facing translation keys to one locale dictionary, flag keys that are absent from the other locale files in the same directory (silent English fallback). Limit to obvious co-located locale-file sets; do not flag when the project uses runtime extraction or a single source-of-truth locale.
- **Detect:** When a diff adds keys to one locale file (e.g. en.ts), check whether the same keys appear in the other locale files in the same directory. Flag keys present only in en (and maybe one other) but missing from the rest.

## Bump invalidation/version signals on removal as well as creation  ·  `bump-version-signal-on-removal-too`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #28938
- **Rule:** If consumers rely on a version/counter signal to refresh a derived collection, bump it on both additions and removals (onCreate and onDispose/evict). Bumping only on creation means removed entities never invalidate dependent memos and UIs keep rendering stale entries.
- **Detect:** Flag a version/counter signal incremented in an onCreate/add hook but not in the corresponding onDispose/remove/evict hook, while memos read that signal to recompute lists.

## Capture FLIP 'first' measurement before the DOM reflects the new content  ·  `flip-measure-before-dom-updates`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #26282
- **Rule:** For FLIP-style width/size transitions, capture the previous (first) measurement BEFORE the framework updates the DOM to the new value. If the rendered content is bound directly to the same reactive source the animation effect depends on, the DOM is already at the new value when measured and text-only changes won't animate from the prior size; store the displayed value in state and update it only after measuring the old size.
- **Detect:** In a Solid/React effect that measures an element's current size as the animation's starting point, check whether the rendered content is bound to the same reactive source the effect depends on. Ask: is 'first' measured after the DOM already reflects the new content?

## When enabling a global layout flag, apply the compensation to every full-viewport surface  ·  `apply-global-layout-flag-to-all-surfaces`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #25833
- **Rule:** When a diff enables a global layout change (e.g. viewport-fit=cover exposing safe-area insets, or any global flag affecting positioning), audit every fixed/overlay/full-viewport surface — sidebars, dialogs, toasts, loading/error screens — and apply the compensating inset/padding handling to each, not just the root container.
- **Detect:** If a diff adds viewport-fit=cover or env(safe-area-inset-*) handling to one element, grep for other position: fixed, h-dvh/100dvh/w-screen, or overlay components and ask whether they also account for the insets.

## Check for overflowing absolutely-positioned descendants before adding overflow-hidden  ·  `overflow-hidden-vs-overflowing-children`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #31462
- **Rule:** Before adding overflow-hidden or a clipping radius to a container, check for absolutely-positioned descendants that intentionally overflow it (translateX(50%), negative offsets, resize handles). Move the clipping/background to an inner surface and keep the outer element unclipped as the positioning context so the overflowing control isn't cut off.
- **Detect:** A diff adds overflow-hidden (or a clipping radius) to a container class. Search the component for descendants with position: absolute plus translate/negative-offset classes; ask whether the new clipping would cut off an overflowing control.

## Render referenced sprites/symbols in markup, not only via onMount  ·  `ssr-safe-sprite-injection`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #26950
- **Rule:** An SVG <use href="#symbol"> (or any reference to a DOM-injected element) must not depend on injection that happens only in onMount/useEffect, since that doesn't run during SSR and server-rendered pages show missing icons until hydration. Render the sprite as part of the document markup (a single root/body-level component) so symbols exist at first paint.
- **Detect:** Flag <use href="#..."> or references to DOM-injected elements where the injection happens in onMount/useEffect only, with no SSR/markup-time rendering of the referenced element.

## Guard late async UI updates against staleness  ·  `guard-late-async-ui-updates-against-staleness`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #25615
- **Rule:** When an async handler resolves and then mutates shared UI (dialog.replace, setState), verify the originating surface is still active before applying the update — track whether the dialog/component is still open/mounted (or capture a token/id) and skip the update if the user dismissed or navigated away. An unconditional update can reopen or clobber unrelated UI state.
- **Detect:** Flag await <promise> followed by dialog.replace/setState with no check that the dialog/component is still mounted/active; ask whether a late resolution can clobber unrelated UI state.

## Add min-h-0 to a flex child that is meant to be the scroll area  ·  `add-min-h-0-to-scrollable-flex-child`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #12
- **Rule:** A scrollable flex child (flex-1 overflow-y-auto) inside a flex-col overflow-hidden parent needs min-h-0 (on the child or parent). Without it the default min-height:auto lets the child expand to full content height, so overflow-y-auto never scrolls, the bottom is clipped, and scrollTop=scrollHeight auto-scroll effects fail.
- **Detect:** A flex child with `flex-1 overflow-y-auto` inside a `flex flex-col overflow-hidden` parent where neither has `min-h-0`. Ask: when content exceeds the viewport, can this element shrink to scroll, or will it expand and clip?

## Remove a visually-collapsed zero-size panel from the tab order and a11y tree  ·  `remove-collapsed-zero-size-panel-from-a11y-tab-order`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #20
- **Rule:** When a panel is collapsed by shrinking its CSS grid track to 0px (or hiding via overflow) while staying mounted, also remove it from the accessibility/tab order: unmount it, or mark it inert / aria-hidden, so keyboard and screen-reader users cannot tab into focusable controls in the invisible region.
- **Detect:** TSX with grid-template-columns interpolating a `collapsed ? "0px" : "..."` ternary, or an overflow-hidden wrapper whose child stays mounted. Ask: when collapsed, is the panel still rendered with focusable buttons/inputs and no inert/aria-hidden?

## Effects acting on async-loaded data must depend on that data, not an empty deps array  ·  `effect-on-async-data-must-depend-on-that-data`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #20
- **Rule:** An effect (useEffect/useLayoutEffect) that acts on data from an async hook must include that data (the loaded object or a derived value like conversation?.messages?.length) in its dependency array, not []. An empty deps array fires once on mount before the async hook resolves and never re-runs when data arrives (e.g. auto-scroll-to-bottom firing before messages render). Note: react-hooks/exhaustive-deps catches the missing dep only when the value is referenced in the effect body and the lint rule is enabled — flag this even when it is suppressed or the dependency is derived.
- **Detect:** useEffect/useLayoutEffect with `}, []);` whose body references a variable destructured from a useX() hook returning { data }. Ask: does the effect read async-loaded data but never list it as a dependency?

## Don't seed useState synchronously from async data that may be empty on first render  ·  `do-not-seed-usestate-from-async-data-that-may-be-empty`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #20
- **Rule:** Don't seed useState from async-loaded data that may be empty on first render (const initial = list.find(...) ?? list[0]; useState<Model>(initial)) and then dereference selected.name — on first render the list is empty so the seed is undefined and the dereference crashes, and state never re-syncs when data arrives. Store the selected id and derive the object each render with fallbacks, or type state as T | undefined and guard dereferences, re-syncing when data loads.
- **Detect:** useState<T>(list.find(...) ?? list[0]) where list comes from data ?? [] of an async hook, followed by non-optional selected.X accesses. Ask: can list be empty on first render, making the seed undefined and the later dereference unsafe?

## Document-level key shortcuts on printable keys must ignore editable targets  ·  `global-key-shortcut-must-ignore-editable-targets`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #16
- **Rule:** A document/window keydown handler that triggers an action on a bare printable key (if e.key === '1') must check whether the event target is an editable element (input/textarea/select or isContentEditable) before invoking the action, so normal typing into a field doesn't fire the global shortcut.
- **Detect:** Document/window keydown listeners checking e.key === '<char>' then calling an action, with no check of e.target being INPUT/TEXTAREA/SELECT/contenteditable. Ask: can this shortcut fire while the user is typing in a field?

## Don't place an absolute overlay control over a sibling's interactive elements  ·  `do-not-overlay-absolute-control-over-sibling-interactive-elements`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #17
- **Rule:** An absolutely-positioned control (e.g. absolute top-3 right-3 z-10) inside a relative grid/flex container can cover a sibling component's interactive elements at the same corner offset, blocking clicks — especially with dynamic content width. Only flag when the same relative container demonstrably holds another component's interactive controls (button/input) near that same corner; prefer reserving layout space over absolute overlays. Do not flag absolute overlays that sit over non-interactive area or have no sibling controls at that offset.
- **Detect:** A newly-added element with className containing 'absolute' + top/right/bottom/left + z-index inside a 'relative' container that also holds another component's controls near the same corner. Ask: does the overlay sit over interactive buttons of a sibling at that offset?

## Disable pointer events on interactive handles when their panel is collapsed  ·  `disable-pointer-events-on-collapsed-panel-handles`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #32169
- **Rule:** When a panel collapses to zero height/width but its DOM stays mounted, every interactive child overlapping the collapsed strip (resize handle, drag strip, button) must stop intercepting POINTER events — not just leave the tab order (this is the gap #196 leaves: #196 covers focus/tab order, this covers mouse/click/cursor). Putting the handle as a sibling OUTSIDE the element that receives pointer-events:none/inert (or gating only inert/tabindex, which fixes keyboard but not mouse) lets it keep capturing clicks over the now-zero-size region. Detection: a resize/drag handle rendered outside the wrapper that gets pointer-events-none/inert/aria-hidden when a panel's open/expanded signal is false (or whose grid/flex track collapses via a `collapsed ? "0px" : ...` ternary). Ask: while collapsed, does the handle still receive pointer events because pointer-events:none was scoped only to the panel body, not the handle? Fix by applying pointer-events:none to the handle (or moving it inside the inert layer) on the same collapsed condition.
- **Detect:** A resize/drag handle or interactive element positioned outside the wrapper that gets pointer-events-none/inert when a panel's open signal is false; ask whether the handle still intercepts pointer events while collapsed.

## Feed the full value to title/aria-label; truncate only the visible text  ·  `full-value-for-title-and-aria-label-truncate-only-visible`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #32207
- **Rule:** When a label is visually truncated, drive only the visible text from CSS truncation (e.g. `truncate`/`text-overflow: ellipsis` or a `.slice(0,n)+"…"` display string) and pass the FULL untruncated value to `title=`/`aria-label=`. Passing an already-shortened string to title/aria-label hides the full value from tooltips and screen readers. Detection: flag a JSX element whose `title=`/`aria-label=` is bound to the same expression that produces its visibly-truncated text — specifically when that expression is a prop named like `displayLabel`/`shortLabel`/`truncated*`, or the output of a slice/truncate/ellipsis helper. Ask: is the full (untruncated) value available in scope and passed separately to the accessible/tooltip attribute? Do NOT flag when title/aria-label already receives a distinct full-value source, or when the visible text is the full value and truncation is purely CSS on the same complete string (CSS truncation does not shorten the bound attribute).
- **Detect:** A component receives an already-truncated/displayLabel string and uses that same prop for both visible text and title=/aria-label=; ask whether the full value is available and should be passed separately for the accessible/tooltip text.

## Refresh dynamic attributes on DOM nodes deliberately preserved across a diff/morph  ·  `refresh-dynamic-attributes-on-preserved-morphed-nodes`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #32331
- **Rule:** When a reconciler intentionally keeps an existing DOM element mounted instead of replacing it — morphdom onBeforeElUpdated returning false, a key/id-preserved node, htmx/Alpine out-of-band or x-html swap, or a manual DOM patch — its dynamic attributes (aria-label, title, data-tooltip, state/`copied` classes, alt text) do NOT update unless you patch them explicitly. Preserving the node and refreshing its attributes are two separate responsibilities. Detection: find a keep/skip-update branch (onBeforeElUpdated => false, a `key`/`id`-match short-circuit, an `if (sameNode) return` patch guard) covering an interactive or labeled element, then ask: when the i18n label, tooltip, or transient state for that element changes, is some other code path explicitly writing the new attribute onto the preserved node? If not, the label/title goes stale.
- **Detect:** Find a `return false` in morphdom onBeforeElUpdated (or any keep/skip-update branch) for an interactive element; ask whether that element's aria-label/title/tooltip/copied-state attributes are updated elsewhere when i18n labels or state change.

## Guard form/action submit against re-entry while a save is pending  ·  `guard-form-submit-against-reentry-while-saving`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #135
- **Rule:** A submit handler for a non-idempotent mutation must short-circuit re-entry while a prior save is in flight. The handler itself must early-return on the saving/pending flag (`if (saving) return;` before calling the mutation) — disabling the submit control (`disabled={saving}`) is complementary, NOT a substitute, because pressing Enter in a form field re-fires `onSubmit` even when the submit button is disabled. Flag a `<form onSubmit={h}>` / submit handler that calls `onSubmit()`/the mutation with a `saving`/`pending`/`isPending` flag in scope but no `if (saving) return` guard at the top of the handler.
- **Detect:** A form onSubmit/handler that unconditionally calls onSubmit()/the mutation with a `saving`/`pending` state in scope but no `if (saving) return` guard and no disabled={saving} on the submit control.

## Call preventDefault/ownership-claiming side effects before the first await in an event handler  ·  `suppress-default-action-before-async-boundary`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #32479
- **Rule:** In an event handler that intends to fully own an action (e.g. suppress the platform/terminal default via preventDefault), any await before that suppression lets the default behavior fire during the async gap, causing duplicated or unwanted side effects. Move preventDefault (or the equivalent claim) before the first await on every path that means to take over handling.
- **Detect:** In an event/keypress/paste handler, find an `await` that precedes `event.preventDefault()` (or stopPropagation/the suppression call) on a path that handles the event itself. Compare against sibling paths in the same handler that call preventDefault synchronously. Ask: can the default action run during the await, producing a duplicate insertion/navigation?

## A derived edit/override indicator must be gated on the same condition that submits the edit  ·  `derived-edit-indicator-must-match-submit-condition`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #189
- **Rule:** A UI indicator that signals a row has been edited/overridden (an "Edited" badge, a dirty dot, a modified marker) must be computed under the exact same condition that determines whether the edit is actually submitted. If the badge is derived only from "a draft exists and differs from the seed" but the submit path additionally requires the row to be in an accept/active stage (skipping edited_fields for rejected/disabled rows), then a rejected/inactive row can display "Edited" while no correction is ever sent — a dishonest indicator. Add the stage/accept gate (and any other submit precondition) to the derived flag so the badge can only show when the edit will genuinely take effect.
- **Detect:** Find a derived boolean for an edited/modified/overridden badge built from draft-vs-seed difference (e.g. `draft !== undefined && buildEditedFields(seed, draft) !== undefined`) and compare it to the submit/decision builder for the same row. Ask: does the submit path apply this edit unconditionally, or does it also require an accept/enabled stage that the badge expression omits — letting a rejected/disabled row show "Edited" while sending no correction?

## Reset local per-item draft/staging state when the component's mount key is coarser than the item identity it stages  ·  `reset-local-staging-state-when-keyed-identity-is-coarser-than-item-identity`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #188
- **Rule:** When a long-lived component accumulates local draft/staging state (a per-row decision buffer, an edit form, accumulated selections) that is scoped to a specific item identity, but the component is mounted/keyed by a COARSER identity (a parent key that does not change when the item does), the local state survives across item switches and leaks one item's choices into the next. Add an effect that resets the local state whenever the fine-grained item identity changes (useEffect(() => setBuffer(initial), [item.id])), or remount by keying on the fine-grained identity. This is the converse of the carve-out that says not to flag a reset when the parent already keys on the exact identity: here the key (e.g. a run/session id) is coarser than the staged identity (e.g. a proposal/record id), so a fresh instance is NOT guaranteed and an explicit reset is required.
- **Detect:** Find a component holding useState that accumulates per-item decisions/edits (a buffer/draft/selection keyed by an inner id) where the only reset is on an unrelated signal (status) or none. Check the parent's key={...}: if it keys on a coarser id (runId/sessionId/threadId) than the per-item id the state is scoped to (proposalId/recordId), ask: when a new item with the same coarse key renders into this still-mounted component, does the stale buffer carry over? If yes and there is no useEffect(reset, [fineId]) and no key={fineId}, flag it.

## Route user-facing strings (including aria-labels) through the existing i18n helper  ·  `route-user-facing-strings-through-i18n`
- **Severity:** nit  ·  **Support:** 6  ·  **Seen in:** #492, #28420, #28442, #31208, #32331
- **Rule:** In a file that already imports/uses an i18n helper (t(), language.t, useLanguage().t), flag newly added bare user-facing string literals — JSX text nodes and aria-label/title/placeholder/alt attributes — that sit alongside sibling strings already routed through the translation function. Do not flag files with no i18n helper, or non-user-facing strings (keys, test ids, class names, console logs).
- **Detect:** In a file that imports/uses a t()/language.t()/useLanguage i18n helper, grep changed hunks for bare string literals in JSX text nodes or in aria-label=/title=/placeholder=/alt= attributes (e.g. aria-label="..."). Flag any English literal sitting next to sibling strings that DO use t().

## Don't hardcode magic numbers that shadow configurable layout/timing values  ·  `no-magic-numbers-for-configurable-layout-or-timing`
- **Severity:** nit  ·  **Support:** 3  ·  **Seen in:** #369, #26282, #27890
- **Rule:** Flag a literal-ms setTimeout used to end/clean up a CSS transition whose duration is controlled by a CSS variable/class (use transitionend or derive the timeout from the computed duration). Also flag a calc() that subtracts a hardcoded px literal that demonstrably duplicates an existing named layout variable. Do not flag arbitrary numeric literals that have no existing named counterpart.
- **Detect:** Flag calc() expressions subtracting a hardcoded pixel literal (e.g. '- 140px') from a layout dimension, and setTimeout calls with a literal ms value used to end/clean up a CSS transition whose duration is set by a CSS variable or class.

## Provide a fallback for derived values that can be undefined/stale  ·  `fall-back-instead-of-rendering-undefined-state`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #132, #28032
- **Rule:** Flag a derived/memoized display value computed from a lookup that can return undefined (Map.get, list.find, last-item access) used to drive UI without a ?? fallback to the current/selected value. Only raise when the undefined branch yields a visibly wrong or neutral state, not where undefined is already handled downstream or is the intended empty state.
- **Detect:** Flag a createMemo/derived value computed from a lookup that can return undefined, used without a ?? fallback; ask whether the undefined branch produces a visually wrong/neutral state.

## Don't flag a child for not resetting internal state on identity change when a parent keys it for remount  ·  `dont-flag-child-state-reset-when-parent-keys-remount`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #153, #162
- **Rule:** Before flagging a component (editor/form) for failing to reset draft/baseline/local state when its target identity changes, check whether a parent mounts it with `key={<identity>}`. A key tied to the entity id forces React to fully unmount and remount the subtree on every identity switch, so useState/hook state is always fresh and an internal reset effect is unnecessary. Treat the absence of an internal reset as correct in that case.
- **Detect:** When tempted to flag 'editor/form does not reset draft/baseline/local state on prop or entity change', first grep the mount site (route or parent owning selection) for `key={selected.id}` / `key={entity.id}` / `key={<changing-identity>}`. If the key equals the changing identity, React fully unmounts+remounts on each switch, so useState/hook state is already fresh — do NOT flag, and treat the missing reset effect as correct. Corroborate by confirming the child has no reset useEffect of its own. Ripgrep gotcha: search .tsx with `--type=ts` or `--glob '*.tsx'`; `--type=tsx` errors with 'unrecognized file type' and silently finds nothing, which is how the original reviewer missed the keyed mount.

## Provide a cancel/close/ESC path for editing overlays and modals  ·  `modal-needs-cancel-path`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #30253
- **Rule:** When a diff opens an editing/modal overlay gated by a boolean signal, flag if no handler resets it (cancel button, ESC keydown, or backdrop click) and the only exit is the save callback. Skip overlays that are intentionally non-dismissable (blocking confirmations) or where ESC/close is provided by a shared dialog wrapper.
- **Detect:** When a diff adds an overlay/modal gated by a boolean signal set true, check whether any handler sets it back to false (cancel button, ESC keydown, backdrop click); flag if the only exit is the save callback.

## Gate debounced search results on input identity before showing or acting on them  ·  `gate-debounced-results-on-input-identity`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #139
- **Rule:** Display and selection of debounced-search results must be tied to the SAME query value the data was fetched/keyed under, not to the faster-updating live input. When a hook is keyed on `debouncedQuery` (e.g. useQuery(["search", debouncedQuery])) but a list is built/gated using the immediate `query`, the two diverge during the debounce window: stale hits from the previous debounced value render under the new input, and a click/Enter can navigate to the wrong target. Fix by mapping the results under the debounced value (`const dq = debouncedQuery.trim(); dq ? hits : []`) — i.e. keep the rendered group consistent with the query its data belongs to. (Equivalently, carry the query alongside the data, or gate on `debouncedQuery === query`; prefer gating on the debounced value to avoid blanking the group on every keystroke.)
- **Detect:** Flag a component that maps `data?.hits`/results from a hook keyed by a `debouncedQuery` into a list while the rendered/selectable items aren't gated on `debouncedQuery === query`. Ask: during the debounce delay can a stale result be clicked and navigate to the wrong entity?
