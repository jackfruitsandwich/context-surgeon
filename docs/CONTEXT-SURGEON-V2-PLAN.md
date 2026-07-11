# Context Surgeon v2: exact payload truth and daily-driver safety

Status: pre-implementation plan for adversarial review

Base: `fingerprint-directives` at `b5d6072`

Planning branch: `codex/context-surgeon-v2-plan`

## Decision summary

This is a redesign of the trust boundary, not a larger collection of mutation helpers.

Context Surgeon v2 will have one compiler that owns the entire supported request path from decoded input through the exact UTF-8 bytes handed to Node's HTTP client. A surgery command will be an atomic, session-scoped transaction that produces a durable receipt. A request will dispatch only if every intended operation can be reconciled with the final serialized body and provider-specific structural validation passes.

The product will stop making three claims it cannot currently prove:

1. Content-history fingerprints are not conversation identities.
2. A prior provider token count is not the current request's token count.
3. Replacing some text while retaining protected structural content is not a complete eviction of the larger logical turn.

The implementation will be delivered as a stack of independently testable branches. Shared interfaces are frozen by the primary agent before parallel implementation begins.

### Amendments after Claude Fable 5 review and debate

Fable read the plan and the full codebase in read-only mode, produced an adversarial review, and then reconsidered the disputed points in a second round. The plan adopts these changes:

- A Node `Buffer` is not immutable. The production guarantee is an encapsulated body plus a SHA-256 re-check immediately before `ClientRequest.write()`, not `Object.freeze` theater.
- Exact scope is method + full upstream URL + exact UTF-8 body bytes. A separately named semantic envelope is constructed from allowlisted non-secret headers plus auth class/presence; no secret value or secret digest is persisted.
- Transport states report observations only. They never infer partial/full provider delivery or billing from `write()`, `finish`, or socket counters.
- Session snapshots require an enforced writer lock. Prefer a mode-0600 Unix-domain control socket per session; contested lock reclamation uses authenticated liveness and atomic rename-CAS. Timeouts are wedged/unknown and require explicit recovery, never automatic takeover.
- Runtime route/auth mismatch rejects locally. A launch remains `unverified — no proxied request observed yet` until the first supported request arrives. Transparent bypass exists only when the user selected the kill switch before launch.
- Capability authentication moves into the state/control branch. Cursor translation leaves the truth-core branch and remains experimental until its own gate lands.
- Branch 0 must include the fake-upstream proof harness, in-memory state/identity fakes, routing facade, and CLI module split. These are requirements, not optional cleanup.
- V2 never deletes provider items or changes their order. It replaces only permitted payloads in place with provider-valid markers.
- The per-request bootstrap is pinned per session and reduced to roughly ten lines. The full manual moves to `context-surgeon guide`, whose ordinary tool output can itself be evicted.
- Durable v2 state drops content previews. It persists hashes and user-authored replacement text only; the privacy documentation enumerates every persisted content class.
- Migration detects live v1 proxies before importing anything and refuses/warns until mixed-version ownership is resolved.

The primary agent ran the baseline suite successfully (61/61). Fable independently counted the same 61 cases statically under its read-only mandate; it did not execute them.

## Baseline and evidence

The clean baseline builds and all 61 existing tests pass on Node 22.22.3.

The current request path is:

```text
received bytes
  -> optionally decompress
  -> JSON.parse
  -> adapter.parse into mutable ContextObject
  -> compute chained 64-bit fingerprints
  -> assign request-relative ordinal labels
  -> prepend skill text
  -> mutate ContextObject for directives
  -> inject labels into historical content
  -> inject a status estimate into the last user message
  -> adapter.serialize
  -> JSON.stringify
  -> http(s).request.write
```

Verified blockers:

