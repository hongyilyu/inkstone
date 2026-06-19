# Learned rules — API & compatibility (`api-compat`)

_15 rules. Loaded by the `dr-api-compat` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Avoid runtime-specific globals in cross-runtime code paths  ·  `no-runtime-specific-globals-in-cross-runtime-code`
- **Severity:** blocking  ·  **Support:** 2  ·  **Seen in:** #6, #26754
- **Rule:** Do not call runtime-specific globals (Bun.*, Deno.*, process.* in browser/edge paths, etc.) in modules that also run under other runtimes (e.g. a shared lib used by both a Bun server and a Node/Desktop adapter). Use a runtime-agnostic API or shared abstraction. Only flag when the module is actually reachable from more than one runtime; ignore files clearly scoped to a single runtime.
- **Detect:** Grep for `Bun.`, `Deno.`, or similar runtime-global references in modules known/documented to run under multiple runtimes (server + Node/Desktop adapter). Flag any such reference in a shared path.

## Keep the advertised tool/JSON schema in sync with backend dispatch and validation  ·  `advertised-schema-must-enumerate-all-dispatch-variants`
- **Severity:** important  ·  **Support:** 10  ·  **Seen in:** #118, #130, #131, #133, #150, #155
- **Rule:** When adding new variants/kinds to a backend dispatcher (validate/apply match arms) or tightening a runtime validator, verify the externally-advertised tool/JSON schema (the descriptor a constrained model or client is bound to) enumerates exactly the same variants and constraints. A kind reachable only by tests that bypass the descriptor is dead in production; a schema that advertises looser constraints (nullable/empty/plain-String) than the validator deterministically rejects deadlocks the request server-side.
- **Detect:** Diff adds match arms for new *_kind literals in a validate/apply file but no enum change in the descriptor (e.g. propose_workspace_mutation.rs); OR a JsonSchema/Schemars struct exposes Option<String> + #[serde(default)] / plain String ids where a validate_* fn rejects null/non-string/non-UUID. Ask: does the advertised schema list every dispatch kind and forbid every value the validator rejects?

## Keep generated SDK/client types in sync with the server schema on the wire  ·  `regenerate-sdk-types-to-match-server-schema`
- **Severity:** important  ·  **Support:** 5  ·  **Seen in:** #130, #132, #3375, #23068, #26401, #30253
- **Rule:** When a request/config/route schema changes (adds a field, accepts null to clear a value, or changes accepted params), regenerate the SDK/OpenAPI artifacts in the same PR so generated client types match the runtime contract. Flag if a schema struct/endpoint field changed but no corresponding generated *.gen.ts changed in the same PR, or if the params the SDK serializes diverge from the endpoint's declared payload/query (param present on only one side), or if a nullable/optional addition didn't survive into the generated type. Only applies to repos that actually commit generated client artifacts.
- **Detect:** When a diff adds/changes a field in a `Schema.Struct`/config/`HttpApiEndpoint` schema, check whether the corresponding generated `*.gen.ts` (e.g. `packages/sdk/.../gen/types.gen.ts`) is changed in the same PR; flag a stale SDK if not. Also diff the params the SDK method serializes (signature/query builder) against the endpoint's declared payload/query schema and flag any param present on one side but absent on the other. For nullable additions, grep the generated type for `| null` and flag mismatches.

## Do not silently change the shape, meaning, or return type of an exported API contract  ·  `preserve-exported-type-contract`
- **Severity:** important  ·  **Support:** 4  ·  **Seen in:** #3375, #3928, #27820, #28529, #28701
- **Rule:** When modifying an exported type, interface, enum/discriminant value, or a function's return type, preserve backward compatibility for existing consumers. Flag: (a) adding a required field or discriminator to a variant whose prior default behavior the runtime still accepts when absent (keep it optional); (b) reassigning an existing discriminant/enum value so a formerly-distinct case collapses into another value (add a new value instead); (c) adding an early-return that yields undefined/widens the return type where other paths return a concrete string/object. Only flag exported/public surfaces and call out genuinely-breaking changes explicitly rather than as behavior-preserving.
- **Detect:** Per changed hunk in an exported/public type or function, ask: (1) Was a required literal/discriminator field added to a type/interface that lacked it, where runtime still defaults it absent? grep for newly-added `field: "literal"` (no `?`) on exported types. (2) Is an existing enum/discriminant value (e.g. `DirEntry.type`, `entry.type = X ? "a" : "b"`) reassigned so a formerly-distinct case maps to another existing value? (3) Was a bare `if (!x?.length) return` / `return undefined` added to a function whose other paths return a string/object, widening the return type? Flag if downstream callers depend on the old shape.

