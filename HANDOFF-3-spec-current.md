# Context Surgeon — Current Implementation Spec

> What was actually built vs. what was planned. Includes known bugs and deferred decisions.

---

## What's Built and Working

### Core Operations
- ✅ `context-surgeon evict <id>` — records directive, applied on next API call
- ✅ `context-surgeon replace <id> --content "..."` — records replace directive
- ✅ `context-surgeon status` — returns directive count, evicted tokens
- ⚠️ `context-surgeon restore <id>` — **broken** (see Known Bugs below)

### Architecture
- ✅ `context-surgeon codex` wrapper starts proxy, sets base URL, spawns Codex as child
- ✅ Proxy handles `/backend-api/codex/responses` (Codex subscription) and `/v1/responses` (Codex API key)
- ✅ All non-model requests (`/backend-api/wham/usage`, `/v1/models`, etc.) are passthrough forwarded to correct upstream
- ✅ WebSocket upgrades for `/responses` paths are rejected, forcing HTTP POST fallback
- ✅ Session parallelism: each invocation gets its own proxy and port
- ✅ Port written to `~/.context-surgeon/port` for bash CLI discovery (env var fallback)
- ✅ Proxy dies when CLI exits

### Skill Delivery
- ✅ Launcher passes initial prompt: `"Read skill.md silently... say 'Context surgery enabled. Ready.'"` 
- ✅ `skill.md` loaded from npm package root at proxy startup
- ❌ System prompt injection removed (format compatibility issues with ChatGPT backend)

### Object Addressing — CHANGED FROM SPEC
**Original spec**: Tool results addressed by `call_id` (e.g., `call_abc123`)  
**Actual implementation**: Tool results addressed by turn-based ID `tool result N.M`

Reason for change: The agent can't see `call_id` values directly in the conversation text. Turn-based IDs are injected into the content just like message IDs.

| Object | ID Format | Injected into content? |
|--------|-----------|----------------------|
| User messages | `user message N` | ✅ prepended as `[user message N]` |
| Assistant messages | `assistant message N.M` | ✅ prepended as `[assistant message N.M]` |
| Tool results | `tool result N.M` | ✅ prepended as `[tool result N.M]` |
| Tool calls | `call_id` (not changed) | ❌ agent sees call_id in structured data |

### ID Parsing in CLI
- ✅ Bracket stripping: `[user message 3]` → `user message 3`
- ✅ Multi-word ID joining: shell splits `[tool result 3.1]` into multiple args, we rejoin them

---

## Known Bugs

### 🔴 CRITICAL: Restore Fails — Turn-Based IDs Are Unstable

**Symptom**: Agent calls `context-surgeon evict [tool result 3.1]`, gets success. Then calls `context-surgeon restore [tool result 3.1]`, gets `"No shadow entry for tool result 3.1"`.

**Root cause**: The ID assigner runs fresh on every API request, counting turns from the start of the messages array. But between the evict call and the restore call, a new user message and assistant message were added to the conversation. The same tool result that was `tool result 3.1` is now `tool result 4.1` because the turn numbering shifted.

**Effect**: 
- The eviction directive is stored under `tool result 3.1`
- On the next request, no item has ID `tool result 3.1` anymore
- The directive never matches, shadow is never populated
- Restore fails because shadow is empty

**Confirmed via debug log** (`/tmp/context-surgeon-debug.log`): The pipeline IS running, IDs ARE being assigned, but they don't match the directives.