- A recognized surgery request that cannot be decoded, parsed, or modeled is forwarded unmodified. Active directives are skipped, yet the paid request still goes out.
- `transformRequest()` returns bytes, but there is no immutable per-attempt artifact or dispatch receipt tying those bytes to the response usage.
- Status uses a prior response's input count, or a character estimate, and inserts that value into the next request as if it described that request.
- Whole assistant and whole-turn operations report complete application while tool calls, reasoning, signed blocks, or other protected residue may remain.
- Tool-call eviction changes arguments to `{}`. That is syntactically plausible but semantically false and can violate schemas or signed/cross-referenced protocol state.
- Directives are globally keyed by a 16-hex-character chained fingerprint. Independent sessions with byte-identical prefixes share surgery.
- Batch commands partially resolve, mutate entries one by one, swallow persistence errors, and can return HTTP 200 after only a partial durable result.
- The shared JSON store has cross-process lost-update, stale-reader, deletion-resurrection, corrupt-file-reset, and ineffective-GC paths.
- Request-relative labels can collide or move. Reused tool call IDs and unusual ordering can cause one selector to address multiple occurrences.
- Conversation selection for commands is sticky/largest/recent; status and skeleton use a different primary heuristic.
- Cursor tunnels the entire proxy, including unauthenticated `/_control` mutation and metadata endpoints.
- Translated Responses-to-Chat SSE can retain invalid upstream body framing headers, corrupt split UTF-8, drop a final unterminated event, and turn failed/incomplete Responses into a normal completion.
- WebSocket handling does not establish one product-wide invariant: some eligible paths are rejected while other eligible paths can bypass surgery.
- Debug logging prints prompt and response bodies. Documentation contradicts the persistent on-disk behavior.

The old implementation also has real strengths worth preserving: loopback binding, zero runtime dependencies, provider-shape preservation through raw object fields, explicit warning on transform failure, per-port records, inherited port pinning, refusal to guess among multiple external sessions, and strong adapter-focused unit coverage.

## Vocabulary: four different truths

Every UI, receipt, and test will use these terms precisely.

1. **Received request**: the exact bytes and decoded provider-shaped value received from the wrapped client before Context Surgeon changes anything.
2. **Intended surgery**: a committed user operation over explicit content occurrences at a specific session/branch revision.
3. **Compiled request**: the immutable provider-shaped result after skill injection, permitted surgery, normalization, and structural validation.
4. **Dispatch attempt**: the exact bytes handed to Node's HTTP request for one upstream attempt, plus endpoint, lifecycle, and the response usage observed for that attempt.

The compiled request may equal the dispatch body, but they remain separately named. A provider response can prove that an attempt was accepted; merely calling `request.write()` cannot prove billing or server acceptance.

## Non-negotiable invariants

1. Supported surgery routes fail closed. They never fall through to opaque raw forwarding.
2. Opaque pass-through exists only for endpoints explicitly classified as non-surgery routes.
3. The dispatch function for a supported route accepts a branded immutable `DispatchArtifact`, not arbitrary URL/header/body arguments.
4. The final body is serialized once into an encapsulated exact-body value. Dispatch recomputes SHA-256 immediately before handoff, refuses on mismatch, and writes those verified bytes. No contract pretends a public Node `Buffer` is immutable.
5. One artifact exists per upstream attempt. Client retries create new attempt IDs even when body hashes are equal.
6. Response status, usage, and errors attach through the closure for that exact attempt, never by a conversation-wide “latest count.”
7. Every intended operation ends as `applied`, `protected-residue`, `unsupported`, `stale`, or `rejected`. There is no implicit success.
8. A request dispatches only when all committed operations relevant to that request are reconciled with the re-parsed final body.
9. Structural content is protected by default: tool identifiers, tool names, tool arguments, tool call/result pairing, signed/redacted thinking, encrypted reasoning, provider cross-reference IDs, roles, and ordering.
9a. Compilation never deletes or reorders provider items. Permitted payload replacement happens in place, and item count/order hashes are validated before dispatch.
10. V2 does not evict or replace tool-call arguments. Whole-turn cleanup affects evictable payload occurrences and reports protected residue.
11. A command is atomic: validate all targets, durably persist one revision, then publish it in memory and return one receipt.
12. A successful command response means the committed state is durable. An unknown response outcome is idempotently recoverable by operation ID.
13. Independent wrapped sessions never share active surgery because their text happens to be identical.
14. Ambiguous conversation or occurrence identity blocks mutation and application; it never triggers heuristic targeting.
15. Restore is a new reversal event. It never deletes history. “Restored” means the current received request contains the original source hash and the reversal compiled; otherwise the state is `reversal committed, source absent`.
16. Values shown to users are labeled `exact bytes`, `provider-reported`, `estimated`, `previous attempt`, or `unknown`.
17. No inline status or ordinal-label injection is enabled by default. The skeleton/control surface supplies addresses without polluting every paid payload.
18. Control endpoints require a per-session capability. Cursor's public model tunnel never exposes the local control listener.
19. State corruption is quarantined and visible. It never silently becomes an empty state.
20. Existing v1 directives are never auto-bound globally during migration.
21. A launch is `unverified` until the proxy observes its first supported request. Silence is not proof that the wrapper configuration worked.
22. One live writer owns a session state directory. A second owner is refused or read-only; it never becomes a concurrent writer.

