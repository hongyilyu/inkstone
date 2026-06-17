# Learned rules — Correctness & logic (`correctness`)

_76 rules. Loaded by the `dr-correctness` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Hand-rolled shell tokenizers must honor backslash-escape and single-quote semantics  ·  `shell-tokenizer-must-honor-quote-and-escape-rules`
- **Severity:** blocking  ·  **Support:** 4  ·  **Seen in:** #4732, #4747, #4749, #4750
- **Rule:** A char-by-char shell/quote parser must follow POSIX rules: backslashes are literal inside single quotes (do not escape the closing single quote), and outside single quotes a quote preceded by an odd number of backslashes is literal and must not toggle quote state. Add tests for trailing-backslash-then-quote cases. Likewise, redirect-normalization regexes must require the fd digit adjacent to >, must not rewrite escaped operators (\>), and must not treat a token followed by punctuation (\b before .) as a boundary.
- **Detect:** A loop with inSingleQuotes/inDoubleQuotes that flips state on a quote without an isEscaped/backslash-count check or without skipping escape semantics inside single quotes; a redirect regex like /^([12&]?)\s*(>>?)/ allowing whitespace before >, or matching token\b, or not checking isEscaped on the operator.

## Verify protocol-sensitive escape sequences and shell leading-statement constraints  ·  `verify-protocol-sensitive-bytes-and-leading-statement-rules`
- **Severity:** blocking  ·  **Support:** 3  ·  **Seen in:** #28369, #31985
- **Rule:** Treat terminal control-sequence bytes (DCS/OSC/tmux passthrough ESC-quoting) as protocol-sensitive and verify changes against the protocol before altering escape bytes. Don't prepend statements before user-supplied script text for shells with first-statement rules (PowerShell `param()`/`#requires`); wrap the user command separately. Flag diffs altering escape bytes in control-sequence templates or interpolating a user command after other statements.
- **Detect:** Flag diffs removing/altering escape bytes (`\x1b`, `\\`) inside terminal control-sequence template strings (DCS/OSC/tmux). Flag template strings interpolating a user `command` after other statements (`...prelude...\n${command}`) for shells with leading-statement constraints.

## Don't return synchronous success for an unawaited async operation that can fail  ·  `no-async-fire-and-forget-with-fake-sync-success`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #13, #27913
- **Rule:** A function must not return a hardcoded success value immediately after kicking off an unawaited async operation whose failure (e.g. `.catch(() => false)`) the caller never observes. Either await it and derive the return from its result, or change the contract to void/Promise. Flag `return true` following a fire-and-forget promise chain ending in a failure-swallowing catch.
- **Detect:** Find a function that starts a promise chain (no await, not returned) ending in `.catch(...return false)` then unconditionally `return true`. Ask: does the caller treat the boolean as success even though the operation may fail asynchronously?

## A persisted setting must be read by the path it is meant to influence  ·  `persisted-setting-must-have-effective-consumer`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #68, #4795
- **Rule:** When a handler persists a user preference/setting, verify a read path actually applies it where it matters (run creation, dispatch, rendering). A setter whose key is only read back by its own get/echo handler — while the behavior-driving path still uses a hardcoded default — is a no-op feature that merely appears to work.
- **Detect:** A diff adds set_setting/persist for a key; grep for get_setting(<key>). Is any consumer OTHER than the matching get/echo handler reading it? If the behavior path (run/post_message building the workflow) still uses a hardcoded default, the setting is never applied.

## Substitute a text placeholder when stripping image content blocks  ·  `image-block-removal-needs-text-placeholder`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #120, #492
- **Rule:** When filtering image content blocks out of a message or tool result sent to an LLM provider, do not allow the content array to become empty: substitute an explanatory text block, because many providers require at least one content block. When dropping images due to a cap, document the eviction policy. Flag content.filter(c => c.type !== 'image') (or equivalent) whose result is used directly with no fallback text when length can reach 0.
- **Detect:** Look for content.filter((c) => c.type !== "image") (or similar image removal) whose result is used directly without a fallback text block when length becomes 0; also flag missing-comment trimming caps.

## Reload/refresh must reproduce all relevant startup side effects  ·  `reload-must-reproduce-startup-side-effects`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #4913, #5332
- **Rule:** When implementing a reload/refresh/hydrate command, audit the startup sequence and decide explicitly which steps it reproduces. Partial reloads that re-read config/extensions but skip associated side effects (package installs, dynamically registered providers/models) leave the runtime partially updated; merge in items registered after the original snapshot rather than overwriting with a stale base.
- **Detect:** A reload/hydrate handler that re-reads config/extensions but skips startup-only steps (package install, register*()), or a hydrate method that starts from a load-time-only field (this.baseModels) and reassigns the live collection, ignoring runtime register*() additions.

## Validate (don't silently drop) a context qualifier when parsing qualified paths/identifiers  ·  `validate-context-qualifier-before-stripping`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #23407
- **Rule:** When a parser extracts a context qualifier (host, distro, tenant, account) from a qualified path/identifier and strips it, validate the qualifier against the active/requested context and reject on mismatch rather than silently reinterpreting it as the current context. Flag parsers that capture a qualifier (e.g. match[2]) but build the result from only the remaining subpath.
- **Detect:** Find a parser that captures a qualifier (match[2] as distro/host/tenant) but builds its result using only the remaining subpath. Ask: is the captured qualifier compared to the active context before being dropped?

## Only use binary search when the collection is provably sorted by the search key  ·  `binary-search-requires-proven-sort-invariant`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #27913
- **Rule:** Only replace findIndex/linear scan with binary search when the array is provably sorted by the exact key selector at every call site (lookup, rollback, insert). If the sort invariant isn't guaranteed, keep the linear scan or enforce/assert the invariant. Flag diffs replacing `findIndex`/`.find` with a binary search where the array's sort order by that selector isn't guaranteed.
- **Detect:** Flag a diff replacing `findIndex`/`.find` with `Binary.search(arr, key, selector)`; ask whether `arr` is guaranteed sorted by that exact selector here, and check both removal and rollback/insert sites using the same array.

## Excluding a provider from a capability gate requires an alternate handling path  ·  `capability-gate-exclusion-needs-alternate-path`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #4795
- **Rule:** When adding a provider/case to a negative capability gate (e.g. supports... && !isNewProvider), verify there is an alternate path that still honors that capability for the excluded case; disabling the gate with no replacement silently turns the user's setting into a no-op. Flag a new && !isX term added to a capability chain when grep finds no X-specific handling for that capability elsewhere.
- **Detect:** A capability flag computed as a chain of !isProviderA && !isProviderB gains a new && !isProviderC term, and grep shows no provider-specific handling for ProviderC's reasoning/feature elsewhere.

## Bound a computed value at the producer to the downstream strict validator's accepted range  ·  `bound-generated-value-to-downstream-validator-range`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #172
- **Rule:** When code computes a value (date year, length, id) that is later checked by a strict-format or range validator inside an enclosing transaction, bound or reject the value at the point it is generated. An out-of-range value produced upstream and rejected downstream aborts/rolls back the whole transaction instead of gracefully no-oping; also avoid lossy narrowing casts on a value that can exceed the target type's range.
- **Detect:** Find arithmetic that produces a value (date year via interval*unit, a length/count/id) which is later serialized/formatted and handed to a strict-format or range validator (fixed-width like 4-digit year, range CHECK, length limit) whose failure rolls back an enclosing multi-step write/transaction. Ask: can the computed value exceed the validator's accepted range, and is it clamped or None-returned at the point of generation (before formatting), so an out-of-range case gracefully no-ops instead of aborting the whole tx? Secondary tell: a lossy narrowing cast (`x as u32`/`as i32`/`as u16`) on a value that can exceed the target type's range — but the primary signal is the producer/downstream-validator range mismatch, not the cast alone.