## Land producer and consumer together when changing a shared wire schema/union  ·  `shared-wire-schema-changes-must-land-on-both-sides`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #4, #75
- **Rule:** Changes to a shared cross-language wire schema must land on both sides in the same change. Narrowing a field type (S.Array(S.String) -> S.Array(Descriptor)) while the producer still emits the old shape turns valid messages into parse failures. Adding a new outbound message variant on the sender without a matching decode/dispatch branch on the receiver causes the receiver to drop it as 'unknown', hanging request/response handshakes. A shared schema union must also enumerate every documented/emitted variant (terminal error/cancelled/status), or the consumer rejects valid messages at the boundary.
- **Detect:** A field in packages/protocol changes primitive->struct, or a union/enum of outbound kinds gains a variant — then check the Rust counterpart (protocol.rs/worker.rs) still builds the old shape, the receiver's decoder/match has no arm for the new variant, or the union omits variants documented in docs/adr. Flag the one-sided change.

## Tighten provider/host gates so request mutations don't reach incompatible backends  ·  `strict-provider-host-gate-for-request-mutations`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #42, #3018, #3851
- **Rule:** When adding provider/host-gated request mutations (extra headers, session ids, params), ensure the gate is tight enough to exclude other servers that share the provider type or wire protocol but reject the addition (e.g. OpenAI Codex backend, self-hosted/external endpoints). Prefer a general resolver/predicate over inline host-substring ternaries duplicated across branches. Honor the user's telemetry/opt-out preference before attaching identifying headers (User-Agent, client id).
- **Detect:** A new header/param added inside createClient guarded by model.provider==="openai" && baseUrl.includes("api.openai.com"); repeated baseUrl.includes("<host>") checks across 3+ branches; or a static identifying header set unconditionally without a telemetry gate.

## Implementation behavior must match the public schema/SDK contract  ·  `implementation-must-match-public-schema-behavior`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #23068
- **Rule:** When a request option is removed from or absent in the public schema/SDK, do not leave the implementation unconditionally hardcoding one branch of that previously-configurable behavior. Flag when a previously-documented option (e.g. a boolean flag) is gone from the schema but the code still unconditionally performs one of its branches; resolve by removing the behavior, restoring the option, or updating the declared contract so docs and code agree.
- **Detect:** Diff the request schema against the implementation: if a previously-documented option (e.g. a boolean flag like `copyMetadata`) is gone from the schema but the code still unconditionally performs one branch of that option (e.g. always `structuredClone(original.metadata)`), flag the contract/behavior mismatch.

## Gate backward-compatibility fallbacks on the real capability, not an incidental flag  ·  `gate-compat-fallback-on-actual-capability`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #25710
- **Rule:** When adding a fallback for an unsupported/legacy endpoint or error, gate it on the actual condition it addresses (unsupported-endpoint error, same-origin, missing feature), not an unrelated state flag. Flag an error/4xx fallback whose if-condition ANDs an unrelated state flag (e.g. password/token truthiness) with the error check, since legacy/same-origin connections lacking that flag would then hard-fail.
- **Detect:** Flag an error/4xx fallback whose `if` condition ANDs an unrelated state flag with the error check, e.g. `if (password && err.message.includes("not supported")) return`. Ask: should this fallback also fire when that flag is false?