## Architecture

### 1. Immutable request compiler

Introduce a provider-neutral compiler under `src/compiler/` with provider-specific codecs under `src/providers/` (the current adapters can be migrated behind this interface).

Core types, frozen before parallel work:

```ts
type ReceivedRequest = Readonly<{
  requestId: string;
  route: SupportedRoute;
  encoding: "identity" | "gzip" | "deflate" | "zstd";
  receivedBytes: Buffer;
  receivedSha256: string;
  decodedBytes: Buffer;
  decodedSha256: string;
  providerValue: Readonly<Record<string, unknown>>;
}>;

type Occurrence = Readonly<{
  occurrenceId: string;
  sessionId: string;
  branchId: string;
  revision: number;
  kind: "user-text" | "assistant-text" | "tool-result-text" |
        "image" | "document" | "tool-call" | "reasoning" | "other";
  sourceHash: string;
  displayLabel: string;
  providerPath: readonly (string | number)[];
  mutable: boolean;
  protectedReason?: string;
}>;

type OperationResult = Readonly<{
  surgeryId: string;
  occurrenceId: string;
  expectedSourceHash: string;
  outcome: "applied" | "protected-residue" | "unsupported" |
           "stale" | "rejected";
  outputHash?: string;
  reason?: string;
}>;

type CompiledRequest = Readonly<{
  requestId: string;
  sessionId: string;
  branchId: string;
  stateRevision: number;
  receivedSha256: string;
  provider: ProviderKind;
  endpoint: string;
  normalizedValue: Readonly<Record<string, unknown>>;
  operationResults: readonly OperationResult[];
  validation: ProviderValidationReceipt;
  bodyLength: number;
  bodySha256: string;
}>;

type DispatchArtifact = Readonly<{
  attemptId: string;
  compiled: CompiledRequest;
  method: "POST";
  fullUrl: string;
  semanticEnvelope: ConstructiveHeaderEnvelope;
  exactBody: ExactBody;
  bodySha256: string;
  exactScopeSha256: string; // method + fullUrl + body bytes
}>;
```

`ExactBody` does not expose a mutable buffer as authoritative state. It provides a defensive-copy inspection method for tests and a dispatch-only handoff that re-hashes its private bytes. The semantic envelope is constructive: dispatch headers are built only from its allowlisted entries plus enumerated secret slots filled at handoff. There is no ambient header bag to filter after the fact. `content-length === exactBody.length` is an asserted envelope invariant.

Compilation steps:

1. Classify the route before decoding.
2. Enforce request size and supported single encoding.
3. Decode strictly. Unsupported or unavailable decoding returns a local 415/422 and no dispatch.
4. Parse and schema-check the provider envelope without mutating it.
5. Resolve session, branch, and occurrence identities. If identity is ambiguous, compile with no mutation only when no committed surgery could apply; otherwise reject visibly.
6. Load one committed state revision.
7. Build a candidate from a deep clone while preserving all unknown fields.
8. Inject the minimal skill bootstrap if it is genuinely absent. This injection is an explicit compiler operation in the receipt.
9. Apply permitted operations at exact provider paths. Tool calls and protected reasoning remain byte-equivalent.
10. Perform provider-specific structural validation: roles/order, call/result pairing, IDs, required arguments, content-block constraints, signed/encrypted residue, and endpoint/body dialect.
11. Serialize once to UTF-8 bytes.
12. Reparse the serialized bytes and independently reconcile every operation and protected hash against the final body.
13. Freeze the compiled metadata and create an encapsulated exact body. Compute exact scope over method, full upstream URL, and body bytes.

The compiler is pure apart from reading an immutable state snapshot. It does not mutate tracking or mark directives applied. Application history is written only after the attempt lifecycle provides an outcome.

### 2. Exact dispatch and attempt ledger