## Recursive key-stripping rewrites must not treat user-named map values as keywords  ·  `tree-rewrite-must-distinguish-map-value-keys-from-keywords`
- **Severity:** blocking  ·  **Support:** 1  ·  **Seen in:** #160
- **Rule:** A recursive transform that deletes or rewrites object keys by name must distinguish nodes whose keys are a fixed vocabulary (keywords) from nodes that are maps of user/domain-controlled names. Applying the keyword rewrite uniformly to every object strips legitimate map entries that merely share a keyword's name, corrupting the output (and, for normalizers/comparators, silently hiding real differences).
- **Detect:** Flag a recursive walk that does `delete out[KEYWORD]` or rewrites a fixed key name on every visited object without tracking parent context (no inSchemaMap/parentKey/inMap flag threaded through recursion). For JSON-Schema/OpenAPI-like trees, check whether values under map-keyword parents (properties, patternProperties, $defs, definitions, dependentSchemas) are walked as keyword-bearing schema nodes rather than as opaque name->subschema maps. Acute for normalizers/comparators: a stripped user field silently hides real drift. Ask: can a domain/user field legitimately be named the same as the stripped keyword, and would the rewrite then corrupt it?

## Parse and validate external/formatted strings robustly at the boundary  ·  `validate-and-parse-external-strings-robustly`
- **Severity:** important  ·  **Support:** 10  ·  **Seen in:** #118, #171, #23407, #25773, #26095, #26535
- **Rule:** Validate externally-supplied formatted strings at the boundary and fail on malformed input (e.g. 'provider/model' must yield non-empty halves). Prefer real parsers over incidental delimiters: URLSearchParams for URL fragments, shell-word parsing for argv, and extract the executable token before basename-matching a shell. Don't over-restrict values passed as discrete argv elements. Flag `.split` destructuring of user strings without both-half checks and ad-hoc `&`/`=`/`:` splitting of structured input.
- **Detect:** Flag `.split("/")`/destructuring of user strings without checking both halves non-empty; `.split("&")`+`.split("=")` over URLs; `.split_whitespace()`/`.split(' ')` building argv for spawn/Command; `path.basename(shell)` where shell may contain flags; `str.includes(':')`/`split(':')` over free-form text; and strict allowlist regexes (`/^[A-Za-z0-9_.-]+$/`) rejecting values passed as separate argv entries.

## Preserve guards, side effects, ordering, and semantics when refactoring/extracting  ·  `preserve-behavior-and-side-effects-when-refactoring`
- **Severity:** important  ·  **Support:** 9  ·  **Seen in:** #105, #135, #972, #3375, #19961, #25663
- **Rule:** When refactoring or extracting, preserve existing early-return guards, side effects, and ordering. Flag a removed `if (!exists) return` that gated a side effect, removal of a render-time call establishing subscriptions, changed ordering of caching-sensitive assembled content, and a function whose body no longer matches its name (e.g. stops filtering by role). When a shared resolver gains a global 'last used' fallback, audit resume/restore callers.
- **Detect:** Compare pre/post control flow: flag a removed `if (!exists) return` early-return that gated a side effect. Flag removal of `{someFn() ?? ""}` JSX where the name implies sync/subscribe. Compare relative order of assembled prompt pieces before/after. Compare a function's name/test description against its body (maps all items vs filtering by the implied role). When a shared resolver gains a global fallback, enumerate callers and flag resume/restore/historical paths.

## Apply a fix, guard, or normalization to every code path with the same pattern  ·  `apply-fix-and-guards-to-all-sibling-paths`
- **Severity:** important  ·  **Support:** 8  ·  **Seen in:** #135, #171, #21559, #23214, #26596, #27913
- **Rule:** When you add a fix, guard, validation, normalization, or new parameter to one occurrence of a repeated pattern, apply the identical change to every sibling occurrence sharing that pattern (including flag-gated variants and all on* handlers), or annotate why one is intentionally different. Grep the diff's surrounding code for the same literal/pattern and confirm each got the change.
- **Detect:** Grep the repo for the literal/pattern being patched (e.g. `filetype="markdown"`, a status check, a guard) and confirm every occurrence got the change. For a new disabled prop, check all on* handlers return early when disabled. For a new context/env param, check every internal call of the same family forwards it. For experimental Flag.* guards, verify the gated path also got the fix.

## Special-cases and dispatch tables must enumerate all equivalent/producible values  ·  `dispatch-must-cover-all-producible-values`
- **Severity:** important  ·  **Support:** 8  ·  **Seen in:** #152, #164, #3286, #4904, #25615, #27398
- **Rule:** When dispatching or gating on a string/enum identifier, enumerate every value the producer can emit and equivalent sibling ids sharing the path; don't hardcode a subset that silently hits a default, and resolve configurable/renamable names rather than hardcoding one. Flag `x === "literal"` gates and cross-check against the producer's value set.
- **Detect:** Find `providerID === "X"` / `if (label === "a" || "b")` / `agents.get("build")` gating behavior, then cross-reference the set of values the producer can return (EXT_TO_LANGUAGE values, sibling provider ids like X-anthropic, project markers used by sibling servers). Ask: are there equivalent ids/values that fall through to a default or trigger a fatal error?

## Don't use truthy/||/?? checks on values where 0, NaN, or false are valid  ·  `no-truthy-check-on-numeric-zero`
- **Severity:** important  ·  **Support:** 7  ·  **Seen in:** #2037, #3162, #28557, #30672, #31021, #31157
- **Rule:** When providing a fallback or gate for a value that can legitimately be 0, false, or NaN (timestamps, counts, indices, limits, opt-out flags), do not rely on truthiness (`if (x)`, `x || b`) or `??` alone where `??` is wrong for those cases. Use explicit `=== undefined`/`!= null` for absence, and `Number.isFinite(x)` checks for external numerics fed to timers/loops. Flag only when the value can realistically be 0/false/NaN.
- **Detect:** Grep for `x || fallback`, `x ? ... : fallback`, `if (x)`, `!obj.field`, or `(a ?? b) === false` where the variable is numeric (named *limit*/*context*/*count*/*size*/*index*/*time*/*archived*) or a boolean opt-out flag. Ask per hunk: can this value be 0, NaN, or false, and would that wrongly trigger the fallback/override? For external numerics reaching setTimeout/setInterval, ask: can NaN or a negative slip past `?? default`?

## Readiness/active/empty-stream predicates must include every disqualifying or equivalent state  ·  `predicate-must-cover-all-relevant-states`
- **Severity:** important  ·  **Support:** 7  ·  **Seen in:** #142, #20467, #23407, #26167, #27166, #28610
- **Rule:** A boolean predicate (ready/valid/active/terminal/empty) must account for every state its producer can emit and known disqualifying flags. Don't let a 'present but incompatible' state count as ready, don't narrow a multi-state status check to a single literal, and flag ternaries keyed on a status the enclosing guard can never produce (dead branch).
- **Detect:** Find a `ready`/`valid` memo checking existence (resolvedPath, !error) but ignoring a nearby mismatch/incompatibility field other code branches on. Find status checks narrowed to a single enum literal (=== 'busy', reason === 'unknown' && output===0) when the union has other active/equivalent states. For each ternary keyed on a status, trace the enclosing guard: can the guarded value ever equal the branch's compared value?