## Model closed-vocabulary wire fields as enums, not bare String, across language boundaries  ·  `model-closed-vocabulary-wire-fields-as-enums`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #132
- **Rule:** When a serialized field has a fixed vocabulary on the consumer side (TS S.Literal union / closed enum), model it on the producer side as an enum (Rust #[serde(rename_all)]), not a plain String, so the server cannot emit a value the client rejects and break decode/hydration. Weigh against protocol consistency: if sibling fields are already untyped String and a DB CHECK constraint already guarantees the value set, keeping String can be a deliberate choice.
- **Detect:** A #[derive(Serialize)] struct mirrored by a TS literal-union has `pub <field>: String` (role/kind/type) whose TS counterpart is S.Literal(...). Flag unless a DB CHECK constraint already guarantees the value set.

## A subscribe method must send the actual protocol subscription request  ·  `subscribe-must-send-wire-subscription-request`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #6
- **Rule:** When implementing a subscribe-style method against a real protocol, actually send the wire subscription request (run/subscribe(run_id, since?)) to register with the server — don't merely allocate a local in-memory queue/stream. A loopback/fake-server test that pushes events unconditionally masks the missing subscribe call; against a real server the client is never registered for notifications.
- **Detect:** A subscribe*/stream method body only does ensureQueue/Stream.fromQueue with no socket.send/RPC of a subscribe method. Ask: does subscribing perform the wire */subscribe request, or just wire up a local queue?

## Every JSON-RPC request with an id must receive a matching response  ·  `every-request-with-id-gets-a-response`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #5
- **Rule:** Per JSON-RPC, every Request carrying an id must get a matching Response (result or error). On invalid params for a request with an id, send an invalid-params error Response keyed to the request id rather than silently continuing/dropping the frame, so schema-drifted or buggy clients receive a recoverable error instead of hanging indefinitely.
- **Detect:** A handler parses params with `let Ok(params) = serde_json::from_value(...) else { continue; }` (or returns without reply) when the incoming request has an id. Flag the missing error Response for an id-bearing request.

## Use globalThis.WebSocket (or DI) instead of the Node ws package in browser-facing code  ·  `no-node-only-ws-import-in-browser-facing-code`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #6
- **Rule:** In code intended to run in the browser (or a shared SDK consumed by a web app), use the DOM globalThis.WebSocket or inject the WebSocket constructor — do not import the Node-only `ws` package, which pulls Node networking APIs into Vite/browser bundles and fails to bundle or run in the browser.
- **Detect:** Grep for `from "ws"` or require('ws') in packages/SDKs consumed by the web app. Ask: is this module bundled for the browser? If so flag the Node ws import in favor of globalThis.WebSocket or DI.

## Don't smuggle internal-only fields into public API types via underscore/@internal  ·  `keep-internal-only-fields-out-of-public-api-types`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #761
- **Rule:** Do not add internal-only fields to a public/exported interface via an underscore prefix and/or @internal tag (the prefix does not make it private). Either make it a real, documented public field with defined optional/default semantics, or keep it out of the public type entirely. For any new optional public field, document whether it is optional and what the default is when omitted.
- **Detect:** A diff adds a member to an exported interface whose name starts with _ and/or carries @internal; or adds foo?: T to a public interface with no JSDoc stating the default when omitted.

## Flag breaking changes (renamed/removed ids, pricing) in regenerated artifacts  ·  `flag-breaking-changes-in-regenerated-artifacts`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #3928
- **Rule:** Treat unrelated diffs in regenerated/generated files as suspect: renamed or removed public identifiers (model ids), removed entries, and changed numeric pricing are breaking/behavior changes. Confirm they are intentional and documented in the PR description, or revert if the regeneration picked up unexpected upstream source-data changes.
- **Detect:** In a diff to a *.generated.* file, removed top-level keys, renamed id/key strings, or changed numeric cost/pricing fields not mentioned in the PR description.

## A compatibility version range must keep an upper bound, not become an open-ended >=  ·  `compat-version-range-needs-upper-bound`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #32827
- **Rule:** When a runtime/toolchain compatibility check derives an accepted version range from a pinned version, do not relax it to an open-ended lower bound (>=x.y.z). An open >= admits every future major and minor, so an as-yet-unreleased breaking version silently passes the guard whose whole purpose is to reject incompatible runtimes. If the intent is 'this major.minor, patch updates allowed', encode that as a bounded range (^x.y.0, ~x.y.0, or >=x.y.z <x.(y+1).0 / <(x+1).0.0) so the comparator and the stated intent agree.
- **Detect:** Flag a version-range constructor that interpolates a parsed version into a bare lower-bound string used to validate a runtime/tool version — e.g. `>=${major}.${minor}.0`, `>=${ver}` — with no accompanying upper bound, especially when an adjacent comment or PR claims it pins to 'major.minor' / 'this version only'. Ask: does a future major or higher minor satisfy this range when the guard is meant to reject incompatible versions?