Replace the loose `forwardToUpstream({url, headers, body})` path for supported requests with `dispatch(artifact, clientResponse)`.

Attempt lifecycle records only observable local facts:

```text
compiled
  -> rejected-before-handoff
  -> handed-to-http
  -> request-stream-finished-locally
  -> response-started
  -> response-completed | response-aborted

or, before a response:
  -> failed-no-connection
  -> failed-after-connection-delivery-unknown
```

The connection split is based only on observing a fresh socket's `connect`/`secureConnect` event, never error-code guesses. It is valid while dispatch freezes `agent: false` and `connection: close`. `request-stream-finished-locally` means Node accepted the request stream locally; it does not prove TCP acknowledgement or provider receipt. A response proves that the upstream answered this attempt. After connection without response, delivery and billing remain unknown. A response abort retains any already-parsed usage and labels it partial-stream.

The ledger records timestamps, full URL, method, exact-scope hash, body hash/length, constructive semantic envelope, response status, safe response metadata, and provider usage. It never persists authorization, cookies, secret hashes, full request bytes, or full response bodies by default.

`handed-to-http` means exactly that; it is not labeled “provider received” or “billed.” Provider-reported usage is stored as a structured provider-specific value:

- OpenAI Responses: input, cached input when available, output, total.
- Chat Completions: prompt, completion, total.
- Anthropic: uncached input, cache creation input, cache read input, output.

No generic sum is presented as cost unless the provider defines it that way.

### 3. Transactional session-scoped state

Do not carry the shared global fingerprint map forward.

V2 state is owned by one proxy session and stored under:

```text
~/.context-surgeon/sessions/<session-id>/state.json
~/.context-surgeon/sessions/<session-id>/attempts.jsonl
~/.context-surgeon/sessions/<session-id>/control.json
```

The authoritative state is a small versioned snapshot with `revision`, session/branch metadata, surgeries, reversals, operation idempotency keys, and source/output hashes. It does not persist original prompt bodies or content previews. Replacement text is persisted because it is required to reapply the requested replacement; documentation must enumerate this precisely.

Why a snapshot instead of SQLite in the first v2 branch:

- Each session has one state writer: its proxy event loop, enforced by an OS-visible ownership protocol rather than assumed.
- Control clients never edit files; they transact through that owner.
- Atomic temp write with mode 0600, file fsync, rename, and directory fsync can commit an entire small revision.
- This preserves the zero-runtime-dependency/package portability strength.

If load, validation, write, fsync, or rename fails, the command fails before in-memory publication. The corrupt file is copied/quarantined and the session enters `recovery-required`; it is never overwritten with empty state. The stated durability bar is process-crash consistency, not power-loss durability.

Prefer a mode-0600 Unix-domain control socket inside the session directory. Holding the bound socket supplies OS-enforced live ownership, local capability transport, and no TCP port-reuse ambiguity. If the platform requires a lock directory, acquisition is atomic `mkdir`; the owner record contains a random nonce and control address. A contender validates ownership with an authenticated ping. Valid response refuses the contender; timeout/wrong live response is wedged and requires explicit `doctor --steal-lock`; only provable no-listener permits automatic reclaim. Reclaim atomically renames `lock` to `lock.stale.<random>` before retrying `mkdir`, so two contenders cannot both unlink and win.

Attempt history is observational, not the authority for active surgery. A torn final JSONL record is ignored with a visible warning; an invalid interior record quarantines the ledger. State transactions remain intact in `state.json`.

Every mutating control request carries an operation UUID. A retry returns the original committed receipt. The protocol is:

```text
snapshot current revision
  -> resolve explicit conversation/branch and expected revision
  -> validate the whole batch
  -> construct next immutable state and receipt
  -> durable atomic write
  -> publish next state in memory
  -> return receipt
```

### 4. Session, conversation, branch, and occurrence identity

Identity is layered; content hashes are evidence, not authority.

Session identity resolver priority:

1. A stable source-native session ID observed in supported client metadata or explicit resume arguments, hashed before use as a path component.
2. Explicit `context-surgeon ... --session <name-or-id>` binding.
3. A fresh random 128-bit launch ID for a new wrapped session.

The implementation must audit actual Codex and Claude request metadata before claiming automatic resume support. If a stable source identity is absent, the product says so and requires explicit binding for persistence across wrapper restarts. It does not fall back to global transcript matching.