## Normalize only for cache keys; preserve and re-match the original value everywhere else  ·  `normalize-key-but-pass-original-for-side-effects-and-matching`
- **Severity:** important  ·  **Support:** 6  ·  **Seen in:** #25662, #25939, #25941, #27016, #30644, #31194
- **Rule:** When you normalize/canonicalize an identifier or path, use the normalized form only as a cache/query key. Pass the original value to client/server side-effects, normalize BOTH sides of any comparison (or the config entries the same way), and route every matching-key/href builder through the same normalizer. Flag membership tests or client-factory calls fed a normalized value while sibling sites pass the raw value.
- **Detect:** Flag `sdkFor(key)`/client-factory calls or membership tests (`includes`, `has`) fed a normalized value (`directoryKey(x)`, `realpath`, `.toLowerCase`) while sibling sites pass the raw value. Check `.normalize("NFC")` applied to the query but not the candidate items. When a diff adds a normalizer mapping A→B, grep for other uses of the original id building keys/hrefs not routed through it. When a useIsFetching/status key differs from the fetch's actual key, flag the mismatch.

## Branch on, publish, and fall back from the resolved/effective value — not a raw or partial source  ·  `branch-on-resolved-value-not-raw-or-stale-source`
- **Severity:** important  ·  **Support:** 6  ·  **Seen in:** #160, #2037, #23407, #31021, #31700
- **Rule:** Downstream code must use the resolved/effective value from a resolver, fallback chain, or override — not a raw stored key or single source's type. Publish the resolver output (not state.active) to globals, branch on which source actually won (not just auth.type) in a fallback chain, pick fallbacks from the complete effective collection, and compute derived values from the overridden value. Flag effects assigning a global from a raw field where a diverging resolver exists.
- **Detect:** Find an effect assigning `window.*`/a global from a raw stored field (state.active) where a resolver (current()/computed) exists that can diverge. Find a `?? `-chain resolving a credential followed by `if (auth?.type === ...)` that can fire even when an earlier source won. Find removal/fallback logic searching `store.list` when a broader accessor (allServers()) exists. Find `effectiveLimit(...)` introduced but the base `input.model` still passed to derived computations.

## Apply dedup/validation/precedence and invariant upserts after all sources merge  ·  `apply-invariants-and-precedence-after-merge`
- **Severity:** important  ·  **Support:** 5  ·  **Seen in:** #23214, #25846, #27398, #28907, #29000
- **Rule:** Apply dedup/validation/mutual-exclusion/invariant upserts AFTER all config/env layers merge (or re-apply post-merge), since a later merge can reintroduce a removed entry or overwrite an upsert. When an explicit input is documented to win, return as soon as it is present (after filtering invalid entries), not only when the filtered result is non-empty. Flag `if (filtered.length > 0) return filtered` where a comment claims the input 'wins'.
- **Detect:** Flag delete/filter/validation/upsert on a config or env map that runs before a known merge (mergeDeep, Object.assign with spread of shellEnv, user-config merge); ask whether a later merge can undo it. Flag `if (filtered.length > 0) return filtered` where a comment claims the input 'wins'. Check whether a per-file schema constraint can be bypassed by cross-layer merge or a write/update path.

## Validation/matching regexes must cover all intended inputs (compound extensions, streaming, whitespace)  ·  `regex-must-match-all-intended-and-streaming-inputs`
- **Severity:** important  ·  **Support:** 4  ·  **Seen in:** #26168, #27934, #29028, #31700
- **Rule:** Ensure matching regexes accept every legitimate input: multi-segment extensions (`.js.map`) via `(\.\w+)+$`, end-of-string as a valid boundary for streaming/partial input, and consistent character classes across validators for the same identifier type. Flag asset-classifying filename regexes ending in `\.\w+$` and regexes requiring a trailing separator on streamed text.
- **Detect:** Flag filename regexes ending in `\.\w+$` used to classify build assets (does it match foo.js.map?). Flag regexes requiring a trailing blank-line/separator on streamed text (should `$` be an accepted boundary?). When a diff adds/changes an identifier-validation regex, compare its character class against other validators for the same concept (one allows `_`, another forbids it). Flag normalizers that lack an early `.trim()` while validation elsewhere trims.

## Default/fallback branches and edge cases must implement the intended (not legacy/failing) behavior  ·  `default-branch-and-edge-cases-must-implement-intended-behavior`
- **Severity:** important  ·  **Support:** 4  ·  **Seen in:** #166, #23407, #26895, #28255
- **Rule:** Ensure the undefined/default branch implements the intended new behavior, not a legacy constant. Distinguish real failures from valid edge cases: don't fail-closed on a valid baseline sentinel (e.g. git empty-tree hash), and don't drop the currently-selected entry from a derived list just because its status changed — surface or handle the disappearance. Flag `if (state.kind !== "ready") continue` loops that can exclude the active item.
- **Detect:** When a feature adds a config option, check whether the undefined/default branch reproduces old behavior while only an explicit value triggers the new behavior. Flag early returns discarding a result on a known sentinel (emptyTreeHash). Find list-building loops with `if (state.kind !== "ready") continue` — can the active/selected item match the excluded state and cause a silent fallback?