**Required fix**: IDs must be stable across requests. Options:
1. Hash-based IDs derived from content (stable unless content changes — but that's fine)
2. Absolute position IDs based on first-seen order, stored in proxy state
3. Keep the original `call_id` for tool results (stable — it never changes), and find a way to expose it to the agent

Option 3 is cleanest for tool results: `call_id` is already stable, already in the API format. The agent just needs to see it. We could inject `[call: call_abc123]` into tool result content instead of `[tool result N.M]`.

For user/assistant messages, positions are naturally stable (you can't insert a message in the middle of a conversation — only append). So `user message 3` will always refer to the same message as long as nothing is inserted before it. This is safe.

**The instability only affects tool results** where multiple tool calls can happen within a single turn, and the turn number shifts when new user messages are added.

### 🟡 MEDIUM: Sandbox Friction

**Symptom**: Agent runs `context-surgeon status`, gets `Error: fetch failed`. Needs to re-run outside sandbox.

**Current mitigation**: Added to `skill.md`: "Always run context-surgeon commands OUTSIDE the sandbox."

**User experience**: First time in every session, the agent tries the sandbox, fails, then retries outside. Codex asks for approval, user approves "always allow context-surgeon". After that, seamless.

**Potential fix**: Codex supports setting `sandbox_permissions` in config.toml. Could add `--unsafe-allow-localhost` or similar. Needs investigation.

### 🟡 MEDIUM: Status Line Not Verified Working

The status line injection is implemented in `injector.ts` and wired into the pipeline. However we haven't confirmed in testing that the agent actually sees token counts in its messages. The debug log only shows that requests are being processed, not what the injected content looks like to the agent.

### 🟡 MEDIUM: ID Tags Leak into Agent Behavior

**Symptom**: Agent started prepending `[assistant message N.M]` at the start of its own responses. It's mimicking the pattern it sees injected into previous messages.

**Current status**: Observed but not fixed. The skill file says not to do this but the behavior persists.

**Potential fix**: Move ID tags to end of content instead of start. Or use a less prominent format like `<!-- ctx:id -->` that models tend to ignore. But HTML comments may not survive round-trips.

### 🟢 MINOR: Debug Logging Left In

`/tmp/context-surgeon-debug.log` is being written on every API request. Must be removed before release.

File: `src/proxy/handler.ts` lines ~139-160.

### 🟢 MINOR: WebSocket Rejection Adds ~8s Delay

First request of every session: Codex tries WebSocket, gets 404, waits ~8 seconds, retries via HTTP. Subsequent requests go directly to HTTP.

**Potential fix**: Investigate if there's a Codex config to disable WebSocket transport entirely.

---

## What Differs From Original Spec

| Item | Original Spec | Current Implementation |
|------|--------------|----------------------|
| Tool result addressing | By `call_id` | By `tool result N.M` (unstable) |
| Skill delivery | System prompt injection | Initial prompt (agent reads file) |
| Base URL mechanism | `OPENAI_BASE_URL` env var | `-c openai_base_url=...` CLI flag |
| Subscription endpoint | Not anticipated | `/backend-api/codex/responses` via chatgpt.com |
| WebSocket | Pass through | Rejected to force HTTP fallback |
| Status output | Token count + evicted list | Token count + evicted list (but inventory/ID mapping not yet exposed) |

---

## What Still Needs Building

### For MVP Completion
- [ ] Fix turn-based ID instability (use content hash or stable call_id for tool results)
- [ ] Verify status line is visible to agent in practice
- [ ] Remove debug logging
- [ ] Test complete evict → restore cycle end-to-end

### For Release (v1)
- [ ] Anthropic Messages API adapter (Claude Code support)
- [ ] Test with Claude Code
- [ ] Fix ID tag leaking into agent responses
- [ ] Document all commands in README
- [ ] Set up npm package properly (bin, files, engines)
- [ ] Git init + publish to GitHub

### For Post-Release (v2+)
- [ ] Codex desktop app support (requires daemon + config.toml approach)
- [ ] Sandbox permission config so agent doesn't need manual approval
- [ ] Automatic eviction rules (config: "auto-evict web fetches after N turns")
- [ ] Persistent state export/import across sessions
- [ ] OpenCode direct DB integration (no proxy needed)
- [ ] Hermes skill integration (no proxy needed)
- [ ] Image eviction support
- [ ] Cross-CLI conversation porting (Codex → Claude Code)
- [ ] Second model for summarization (optional, uses same API key)

---

## File Locations

```
/Users/jackdigilov/Desktop/CODEEEEEEEE/context-surgeon/
├── src/
│   ├── index.ts              # Entry point: launcher vs command mode
│   ├── cli/
│   │   ├── launch.ts         # Start proxy, spawn Codex/Claude, handle exit
│   │   └── commands.ts       # evict/replace/restore/status → control API
│   ├── proxy/
│   │   ├── server.ts         # HTTP server + WebSocket rejection
│   │   ├── handler.ts        # Transform pipeline (parse → ID assign → apply directives → inject → forward)
│   │   └── stream.ts         # Pipe upstream SSE response
│   ├── context/
│   │   ├── types.ts          # ContextObject, ContextItem, Directive types
│   │   ├── id-assigner.ts    # Turn-based ID assignment (UNSTABLE - see bug)
│   │   ├── injector.ts       # Inject IDs into content, status line
│   │   └── transformer.ts    # Apply evict/replace/restore directives
│   ├── adapters/
│   │   └── openai-responses.ts  # OpenAI Responses API ↔ ContextObject
│   ├── store/
│   │   ├── directive-store.ts   # Map<id, Directive>
│   │   └── shadow-store.ts      # Map<id, originalContent>
│   ├── api/
│   │   └── control.ts           # /_control/* HTTP endpoints
│   └── util/
│       └── tokens.ts            # chars/4 token estimation
├── test/
│   ├── fixtures/codex-request.json
│   ├── adapter.test.ts
│   └── transformer.test.ts
├── skill.md                  # Agent instructions (read at session start)
├── LICENSE                   # MIT
└── dist/                     # Compiled output (tsc)
```