Within a session, the tracker assigns random conversation and branch IDs and maps successive requests by source-native metadata when available, otherwise by unique transcript extension. Divergent extensions create branches. Multiple indistinguishable candidates produce `ambiguous`, not a heuristic winner.

An occurrence ID uses full SHA-256 over a versioned, length-delimited canonical structure containing session ID, branch ID, predecessor occurrence ID, kind, source content hash, structural relation, and provider path. Ordinal labels remain display aliases only. Ambiguous aliases are rejected.

Default surgery scope is one branch. Propagating surgery to ancestors/descendants must be an explicit later operation that enumerates exact occurrences; v2 does not inherit merely because a prefix hash matches.

### 5. Surgery semantics

The mutable unit is content, not an entire provider record by implication.

Initially supported:

- Replace or evict text payload in a user message.
- Replace or evict text payload in an assistant message while preserving and reporting sibling structural blocks.
- Replace or evict a tool-result payload while preserving its tool call ID and required result envelope.
- Evict explicit image/document occurrences.

Initially prohibited:

- Tool-call name, arguments, ID, or pairing.
- Signed/redacted thinking.
- Encrypted reasoning or opaque provider state.
- Role/order changes.
- Unknown provider blocks.

`evict turn N` expands only to the supported content occurrences present in that exact revision. The receipt lists protected residue. If the caller requests `--require-complete`, any protected residue rejects the whole batch. The default CLI should use `--require-complete` for broad selectors so it cannot overclaim.

Eviction markers are provider-valid typed payloads, not fake tool arguments. Their exact bytes and token contribution are part of the compiled artifact.

Restore creates a reversal event. On the next request, the compiler checks whether each original source hash is present. The UI distinguishes:

- reversal committed, source present, compiled original;
- reversal committed, source absent from client history;
- reversal committed, source changed/stale.

### 6. Control plane and UX

Split model proxy and control listeners. The public Cursor tunnel receives only the model proxy port. Prefer a mode-0600 per-session Unix-domain control socket; the TCP fallback remains loopback-only and requires a random per-session capability stored in a mode-0600 record and inherited through the wrapped process environment.

Commands validate `/_control/ping` identity and nonce rather than trusting PID liveness. External shells with multiple live sessions must name one explicitly.

Remove inline historical ordinal labels and the inline status estimate by default. They cost tokens, perturb model behavior, can echo/accumulate, and are not needed for exact addressing. Optional inline status must name provenance and recency, for example `provider-reported (attempt abc, 2 requests ago)` or `estimated (chars/3.1)`.

The agent workflow becomes:

```text
context-surgeon skeleton [--json]
  -> selected session/conversation/branch, revision, compact labels,
     stable short occurrence IDs, previews, protected residue

context-surgeon evict <occurrence-id-or-unambiguous-alias>
  -> CLI reads current skeleton, sends explicit identity + revision + operation UUID,
     server atomically commits and returns receipt

context-surgeon status
  -> intended state, last compiled reconciliation, last dispatch lifecycle,
     provider-reported usage, and estimates as separate fields
```

The skill bootstrap remains visible as an explicit compiler operation and is included in exact payload accounting. Because proxy mutations do not normally enter the client-held transcript, v2 assumes the bootstrap is a per-request tax and says so. Pin roughly ten lines per session: what the tool is, when to run status/skeleton (at natural phase boundaries and after outputs larger than a few KB), batch surgery to protect prompt caching, and `context-surgeon guide` for the full manual. The guide arrives as ordinary, addressable tool output and can be evicted after reading. Native Codex/Claude instruction installation can be explored later; the deferral reason is version-skew and uninstall hygiene, not observability.

Debug mode emits hashes, lengths, route classifications, operation outcomes, and redacted metadata. Full prompt/response logging requires a separately named explicit unsafe flag and still never logs authorization/cookies.

### 7. Streaming and response correctness