## Documentation examples and capability claims must be accurate and runnable  ·  `docs-examples-must-be-runnable-and-true`
- **Severity:** important  ·  **Support:** 4  ·  **Seen in:** #137, #2426, #2607, #5332
- **Rule:** Code examples in docs must be runnable as written: for lifecycle-sensitive commands (reload/restart) show the prerequisite (await ctx.waitForIdle() before ctx.reload()) or pick an example that works inline. User-facing onboarding/help/status copy must only claim capabilities that are true in every supported install/runtime mode, and warning/status messages should state the concrete consequence (e.g. an untrusted-project banner should say project-local extensions/config won't load), not just the state.
- **Detect:** Docs snippets invoking reload/restart without the prerequisite await/wait step; onboarding/help strings asserting a concrete capability not guaranteed in all environments; or a warning/notice string describing a state with no clause explaining its effect.

## Guard browser/runtime globals and degrade gracefully when optional capabilities are missing  ·  `guard-environment-and-optional-runtime-capabilities`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #26282, #30253, #31309
- **Rule:** Guard browser-only globals (self, window, document, requestAnimationFrame, Worker) with `typeof` checks or move them into client-only lifecycle hooks, especially at module-evaluation time and when sibling code in the same file already guards them. When an optional capability is missing, provide a degraded fallback rather than rendering nothing. Flag top-level reads of window/document/self without a typeof guard.
- **Detect:** Flag top-level/module-scope reads/writes of self/window/document/navigator without a `typeof` guard. Flag direct rAF/cancelAnimationFrame/document.* calls without `typeof X === "function"` when other functions in the file have the guard. Flag `if (typeof Worker === "undefined") return [() => undefined]` — does the missing-capability branch disable the feature entirely or degrade?

## Read mutable sources (env vars) freshly at the check site; don't gate on a stale snapshot  ·  `read-mutable-sources-freshly-not-snapshotted`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #25853, #26992, #27719
- **Rule:** When a value can change at runtime (process.env) read it freshly at each check site or expose it via a getter, so guards stay consistent with code that reads env at runtime. Apply env/process.env mutations before any code that reads those vars at import time. Flag a guard using a module-load-captured env constant while nearby code reads the same setting via process.env at runtime.
- **Detect:** Find a guard using a module-load-captured constant/flag while nearby code reads the same setting via process.env at runtime (late env mutations bypass the guard). Find process.env mutation (env merge/prepareServerEnv) placed after earlier calls that read env vars (port, proxy). Trace whether a downstream module copies a 'live' getter's value into its own cached state at init.

## Guard nested spreads against undefined and String.replace against $-patterns  ·  `guard-spreads-and-string-replace-against-dynamic-content`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #2037, #28082, #31736
- **Rule:** Guard nested object spreads of possibly-undefined optional properties with a default (`{ ...(meta.icon ?? {}) }`). When using String.replace with a replacement containing arbitrary dynamic text (e.g. a filesystem path), use a function replacer so `$&`/`$$` patterns aren't interpreted. Flag `.replace(pattern, str)` where `str` holds user/path-derived text.
- **Detect:** Find `...obj.prop` inside an object literal where obj is partial/Optional (`?:` in its type) and prop isn't guaranteed present, lacking a `?? {}` guard. Find `.replace(pattern, str)` where `str` is or contains a variable holding user/filesystem-derived text — recommend a function replacer.

## Resolve relative paths against the intended base directory, not process CWD  ·  `resolve-relative-paths-against-intended-base-not-cwd`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #3241, #25403, #29130
- **Rule:** Resolve relative path inputs against the explicit intended base directory (e.g. `path.resolve(worktree, file)`), not process CWD, for deterministic normalization. Treat a worktree of '/' or undefined as invalid and fall back to the project dir — a plain `worktree || fallback` misses '/' since it is truthy. Flag `path.resolve(x)`/`process.cwd()` joins where a specific base exists, and `x.worktree || fallback`.
- **Detect:** Flag `path.resolve(x)` / `path.join(process.cwd(), x)` where x may be relative but the logic compares against a specific base (worktree/root). Flag `x.worktree || fallback` cwd resolution — can worktree be '/' for non-git repos, bypassing the fallback?

## Don't leave half-mutated state on failure or mark state live before the update applies  ·  `no-partial-mutation-and-no-premature-touch`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #29208, #30300
- **Rule:** Build results into a new array/object (or use per-item error handling) so a mid-iteration throw can't leave a partially-mutated structure; commit only after the full transform succeeds. Perform 'touch'/mark-live side effects only AFTER the guards (`!parts`/`!found` early returns) that confirm the update applied. Flag in-place element assignment in a loop body that can throw, and mark-live calls placed before bail-out guards.
- **Detect:** Find loops assigning into an existing object/array element (`config.plugin[i] = await resolve(...)`) where the body can throw — if iteration N throws, are items 0..N-1 mutated while N+ are not? Find a touch/mark-live call placed before early-return guards (`!parts`, `!found`) — if the guards bail, was state already marked live for an unapplied delta?

## Select by stated preference order and keep limit checks independent of optional transforms  ·  `select-by-preference-and-enforce-limits-independently`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #26401
- **Rule:** When multiple candidates satisfy a constraint, pick the first acceptable in preference order, not the globally smallest — don't re-sort and discard intended ordering. Separate a limit/validation check from an optional transform so disabling the transform doesn't skip the limit. Flag `.filter(<=limit).sort(bySize)[0]` and `if (!flag) return input` placed before validation.
- **Detect:** Flag `.filter(... <= limit).sort((a,b)=>a.size-b.size)[0]` — does this discard an implicit quality/preference order among items that all pass? Flag `if (!flag) return input` sitting before validation logic — does disabling the flag also skip a documented limit/safety check?

## Use documented library APIs; don't invent members or present heuristics as authoritative  ·  `use-documented-library-apis-and-avoid-magic-heuristics`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #29208, #30164
- **Rule:** Introspect library values only via documented utilities; don't invent property/method names that may not exist and fail at runtime, especially in handlers that must not throw. Don't present a local heuristic (char-count/4) as authoritative token/billing usage — label estimates and prefer provider-reported values, reusing an already-computed sum. Flag ad-hoc member access on library objects and `charCount / 4` token estimates.
- **Detect:** Flag access to ad-hoc properties/methods on library objects that aren't standard members of the type (cause.reasons, Cause.isDieReason), especially in handlers that must not throw. Flag arithmetic dividing character counts by a constant (`/4`) to produce a 'tokens'/usage value, and recomputation of an expression already stored in a local.

## Intercept no-side-effect features before unconditional setup runs  ·  `ephemeral-features-intercept-before-unconditional-setup`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #25615, #30672
- **Rule:** For features meant to have no side effects (ephemeral/no-persist), intercept them before earlier unconditional setup (session creation, navigation) in the same handler, or skip that setup for the ephemeral path. Don't clear a tombstone/unavailable flag on a generic update event — only for events explicitly representing a restore. Flag an ephemeral branch preceded by unconditional state mutation, and unavailable-flag clears on every non-delete path.
- **Detect:** For a new branch handling an 'ephemeral'/'no-persist' command, ask: does an earlier unconditional statement in the same handler already mutate state (create session, navigate) before this branch runs? Flag an update/event handler setting an unavailable/deleted flag to undefined on every non-delete path — can that event legitimately restore the entity?

## Preserve Request headers when wrapping fetch and keep listener/redirect hosts consistent  ·  `seed-request-headers-from-request-object-and-match-listener-redirect-host`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #28557, #28897
- **Rule:** When wrapping fetch and rebuilding headers, seed them from `requestInput.headers` when requestInput is a Request (not just init.headers), then layer overrides, so carried headers aren't dropped. Keep an OAuth/loopback listener host consistent with the redirect/authorize URL host (binding 127.0.0.1 while redirecting to localhost can fail on IPv6). Flag header construction from `init?.headers` only when requestInput may be a Request, and listener-vs-redirect host mismatches.
- **Detect:** Find a fetch override constructing headers from `init?.headers` only, then `fetch(requestInput, { ...init, headers })` — if requestInput is a Request with its own headers, are they preserved? Compare `server.listen(port, host)` host against the redirect_uri/authorize host — does one use '127.0.0.1' while the other uses 'localhost'?

## Classify path-like prefixes independent of env resolution; verify env-var data-source swaps are populated  ·  `classify-path-prefixes-independent-of-env-resolution-and-data-source-swaps`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #25375, #25394
- **Rule:** Recognize a path-like prefix ($VAR/..., %VAR%/...) as path-like regardless of whether the env var currently resolves, then fail as a missing file or throw a targeted config error naming the variable — don't reroute a local path through the package branch because the var is unset. When replacing a data source with an optional default-empty env var, verify some workflow/script sets it. Flag classification gated on `!!process.env[name]` and new empty-default env reads with no setter.
- **Detect:** Flag classification logic gating an 'is path / is package' decision on `!!process.env[name]`. When code starts reading a new `process.env.X` with an empty default replacing a prior data source, grep workflows/scripts for `X:`/`export X` and flag if nothing sets it.

## Preserve known per-model exceptions and syntactically-significant whitespace  ·  `preserve-model-specific-exceptions-and-significant-whitespace`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #27390, #29028
- **Rule:** When replacing per-model special-case branches with a generic merge, preserve known model-specific exceptions (a model that must omit a parameter) so the merge doesn't reintroduce a value a backend rejects. Don't trim leading whitespace from text rendered as markdown (4-space code blocks are significant); only trim trailing. Flag refactors collapsing per-model branches into `mergeDeep` and `.trim()`/`.trimStart()` on markdown-rendered text.
- **Detect:** Flag refactors replacing per-model special-case branches with a generic `mergeDeep(base, variant)` — did any removed branch omit a parameter a specific backend rejects? Flag `.trim()`/`.trimStart()` applied to text later rendered as markdown.

## Order checks so entries carrying multiple relevant fields aren't shortcut, and add window fallbacks  ·  `ordered-checks-must-not-shortcut-entries-carrying-both-fields`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #28420, #30722
- **Rule:** When an entry can carry both a role and an explicit action, an early `if (entry.role) return ...` must not preempt the action handling — reorder or special-case actionable roles. When running window/UI actions against getFocusedWindow()/activeElement, provide a fallback for when nothing is focused so the action doesn't silently no-op. Flag an early `if (entry.X) return` preceding handling of a mutually-relevant field on the same entry, and focused-target usage with no null path.
- **Detect:** In a config-entry mapper, look for an early `if (entry.X) return ...` preceding handling of a mutually-relevant field on the same entry; ask if entries with both fields are shortcut. Grep for getFocusedWindow()/document.activeElement used directly as a target with no null/fallback path.

## Validate media type before mapping to a fixed content-block type  ·  `validate-media-type-before-fixed-block-mapping`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #112, #26825
- **Rule:** Don't map every media/attachment part to a single hardcoded output block type (e.g. `image_url`) without validating mediaType. Check the prefix against the expected family (image/*) and explicitly reject or route unsupported types (application/pdf, audio/*) to the correct block. Flag transforms hardcoding a provider block type without a mediaType check.
- **Detect:** Flag transforms mapping media parts to a hardcoded provider block type (`type: "image_url"`) without checking the `mediaType` prefix; ask what happens for non-image media.

## Don't loosen a boolean guard so it becomes true in default/unset cases  ·  `tighten-loosened-boolean-guards-against-default-cases`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #172, #29066
- **Rule:** When loosening a boolean condition with added negation/OR (`!x ||`), verify it doesn't become true in a default/unset case and thereby widen behavior to cases the original excluded. A 'same/default' guard must stay sensitive to explicit overrides. Flag a changed condition that evaluates true when a field is unset (e.g. `!ag.model || (...)`).
- **Detect:** Flag a changed boolean condition that adds `!x ||` or removes a truthiness requirement so it evaluates true when a field is unset (`!ag.model || (...)`); verify downstream effects aren't applied to explicitly-overridden inputs.

## Don't silently switch an aggregate's metric while labels describe only one  ·  `avoid-mislabeled-aggregate-metric-switching`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #2037, #31157
- **Rule:** Don't let an aggregate silently switch which metric it computes via a fallback while the returned shape and UI labels describe only one metric. Make the metric explicit (a `metric` field with matching totals) or drop the fallback so missing data reads as no activity. Flag a ternary picking between two source metrics based on whether one is zero (`peakTokens > 0 ? day.tokens : day.count`) where labels assume one metric.
- **Detect:** Look for a ternary picking between two different source metrics based on whether one is zero/empty (`peakTokens > 0 ? day.tokens : day.count`), where downstream labels/field names assume only one metric.

## Reject blank/empty-string reference IDs at validation instead of treating empty as absent  ·  `reject-blank-reference-ids-at-validation`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #131, #166
- **Rule:** Validate foreign-key/reference id fields with a non-empty-string check (id.trim().is_empty() => Err), not just value.is_string(). If empty strings are later filtered out as 'absent' before the existence/FK check, an empty string slips past validation and persists as neither null nor a valid reference, breaking downstream null/real-id queries.
- **Detect:** A validator checks only value.is_string() for an id/reference field combined with a later .filter(|id| !id.is_empty()) before an existence check. Ask: can the payload set the reference to "" and bypass the existence check while still being stored?

## Compute local calendar-day boundaries with Date arithmetic, not fixed-millisecond offsets  ·  `compute-local-calendar-boundaries-with-date-arithmetic-not-fixed-ms`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #115, #175
- **Rule:** Compute local calendar-day boundaries (start of yesterday, last N days, start of week) with Date calendar arithmetic (setDate(getDate()-1) / setHours(0,0,0,0)), not by subtracting a fixed 86_400_000 ms / 24*60*60*1000 from local midnight. Across DST a calendar day is not 24h, so fixed-ms day math lands at the wrong wall-clock instant and mis-buckets items.
- **Detect:** Date math subtracting a fixed 86_400_000 / 24*60*60*1000 constant from a local midnight to derive 'yesterday'/'last N days'. Fixed-ms day arithmetic for local-calendar buckets = DST bug.

## Add a unique tie-breaker to ORDER BY (and sort merged sources) when row order matters  ·  `order-by-unique-tiebreaker-when-row-order-matters`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #15, #25
- **Rule:** SQL does not guarantee order among rows with equal sort keys; ORDER BY a non-unique column (created_at, timestamp) is non-deterministic when rows share the key (user+assistant messages stamped from one now_ms). Add a monotonic/unique tie-breaker (a seq column, rowid, explicit role filter) when order matters — especially in tests indexing positionally. Likewise, when merging rows from multiple sources for an order-sensitive view, sort the merged list by the semantic key rather than relying on `[...a, ...b]` concatenation order.
- **Detect:** `ORDER BY <col>` where <col> may be non-unique and code/tests index results positionally (rows[0]=user, rows[1]=assistant); or `return [...editRows, ...autoRows]` feeding an order-sensitive list with no subsequent sort. Ask: could two rows share this key, and is there a unique tie-breaker / explicit sort?

## Decide tool-specific subcommands from the same source that resolves the executed command  ·  `runtime-command-decision-from-resolved-command-source`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #3241, #3244
- **Rule:** Decide which tool-specific subcommands to run from the same source that resolves the executed command (the configured/resolved command kind), not from an independent environment detector, or a user-configured command (e.g. npm under Bun) can trigger a manager-specific subcommand against the wrong tool. Do not assume <binDir>/../node_modules is the global package root for non-npm managers; validate candidate paths with existsSync.
- **Detect:** One path branching on detectInstallMethod() while a sibling executes getNpmCommand()/configured command; or join(binDir, '..', 'node_modules') used as the global package root for bun.

## Ensure newline separation and idempotency when appending to config/dotfiles  ·  `appended-config-lines-need-newline-separator`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #440, #5076
- **Rule:** When appending entries to a config/dotfile (.gitignore), ensure the existing content ends with a newline before appending, append exactly one newline-terminated entry per item (avoiding concatenation like out.htmlAGENTS.local.md), and dedupe so repeated runs do not duplicate or join entries. Likewise, a new naming/formatting branch must keep the same components (timestamp, id) as the default branch unless the omission is intentional.
- **Detect:** Code appending to files like .gitignore with no \n between existing content and the appended token, or no dedupe; or a ternary building a filename where one branch includes a prefix (${ts}_${id}.jsonl) and the other drops it.

## Compare dotted version strings componentwise, not via parseFloat  ·  `compare-dotted-versions-componentwise-not-parsefloat`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #32276
- **Rule:** Don't compare or sort dotted version strings via parseFloat/Number — they collapse the minor component (parseFloat("5.10") === 5.1), so e.g. "5.10" sorts before "5.4" and gates behavior wrongly. Parse major/minor (and patch) as separate integers and compare componentwise, or use a real semver comparator. The trap is worst when a single capture group grabs the whole "major.minor" (e.g. /^v?(\d+\.\d+)/) and that captured string is fed to parseFloat.
- **Detect:** Flag parseFloat(x)/Number(x) on a version-like string (matched by /(\d+)\.(\d+)/ or a `gpt-`/`v`-prefixed id) used in a `<`/`>`/sort comparison. Ask: does a multi-digit minor (e.g. .10) order correctly against a single-digit minor (.4)?

## Don't let a parameter default to ambient/current state when undefined is a legitimate value  ·  `explicit-required-args-over-ambient-defaults`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #25710
- **Rule:** When a parameter's correct value can legitimately be `undefined` (e.g. a previous-state value), don't default it to ambient/current state (`= scope()`, `= currentX()`); make it explicitly required so passing `undefined` doesn't silently inject the current/global value and target the wrong scope. Flag params with ambient-reading defaults where call sites pass possibly-undefined values.
- **Detect:** Flag function params with a default that reads ambient state (`= scope()`, `= currentX()`) when call sites pass a possibly-undefined value (`prev.scope`); ask whether `undefined` should mean 'absent' rather than 'current'.

## Implement bounded polling iteratively, not via per-interval self-recursion  ·  `iterative-polling-over-deep-recursion`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #25406
- **Rule:** Implement wait/poll routines as an iterative loop so stack usage stays constant. Don't self-recurse once per poll interval with a decremented timeout, since a large timeout builds a deep call stack and can overflow. Flag a polling function that recursively calls itself after a sleep with a decremented timeout/counter.
- **Detect:** Flag a polling function that calls itself recursively after a sleep with a decremented timeout/counter — iteration count scales with timeout/POLL_MS. Recommend an iterative loop.

## Guard expensive idempotent side effects in periodically-polled functions  ·  `guard-expensive-idempotent-actions-in-polled-functions`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #27953
- **Rule:** In functions polled on an interval, guard expensive idempotent actions (download, upload, fetch) against already-completed state: refresh metadata each poll but skip re-running when the done version matches the latest. Flag removal of an early-return/cache guard (`if (downloadedVersion) return`) in a known-polled function.
- **Detect:** Flag removal of an early-return/cache guard in a function known to be polled on an interval (`if (downloadedUpdateVersion) return ...`). Without the guard, will an expensive action re-run every poll even when already completed for the same version?

## Use partial validators for update paths; don't route partial edits through create validators  ·  `partial-update-validators-must-not-require-create-fields`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #131
- **Rule:** Partial-update/edit paths need partial validators: do not strip the id then call the create validator, which makes all create-required fields (name/title) mandatory on update and rejects valid partial edits. Validate only the fields present, then revalidate the merged result (existing + patch) in the apply path for full-object invariants.
- **Detect:** validate_update_X(payload) does strip_*_id(payload) then immediately calls validate_X (the create validator). Ask: does an update with only {entity_id, <one optional field>} get rejected because the create validator requires name/title?

## Route sibling dispatch helpers through one resolver that rejects unknown kinds  ·  `single-resolver-for-shared-dispatch-key-no-fabricated-defaults`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #107
- **Rule:** When several helpers dispatch on the same kind/type key, route them through one authoritative resolver that returns Err for unknown kinds rather than letting each match arm independently fall back to a synthesized default. A split contract — one helper rejects unknown kinds while siblings (render/schema_version) fabricate defaults — lets an unsupported entity be silently stamped as a wrong default instead of failing fast.
- **Detect:** Multiple fns match on the same kind/type string where one has `_ => Err(...)` but another has `_ => <real default value>`. Ask: can an unknown kind reach the fabricating helper without first being rejected by the validating one?

## Bucket time-ordered items by their own timestamps, not fixed array indices  ·  `bucket-time-ordered-items-by-timestamp-not-array-index`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #11
- **Rule:** Derive time-based groupings (today/this week/older) from the items' own date/`when` values, not fixed array slice indices (history.slice(1,4), slice(4)). Hardcoded numeric slice boundaries silently misclassify items (a same-week run rendered under 'Older') whenever the data ordering or dates shift.
- **Detect:** array.slice(<literal>, <literal>) used to build date-based groups like today/week/older. Flag fixed numeric slice boundaries used for temporal bucketing instead of date comparisons.

## Point default binary fallbacks at the package-local node_modules in a monorepo  ·  `point-default-bin-fallback-at-package-local-node-modules`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #8
- **Rule:** In a pnpm/monorepo, a dependency declared only in a sub-package is linked at packages/<pkg>/node_modules/.bin, not the workspace root. Point default command fallbacks at the package-local binary path so spawning without overriding the env var actually finds the executable, instead of targeting a non-existent root-relative path.
- **Detect:** Hardcoded default command strings like 'node_modules/.bin/<tool> ...' used as an env-var fallback. Verify the tool is a root-level dependency; if it's only in a sub-package's package.json, flag the root-relative bin path.

## Verify hardcoded external API limits against docs and cite the source  ·  `verify-external-api-limit-against-docs-with-source-comment`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #120
- **Rule:** When a hardcoded numeric limit is asserted to mirror an external provider/API constraint (image byte size, token cap, payload limit), verify it against current provider docs, add a comment citing the source URL, and explicitly distinguish raw-byte vs base64-encoded (~33% larger) and per-item vs total-request semantics. Only flag literals that are tied to a named external API (in a comment, variable name, or adjacent provider label), not generic internal constants.
- **Detect:** Grep for numeric size/limit literals like /maxBytes:\s*\d+\s*\*\s*1024\s*\*\s*1024/ or /max[A-Z]\w*:\s*\d+/ near a provider label with no adjacent comment citing a source URL, or asserted to match a named external API.

## Clone objects to the depth that is actually mutated  ·  `deep-clone-to-mutation-depth`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #120
- **Rule:** When cloning an object to mutate it without affecting the source, ensure the clone reaches the depth that is actually mutated. A one-level spread like { ...m, content: [...m.content] } leaves nested block objects as shared references, so mutating a block field leaks back to the original; clone each nested element (content.map(b => ({ ...b }))) or document that only the array shape is mutated.
- **Detect:** Look for { ...x, content: [...x.content] } (one-level spread) followed by code that assigns to properties of elements inside content.

## Expand ~ consistently in env-var-supplied filesystem paths  ·  `expand-tilde-in-env-supplied-paths-consistently`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #3963
- **Rule:** When an env-var-supplied directory path may contain a leading ~ or ~/, expand it to homedir() in every place it is consumed (ideally normalize once at startup by rewriting the env value), so downstream consumers do not treat ~ as a literal directory. Also ensure log/crash directories are created with mkdirSync(dir,{recursive:true}) before appendFileSync/writeFileSync, especially inside debug-flag-guarded blocks.
- **Detect:** process.env.<PATH_VAR> used directly in path.join/return without a === "~" or .startsWith("~/") check while a sibling expands tilde; or appendFileSync/writeFileSync(path.join(configDir,...)) with no preceding mkdirSync(...,{recursive:true}).

## Strip consumed global CLI flags before forwarding argv to subcommand handlers  ·  `strip-global-cli-flag-before-forwarding-argv`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #3963
- **Rule:** When adding a global CLI flag parsed in the top-level arg loop, strip it (and its value) from argv before forwarding to subcommand handlers that index args[0] or reject unknown options; otherwise both `tool --flag x subcmd` and `tool subcmd --flag x` break argument parsing.
- **Detect:** A new flag parsed in the top-level loop while the same args array is passed onward (handleXCommand(args)) without removing the consumed flag/value; check whether those handlers index args[0] or reject unknowns.

## Lazy-load native/FFI modules behind a platform check  ·  `lazy-load-native-ffi-modules`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #1593
- **Rule:** Load native/FFI/addon modules (koffi, *.node bindings) lazily via createRequire inside the function that needs them, behind a platform check, rather than importing at module top level; a top-level native import links against the build host's glibc and can crash the whole binary on incompatible hosts even when the feature is unused.
- **Detect:** A top-level import/require of a native addon (koffi, node-gyp build, *.node) that is not deferred into the platform-gated function that uses it.

## Forward the canonical empty form when a trim-based check classifies a value as empty  ·  `normalize-forwarded-value-to-match-emptiness-check`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #4971
- **Rule:** When a branch is entered because a value is considered empty after trimming (x.trim().length === 0), normalize the forwarded value to the canonical empty form ("" or .trim()) rather than forwarding the original; otherwise whitespace-only inputs leak downstream to APIs that only accept truly empty strings.
- **Detect:** Code checks value.trim().length === 0 (or .trim() === "") then in that branch outputs value ?? "" / the original value instead of "".

## Derive per-model maxTokens from the model's reported limit, not a blanket constant  ·  `derive-per-model-maxtokens-not-blanket-cap`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #4795
- **Rule:** Do not apply a blanket constant cap (Math.min(contextWindow, 32768)) to every model's maxTokens in a model-list loader; derive it from each model's actual reported output limit and fall back to a constant only when the API omits it, since downstream budgeting/compaction treats model.maxTokens as a hard limit.
- **Detect:** In a model-loader loop, maxTokens: Math.min(contextWindow, <literal>) applied uniformly to all models regardless of the model's own reported output/max-completion limit.

## Place a platform fallback at the actual triggering condition, not a narrower guard  ·  `place-platform-fallback-at-true-trigger-condition`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #1723
- **Rule:** Place a fallback at the level of the condition that actually triggers it; nesting a fallback (e.g. WSL PowerShell clipboard) inside a more specific guard (Wayland session) when the underlying problem occurs regardless means a whole environment class never reaches the fallback. Add tests for each distinct environment branch.
- **Detect:** A fallback gated by if (isWaylandSession(env)) (or similar narrow guard) when the comment/intent says the issue applies to all WSL/X11 sessions, with the else branch lacking the fallback.

## A perf pre-filter must be a strict superset of the authoritative check it gates  ·  `pre-filter-must-be-superset-of-authoritative-check`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #369
- **Rule:** When a performance pre-filter (hardcoded codepoint-range allowlist) gates an authoritative Unicode/ICU check (\p{RGI_Emoji}), the pre-filter must be a strict superset of what the authoritative check matches, or correctness drifts as Unicode data updates. Add a comment and a regression test pinned against the runtime's Unicode behavior, and cite the source library when porting classification logic verbatim.
- **Detect:** A boolean helper using hardcoded cp >= 0x... && cp <= 0x... ranges short-circuiting a subsequent \p{RGI_Emoji}/\p{...} regex test (couldBeEmoji(x) && rgiEmojiRegex.test(x)); or ported Unicode-class regex blocks lacking a source-attribution comment.

## Stamp the effective (clamped) value, not the raw config value, when recording what was used  ·  `do-not-stamp-config-value-as-effective-value`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #1551
- **Rule:** When recording a parameter that a result claims reflects what was actually used, apply the same provider-side clamping/remapping before stamping it (or document the field as the requested, not effective, value, and state what undefined means). Flag finalMessage.x = config.x where config.x feeds clamping logic (Math.min/clamp/supports*/downgrade) on the same field elsewhere.
- **Detect:** finalMessage.x = config.x where config.x feeds a provider with clamping logic elsewhere (Math.min, supports*, clamp, downgrade mapping on the same field), and/or a new optional field whose JSDoc claims it reflects 'what was active' while only a config/request value is written, with no test for the new field.

## Guard string/array method calls on possibly-undefined fields when strictNullChecks is off  ·  `guard-string-methods-on-possibly-undefined-without-strictnullchecks`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #4606
- **Rule:** In a codebase without strictNullChecks, the type system will not catch calling .startsWith()/.includes() on a possibly-undefined field (e.g. an error field populated only in some branches). Guard such calls with a truthiness check or optional chaining before the call.
- **Detect:** x.error.startsWith( / result.error.includes( or similar string/array-method call on an object property inside an error/failure branch with no preceding x.error && or x.error?. guard, especially on union/result types.

## Ensure key uniqueness when list entries become map keys  ·  `unique-keys-when-list-entries-index-a-map`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #4005
- **Rule:** When list/array entries are later indexed into a map by one of their fields (contexts[item.label]), the chosen key must be unique across entries; a duplicate key (minimax vs minimax-cn sharing a label) silently overwrites another entry and drops its coverage. Verify uniqueness whenever a new entry is added.
- **Detect:** A diff adds an entry to an array whose elements are indexed by a field (map[item.label]) where the new entry's key value duplicates an existing entry's.

## Read mutable/feature settings at use time, not captured at session construction  ·  `use-injectable-platform-or-honest-skip`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #492
- **Rule:** When behavior depends on a user-mutable setting, read it at use time (inside the callback/converter each invocation) rather than capturing it once when a long-lived session or closure is constructed, because the constructor runs once per session and a captured value ignores mid-session setting changes. Flag a boolean captured from settings at construction and then closed over in a long-lived callback. (Register under a title matching this intent, e.g. 'read-mutable-settings-at-use-time'.)
- **Detect:** A boolean captured from settings at construction (const blockImages = ...) then closed over in a long-lived callback/wrapper, instead of being read freshly inside the callback each invocation.

## argv flag-presence checks must also match the --flag=value form  ·  `argv-flag-detection-must-match-equals-form`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #29876
- **Rule:** When detecting a CLI flag via raw argv membership (`argv.includes("--flag")`, `argv.indexOf("--flag")` used as a boolean), confirm whether the flag's inline `--flag=value` (or `-f=value`) form is also accepted by the parser; if so, the membership check silently misses it. Prefer reading the already-parsed args object; if you must scan raw argv, match a prefix (`a.startsWith("--flag=")`) in addition to exact equality. Only applies to flags whose `=value` form is actually honored — flags that only support the space-separated form are unaffected.
- **Detect:** Grep for `process.argv.includes("--<name>")` / `argv.indexOf("--<name>")` used as a boolean signal; ask whether `--<name>=value` (or `-x=value`) would also need to be detected. Prefer reading the parsed args over scanning raw argv.

## Verify config keys against the pinned tool version's current docs  ·  `verify-config-keys-against-pinned-tool-version`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #141
- **Rule:** When a PR pins or bumps a build/package tool's major version (packageManager, engines, a tool dep, or a CI toolchain), verify every config-setting key for that tool against the pinned major's schema. Major versions rename, remove, or re-purpose keys (pnpm `onlyBuiltDependencies` -> `allowBuilds`/`strictDepBuilds`; eslint `.eslintrc` -> flat `eslint.config`; biome v1 -> v2 schema), and a stale key often still parses while doing nothing — silently failing to grant the intended behavior. Detection: flag a tool config file (pnpm-workspace.yaml, package.json pnpm/engines blocks, biome.json, tsconfig, eslint config) whose setting keys are touched in the same PR (or whose tool is pinned/bumped to a new major), then ask per key: does this key still exist in the pinned major, and does it produce the intended effect rather than being a no-op carried over from an older version?
- **Detect:** A config file relies on a setting key (`onlyBuiltDependencies`, `strictDepBuilds`, allowlists) while the toolchain is pinned to a major version that renamed/removed it. Ask: does this key exist in the pinned version, and does it produce the intended effect rather than just silencing a warning?

## Treat an empty env-var value as unset before using it as a path/config base  ·  `treat-empty-env-var-as-unset-for-path-base`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #144
- **Rule:** When an env var overrides a path/config base, treat a present-but-empty value as unset: an empty string becomes a relative path that resolves against the process CWD, silently relocating the DB/config/skills dir. Filter empty before use (`.filter(|d| !d.is_empty())` in Rust, `if (!x)` / `x === ""` in TS) and fall through to the computed default. Flag a presence-only override (`if let Some(v) = env::var_os(X)` / `const v = process.env.X` used directly in PathBuf::from / path.join / a returned path) that lacks an empty-string filter, UNLESS an empty value is genuinely meaningful at this site. Bonus: when one sibling resolver filters empty (e.g. XDG_DATA_HOME) and a peer does not, flag the inconsistency.
- **Detect:** Grep for `env::var_os(X)` / `process.env.X` used directly as a path base (PathBuf::from, path.join, return) with only a presence check (`if let Some` / `if (x)`); ask: is an empty string filtered out (`.filter(|d| !d.is_empty())`, `if x === ""`) before it becomes a relative/CWD-rooted path?

## A by-key/path loader must enforce the same eligibility filter as discovery so it can't load what discovery rejected  ·  `route-direct-load-through-same-discovery-eligibility-gate`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #171
- **Rule:** When a resource is both surfaced through a filtered discovery/advertised list AND directly loadable by key or path, route the direct loader through the same eligibility gate. Otherwise an item discovery deliberately dropped (malformed, missing/duplicate/mismatched metadata, failed safety check) is still reachable by direct load, so the loadable set diverges from the advertised set.
- **Detect:** Find two siblings over the same resource set: a discovery/scan/list function that applies an eligibility filter before advertising items (drops malformed, missing/duplicate/mismatched metadata, or items that fail a safety check), AND a loader that resolves a single item directly by key, name, or path (e.g. reads `<base>/<name>/FILE`, `map.get(id)` against a raw store, `import(pathFor(name))`) WITHOUT going through that filter. Ask: can the direct loader return an item the scan deliberately dropped? Prioritize cases where a dropped reason is a safety/validity check — then the by-key loader is a reachability bypass, not just a divergence.

## Reconcile id namespaces before matching an item from one source against a store populated by another  ·  `reconcile-id-namespaces-before-cross-source-match`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #169
- **Rule:** When code looks up or matches an entity by id where the id comes from one source (server search, persisted record) but the target collection may hold a different id namespace for the same logical item (e.g. optimistic/locally-minted client ids vs server-assigned ids), reconcile or translate the namespaces first. A direct equality match silently never fires for items that exist under the other namespace, leaving the feature a no-op.
- **Detect:** Trigger when a collection is populated by TWO paths that mint ids differently for the same logical item — a live/optimistic path assigning local ids (counter like `m${n}`, `temp-`, client-side `crypto.randomUUID`) AND a server/persisted/hydration path carrying wire ids — then a guard/lookup `coll.some(x => x.id === incomingId)` / `.find` / `Map.get(incomingId)` matches an `incomingId` sourced from the server/search/persisted side. Ask: for an item created in the current session (present under the LOCAL id, not yet re-hydrated under its wire id), does this equality ever pass, or does the feature silently no-op until a reload swaps ids? If a test only exercises the post-reload/cold-hydrated path, the warm-session divergence is likely unproven.

## Gate a transition side effect on the exact source state, not the negation of one target state  ·  `gate-transition-side-effect-on-source-state-not-target-negation`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #172
- **Rule:** When a side effect should fire only on a specific state transition (e.g. active->completed), gate it on the precise source state (prior == active), not on the negation of the target (prior != completed). The negated form also fires for other source states (e.g. dropped->completed, absent->completed) that should not trigger the effect, spawning/mutating where the intended transition never occurred.
- **Detect:** Flag a side effect (spawn/insert/persist/notify) gated by `prior_state != "<target>" && new_state == "<target>"` (any `oldX != T && newX == T`, including when prior is read with a `.unwrap_or("<default>")`). Enumerate every value `prior` can hold besides the intended source — other enum literals (dropped, on_hold) and the absent/default fallback. If ANY of them satisfies `!= target` yet is a transition the effect must NOT run for, require the precise source instead: `prior == "<intended-source>"`. Distinct from narrow-predicate rules: here the guard is too BROAD on the source side of a transition.

## Use full git history (fetch-depth: 0) when a later step needs ancestor commits  ·  `fetch-full-git-history-for-history-dependent-operations`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #32554
- **Rule:** A CI/checkout step that uses a default shallow clone will be missing ancestor/base commits; any later operation that requires those commits (fetching a bundle, diffing against a base branch, git describe, merge-base) can fail intermittently when the base branch advances. When a job consumes a branch bundle, computes a diff against a base ref, or otherwise depends on commit history beyond the tip, fetch full history.
- **Detect:** In a CI workflow diff, flag a job ONLY when BOTH hold: (a) its checkout uses default/shallow depth — an actions/checkout step with no `fetch-depth:` or `fetch-depth: 1` (or git-clone with `--depth`); AND (b) a later step in the SAME job consumes commit history beyond the tip: `git fetch <something>.bundle`, `git merge-base`, `git describe`, `git diff <base>..`/`<base>...`, `git log <base>..`, `git rev-list ^origin/<base>`, or `git cherry`. A bare `git fetch origin <base>` earlier in the job is NOT sufficient — it does not unshallow the checkout clone. When both (a) and (b) co-occur, require `fetch-depth: 0` on the checkout. Do not flag a default-depth checkout that has no history-dependent consumer.

## Don't append a separator/newline to output that may already end with one  ·  `no-double-separator-on-already-terminated-output`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #440, #30547
- **Rule:** Only append a trailing newline/separator when the string doesn't already end with one (check `endsWith('\n')`/EOL), or keep the contract of callers including it. Unconditional appends produce double newlines that break snapshots or downstream parsers. Flag `write(x + EOL)` on text whose origin isn't guaranteed newline-free with no preceding endsWith guard.
- **Detect:** Look for `write(x + EOL)` / `x + "\n"` on text whose origin isn't guaranteed newline-free (already-formatted output, command stdout) with no preceding endsWith('\n') guard, especially where the value was previously written as-is.

## Verify provider API-key env var names and align multi-var precedence with vendor docs  ·  `verify-provider-env-var-name-and-precedence`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #4005, #5262
- **Rule:** When registering a provider's API-key env var name, confirm it against the provider's official docs or established prior art; a wrong name silently breaks credential discovery. When resolving a value from multiple env vars that overlap a well-known tool's variables (e.g. GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT/ANTHROPIC_VERTEX_PROJECT_ID), match that tool's documented precedence so the same environment resolves consistently across tools.
- **Detect:** A diff adds an entry to a provider->env-var map (getApiKeyEnvVars) with an unverified name, or a firstNonEmpty(options?.x, process.env.A, process.env.B, ...) precedence chain over provider env vars whose order is not checked against vendor docs.

## Resolve system binaries across paths and pass required CLI flags  ·  `avoid-os-specific-binary-path-and-flag-assumptions`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #105, #328
- **Rule:** When locating or invoking a system binary, do not assume one fixed absolute path (bash is /bin/bash on some distros, /usr/bin/bash on others) — check plausible paths or resolve via PATH. Pass flags the tool actually requires for the intended mode (e.g. xclip -selection clipboard -i to read from stdin, since some versions won't read piped input without -i).
- **Detect:** existsSync("/bin/<tool>") single-absolute-path probe with no /usr/bin or PATH fallback; or execSync("xclip -selection clipboard"...) without -i when input is piped.

## Round derived counts explicitly when an integer is required  ·  `round-derived-integer-counts-explicitly`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #31157
- **Rule:** When deriving a count used where an integer is required (CSS repeat, array length, loop bound) from a division, round explicitly with Math.ceil/Math.floor so it stays integral regardless of changes to the source constant, and keep dependent index math consistent. Flag a constant defined as `A / B` (non-divisor) later used as an integer count.
- **Detect:** Flag an exported/used constant defined as `A / B` (non-power-of-two divisor) later passed where an integer count is expected (CSS repeat(), array length, loop bound).

## Initialize signals/state with their real value before selection-tracking effects run  ·  `init-state-with-real-value-before-tracking-effects-run`
- **Severity:** nit  ·  **Support:** 1  ·  **Seen in:** #24725
- **Rule:** Initialize a signal/state with its real value at creation when the source data is synchronously available, rather than starting empty and populating it in onMount/useEffect — otherwise selection-tracking effects run against an empty list on first render and settle on a wrong default. Flag signals created empty and filled in onMount when the source is synchronously available and first-render effects depend on it.
- **Detect:** Flag signals/state created empty and then filled in onMount/useEffect when the source data is synchronously available; ask whether first-render effects depend on the populated value.