- Use `StringDecoder` or equivalent incremental UTF-8 decoding for SSE parsing.
- Parse CRLF and LF event framing, multi-line data, arbitrary chunks, and final unterminated events.
- Decompress an upstream body before parsing if it is encoded.
- When translating response bytes, remove `content-length`, `content-encoding`, `etag`, body digests, signatures, and other invalidated framing/integrity headers.
- Preserve failed, incomplete, and error terminal semantics. Never emit them as a successful stop.
- Reject WebSocket upgrades for every surgery-capable route unless frame-level compilation and attempt truth are implemented. Do not rely on a 404 as proof of fallback; launcher/provider configuration must positively select HTTP/SSE and smoke tests must observe it.
- Set request/body size limits and bounded SSE/JSON usage buffers.

### 8. Launcher and lifecycle safety

- Positively identify supported Codex subscription, API-key, Claude, and Cursor modes. Do not redirect a custom/profile/OSS backend based on shallow heuristics.
- Preserve native Codex subscription authentication without copying credentials.
- Add a startup self-check showing selected target, upstream class, auth class (never secret), model/control ports, session identity source, persistence path, and surgery guarantee state.
- Own the child process group, coordinate idempotent shutdown, drain active requests for a bounded interval, then force close and report incomplete attempts.
- Handle child exec failure, ignored signals, descendant processes, cloudflared startup timeout, early exit, and tunnel teardown.
- Keep an immediate kill switch: `CONTEXT_SURGEON_DISABLE_SURGERY=1` must either launch the client transparently without the proxy or refuse, based on an explicit mode. It must never advertise active surgery while bypassing it.
- Correct README privacy, persistence, compatibility, and experimental Cursor claims before release.

## Migration

1. Before migration, inspect live port records and authenticated/versioned ping responses. If any v1 proxy is live or wedged, refuse migration and explain that it can still flush/apply the global store.
2. Never mutate or delete `~/.context-surgeon/directives.json` automatically.
3. On first v2 start, copy it to a timestamped backup and import entries as disabled `legacy-unbound` candidates containing their old fingerprint, directive, timestamps, and provenance. Existing tool-call evict/replace candidates are explicitly unsafe and can never auto-bind.
4. Do not auto-apply legacy candidates. The first release lists them in `doctor`; binding is re-issuing a new surgery against an explicit v2 occurrence. Interactive bind/discard/export UX is deferred.
5. A new surgery creates a normal v2 transaction and receipt. It does not reuse the 64-bit fingerprint as authority.
6. Keep v1 and v2 display aliases during transition, but all mutation responses return session, branch, revision, surgery ID, receipt ID, and exact targets.
7. Provide `context-surgeon doctor` to inspect state version, permissions, corrupt/quarantined files, legacy candidates, live sessions, session ownership, and guarantee state without mutating anything.

## Branch stack and implementation order

### Branch 0: `codex/cs-v2-contracts`

Primary-owned, small interface freeze:

- Compiler, identity, state snapshot, receipt, dispatch artifact, attempt lifecycle, usage provenance, and control protocol types.
- Provider codec and validator interfaces.
- Enforced session-lock contract, IdentityResolver/StateSnapshot in-memory fakes, and typed provenance.
- Deterministic local fake-upstream harness shared by every branch.
- Mechanical server routing facade and `commands.ts` split so production ownership is actually disjoint.
- No production behavior change.
- Contract compilation tests.

All implementation worktrees fork only after this commit. Agents may not change frozen contract files without sending a proposed signature to the primary agent.

### Branch 1: `codex/cs-v2-truth-core`

- Immutable compiler and provider codecs.
- Exact serialization/body hashes and branded dispatch.
- Fail-closed supported routes.
- Structural validation and operation reconciliation.
- Attempt-correlated response usage.
- SSE/usage parser correctness required by attempt accounting.
- Fake-upstream end-to-end proof.
- Dispatch-time integrity re-hash, constructive header envelope, and first-request observed guarantee state.
- Excludes the Cursor Responses-to-Chat translator.

Landable gate: every supported request either dispatches one proven body artifact or fails locally; no state redesign is required to exercise no-op and fixture surgery compilation.

### Branch 2: `codex/cs-v2-state`

- Session/branch/occurrence identity.
- Single-writer atomic state snapshots and recovery-required mode.
- Atomic batch commands, reversal events, idempotency receipts.
- Explicit skeleton/status/control selection.
- Authenticated control capability/Unix-socket ownership.
- Session lock/recovery, disabled legacy import, live-v1 coexistence check, and doctor output.

Landable gate: command success/retry/restart/concurrency tests prove one complete revision or none, with no cross-session effect.

### Branch 3: `codex/cs-v2-runtime-safety`

- Split/authenticated control listener and Cursor isolation.
- Positive launcher/backend selection.
- Runtime route/auth self-check, visible `unverified` no-traffic state, and explicit-only kill switch bypass.
- Process-group lifecycle and bounded draining.
- Redacted diagnostics, size limits, tunnel failure handling.
- Package/version/docs/privacy cleanup.

Landable gate: spawned-process and tunnel tests prove ownership, shutdown, control isolation, and truthful startup state.

### Branch 3b: `codex/cs-v2-cursor-translation` (optional/gated)

- Incremental UTF-8 and CRLF/LF Responses-to-Chat translation.
- Correct terminal failed/incomplete/error semantics and response framing headers.
- Real manual Cursor smoke in addition to fake-upstream tests.

Cursor remains experimental and unsupported for the v2 truth guarantee until this branch lands.

### Integration branch: `codex/context-surgeon-v2`

- Merge in order: contracts -> truth core -> state -> runtime safety.
- Primary resolves only frozen seam integrations.
- Remove old transformer/store paths after migration tests pass; do not leave dual render/dispatch paths.
- Run the full tmux smoke matrix continuously.

## Agent structure after plan approval

All Codex implementation agents use GPT-5.6 Sol, extra-high reasoning, with fast mode explicitly disabled. Each works in an isolated worktree and branch. No two agents own the same production file.

### Primary agent

Owns contracts, integration, cross-boundary decisions, deletion of superseded paths, manual tmux smokes, and final release judgment.

### Sol A: compiler and transport truth

Owns `src/compiler/**`, `src/providers/**`, migrated adapter internals, `src/proxy/handler.ts`, `src/proxy/stream.ts`, `src/proxy/usage.ts`, and their tests. Does not edit state/control/launch files or the Cursor translator.

### Sol B: transactional state and control semantics

Owns the new state modules, conversation/branch/occurrence tracker, `src/api/control.ts`, state-related `src/cli/commands.ts` modules, control authentication/Unix-socket ownership, migration/doctor/coexistence checks, and their tests. Does not edit compiler/stream/launch files.

### Sol C: runtime and product safety

Owns `src/proxy/server.ts`, `src/cli/launch.ts`, model/control-listener bootstrap modules, diagnostics, package metadata, README/skill updates, and spawned-process/tunnel/package tests. Does not edit compiler/state contract files or control authentication semantics.

Before implementation, the primary will mechanically split `commands.ts` and the server routing/bootstrap seams. This is mandatory so ownership is real rather than aspirational.

## Acceptance gates

### Exact request truth

- Local fake upstream receives byte-for-byte the dispatch exact body, with matching method, full URL, length, and SHA-256, for OpenAI Responses, Chat Completions, Anthropic Messages, and ChatGPT Codex subscription routing. Cursor translation is not part of this core gate.
- Mutating the encapsulated body through any exposed API is impossible; corrupting internal bytes in a test double causes the immediate pre-handoff hash re-check to reject before `write()`.
- Sent headers can be constructed only from the semantic envelope plus named secret slots; secrets and secret digests never enter durable receipts.
- Any operation that does not appear exactly at its final provider path prevents dispatch.
- Unknown/multiple encoding, unavailable zstd, malformed JSON, invalid envelopes, unsupported body shapes, and adapter exceptions never raw-forward on a surgery route.
- Protected tool/reasoning blocks are byte/hash equivalent before and after compilation.
- Provider item count/order and reasoning/tool structural relations are invariant; Anthropic thinking-position and non-empty-content rules are validated.
- Tool-call/result pairing and provider role/order properties hold under generated parallel/reordered cases.
- Client retries produce distinct attempt receipts; usage attaches to the correct attempt body hash.
- No current UI field calls an estimate/provider-previous value exact.

### State truth

- Two independent sessions with byte-identical transcripts never share surgery.
- Two writers cannot own the same session; live owner refuses, timeout becomes recovery-required, and only provable no-listener can be automatically reclaimed via rename-CAS.
- Fork-local surgery stays local; ambiguous inferred identity blocks mutation/application.
- Duplicate call IDs, tools before users, repeated messages, reordered results, and aliases that match multiple occurrences are rejected or addressed uniquely.
- For generated batches, one invalid target leaves revision and active state unchanged.
- Injected failpoints around write/fsync/rename recover either the old complete revision or new complete revision.
- Corrupt/truncated/wrong-version state enters visible recovery-required mode and preserves evidence.
- A lost control response followed by retry returns the original receipt without applying twice.
- Restart after command acknowledgement deterministically compiles the committed revision.
- Reversal receipts report source present/absent/stale accurately.
- Legacy fingerprints never apply until explicitly bound.
- A live v1 proxy prevents v2 migration; legacy tool-call directives are never rebound.

### Streaming and protocol truth

- CRLF/LF, split UTF-8, split JSON, multi-line SSE, final unterminated event, compressed upstream, failed/incomplete/error Responses, and multiple tool calls are covered.
- Translated responses never retain invalidated length/encoding/integrity headers.
- All surgery-capable WebSocket upgrades are rejected unless observed frame compilation exists; supported launch modes are proven to use HTTP/SSE without an eight-second fallback penalty.
- Provider usage extraction covers JSON/SSE and missing/malformed usage without contaminating another attempt.

### Daily-driver safety

- Cursor tunnel cannot access control ping/status/skeleton/mutation even with the model URL.
- Control capability, state, port, and replacement files have restrictive permissions.
- Subscription, API-key, profile, custom provider, OSS, Claude, and Cursor launch matrices either select a positively identified supported route or fail/explain without misrouting.
- Launch state is visibly `unverified` until the first supported request is observed; wrong traffic rejects locally, and no-traffic never becomes a false active guarantee.
- Child normal exit, failed exec, SIGINT/SIGTERM, stubborn descendants, active request cancellation, tunnel timeout/early exit, and shutdown drain all have spawned-process tests.
- Debug logs redact prompt/response bodies by default and never reveal auth/cookie values.
- `npm pack --dry-run`, clean packed install, build, typecheck, and full tests pass; package and lockfile versions agree.
- README/skill claims match observed persistence, isolation, usage provenance, and compatibility.

## Continuous tmux verification

Once implementation starts, keep these visible sessions:

- `context-surgeon-v2-tests`: focused Vitest watch for the currently integrated branch.
- `context-surgeon-v2-fake-upstream`: local deterministic upstream capturing exact request bytes and emitting adversarial SSE/JSON fixtures.
- `context-surgeon-v2-smoke-codex`: wrapped Codex subscription smoke only after fake-upstream gates pass.
- `context-surgeon-v2-smoke-claude`: wrapped Claude smoke only after fake-upstream gates pass.

No automated test makes a real provider request. Real smokes are manual, visibly named, bounded, and never run in parallel against the same session state.

## Deliberate scope cuts

- Do not vendor Codex/pi or replace Context Surgeon's proxy architecture.
- Do not implement WebSocket frame surgery in v2; positively use HTTP/SSE.
- Do not put the experimental Cursor response translator on the v2 truth-core critical path.
- Do not persist full original prompts by default.
- Do not claim exact token counts before provider usage arrives. Exact bytes are useful independently.
- Do not make tool-call arguments surgically mutable.
- Do not add cross-branch inheritance until branch identity and enumeration are proven.
- Do not silently preserve v1 global auto-application for compatibility, and do not migrate while a live v1 proxy can still flush it.
- Do not use strict hash-chained logs as a prerequisite for the authoritative atomic state snapshot; keep attempt history observational and visibly recoverable.

## Questions for Claude Fable 5

1. Does the exact-body/attempt design make a stronger claim than Node's HTTP boundary can prove? Which labels or gates remain dishonest?
2. Is the single-writer atomic JSON snapshot sufficient, or is SQLite/another journal required for the stated crash and retry guarantees?
3. Can session/branch identity be made safe with native metadata plus unique-extension mapping, or should inferred identity prohibit all persistent surgery?
4. Is removing inline labels/status by default compatible with agents reliably using the tool, or does it create an unusable control loop?
5. Are the surgery semantics conservative enough around Anthropic signed thinking, Codex encrypted reasoning, and tool pair structure?
6. Are the branch/agent ownership boundaries actually disjoint after the interface-freeze commit?
7. Which acceptance gates are still test-time theater rather than production guarantees?
8. Which work should be cut or reordered so exact payload truth and cross-session safety land early without leaving a long-lived mega-branch?
