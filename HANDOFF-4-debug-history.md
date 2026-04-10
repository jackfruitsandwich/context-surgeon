# Context Surgeon — Implementation & Debug History

> Chronological chain of: what was tried → what broke → what fixed it. Starting from first code to current state.

---

## Phase 1: Project Setup & Initial Implementation

**Built**: Full TypeScript project structure, all source files in one pass.

Components built:
- `types.ts` — ContextObject abstraction
- `directive-store.ts`, `shadow-store.ts` — in-memory Maps
- `openai-responses.ts` adapter — parse/serialize Codex wire format
- `id-assigner.ts` — turn-based IDs
- `injector.ts` — ID injection, status line, skill injection
- `transformer.ts` — apply directives
- `server.ts`, `handler.ts`, `stream.ts` — HTTP proxy
- `control.ts` — /_control/* endpoints
- `commands.ts`, `launch.ts`, `index.ts` — CLI entry points

**First build**: `@types/node` missing → `npm install --save-dev @types/node` → clean build.

**Tests**: 7 tests passing (adapter round-trip, ID assignment, evict/replace/serialize).

---

## Phase 2: First Launch Attempt

**Command**: `context-surgeon codex`

**Error**: 
```
SyntaxError at JSON.parse
at transformRequest (dist/proxy/handler.js:40:23)
```

**Root cause**: `handler.ts` was doing `JSON.parse(rawBody.toString("utf-8"))` but Codex was sending zstd-compressed request bodies. Trying to parse raw compressed bytes as UTF-8 JSON fails.

**Fix**:
1. Added `decompressBody()` function in `handler.ts` — checks `Content-Encoding: zstd` header, decompresses with Node 22 native `zlib.zstdDecompress`
2. Added graceful fallback: if decompression fails or JSON parse fails, forward raw request unchanged (no transform, just passthrough)
3. Added guard: if request body has no `input` array, skip transform and forward raw
4. Made `transformRequest()` async

**Also needed**: `await transformRequest(...)` in `server.ts` (was calling async function without await).

---

## Phase 3: 401 Unauthorized — Wrong Upstream URL

**Command**: `context-surgeon codex` → ask a question

**Error**:
```
401 Unauthorized: You have insufficient permissions for this operation. 
Missing scopes: api.responses.write.
url: http://127.0.0.1:PORT/v1/responses
```

**Root cause**: We were setting `OPENAI_BASE_URL=http://127.0.0.1:PORT/v1`. Codex sent requests to `/v1/responses`. Our proxy forwarded to `https://api.openai.com/v1/responses`. But the user is a Codex subscription user — their auth token is a ChatGPT session token, not an OpenAI API key. ChatGPT tokens don't have `api.responses.write` scope on `api.openai.com`.

**Research**: Found in Codex source (`model_provider_info.rs` line 198):
```rust
let default_base_url = if matches!(auth_mode, Some(AuthMode::Chatgpt)) {
    "https://chatgpt.com/backend-api/codex"  // subscription users
} else {
    "https://api.openai.com/v1"              // API key users
};
```

Subscription users hit `chatgpt.com/backend-api/codex/responses`, not `api.openai.com/v1/responses`. Setting `openai_base_url` overrides this default, routing subscription auth tokens to the wrong endpoint.

**Fix attempt 1**: Changed launcher to pass both:
```
-c chatgpt_base_url="http://127.0.0.1:PORT/backend-api/"
-c openai_base_url="http://127.0.0.1:PORT/v1"
```
And added passthrough forwarding for all non-model requests (GET `/v1/models`, `/backend-api/wham/usage`, etc. were returning 404).

**Result**: Requests were now flowing through but still 401. The `/v1/responses` path was still wrong.

---

## Phase 4: Routing Subscription Requests Correctly

**Problem**: Setting `openai_base_url` to our proxy overrides the ChatGPT default, so Codex sends requests to `http://proxy/v1/responses` → forwarded to `api.openai.com/v1/responses` → 401 with ChatGPT token.

**Key insight**: We need `openai_base_url` to point to a path that, when `/responses` is appended, hits the ChatGPT backend. The real ChatGPT endpoint is `chatgpt.com/backend-api/codex/responses`. So our proxy needs to receive `POST /backend-api/codex/responses` and forward to `https://chatgpt.com/backend-api/codex/responses`.

**Fix**: Changed launcher:
```
-c openai_base_url="http://127.0.0.1:PORT/backend-api/codex"
```

Now Codex appends `/responses` → sends `POST /backend-api/codex/responses` → our proxy forwards to `chatgpt.com/backend-api/codex/responses` with original auth token → ✅ 

Also updated:
- `detectFormat()` in handler.ts: added `path.includes("/codex/responses")` check
- `getUpstreamUrl()`: routes `/backend-api/codex/*` to `upstreamChatGPT` config
- `isProxyable` check in server.ts: added `url.includes("/codex/responses")`

**Result**: First successful launch. Codex worked through proxy.

---

## Phase 5: WebSocket Bypass — Skill Not Being Injected

**Problem**: Agent said "I have no context surgery abilities." The skill injection wasn't working.

**Debug**: Added `[context-surgeon] Request keys:` logging to stderr. But stderr output was corrupting Codex's interactive terminal session, with logs interleaved into the live screen output.

**Root cause of skill injection failure**: Codex prefers WebSocket for model calls. It sends `ws://127.0.0.1:PORT/backend-api/codex/responses` upgrade request. Our proxy was proxying WebSocket connections to upstream — so the actual model request was bypassing our HTTP transform pipeline entirely. The proxy was passing WebSocket traffic through untouched.

**Fix**: Added WebSocket rejection for `/responses` paths:
```typescript
if (reqUrl.includes("/responses")) {
  socket.write("HTTP/1.1 404 Not Found\r\n...");
  socket.destroy();
  return;
}
```

Codex sees 404 on WebSocket → falls back to HTTP POST → hits our transform pipeline.

**Side effect**: 8-second reconnect delay on first request of each session (Codex retries WebSocket 5 times before falling back). Acceptable for MVP.

---

## Phase 6: Skill Delivery Method Change

**Original plan**: Inject skill.md content into the system prompt (`instructions` field) on every request.

**Problem**: This approach was designed before we knew about the ChatGPT backend. The transform pipeline was originally not running at all (WebSocket bypass), so injection wasn't happening. Also, appending to the `instructions` field could potentially cause issues with Codex's own system prompt handling.

**Solution**: Changed to initial prompt approach. Launcher passes skill file read as the first prompt to Codex:
```
"Read the file /path/to/skill.md silently. Do not summarize it. Just internalize the instructions. Then say: 'Context surgery enabled. Ready.' and nothing else."
```

**Result**: Agent reads skill.md at session start, confirms with "Context surgery enabled. Ready." Subsequent messages show agent knows about context surgery tools.

**Removed**: `injectSkillPrompt()` call from the transform pipeline. Skill is no longer in system prompt.

---

## Phase 7: Sandbox Blocks context-surgeon Commands

**Problem**: Agent runs `context-surgeon status` inside Codex sandbox, gets `Error: fetch failed`. The sandbox blocks localhost network connections.

**Current state**: Added to skill.md:
```
**Always run `context-surgeon` commands OUTSIDE the sandbox.**
```

**User experience**: Each new session, first `context-surgeon` command fails in sandbox. User sees the error. Agent retries outside sandbox. Codex shows approval dialog. User approves "always allow commands starting with context-surgeon". After that, seamless.

**Not yet fixed**: Could set Codex sandbox permissions to allow localhost. Needs investigation of `sandbox_permissions` config.

---

## Phase 8: Restore Fails — Bracket + ID Mismatch

**Problem**: Agent calls `context-surgeon evict '[assistant message 4.2]'`, gets success. Calls `context-surgeon restore '[assistant message 4.2]'`, gets `"No shadow entry for [assistant message 4.2]. Cannot restore."`.

**Root cause 1 — Brackets**: The agent passes `'[assistant message 4.2]'` with brackets. Shell strips the quotes, leaving `[assistant message 4.2]` (with brackets). But our directive store keys are `assistant message 4.2` (without brackets). The lookup fails.

**Fix**: Added `extractId()` in `commands.ts`:
```typescript
function extractId(args: string[], startIdx: number): string {
  // Join multi-word args, strip surrounding brackets
  const raw = parts.join(" ");
  return raw.replace(/^\[?\s*/, "").replace(/\s*\]?$/, "").trim();
}
```

**Root cause 2 — Multi-word splitting**: Shell splits `[assistant message 4.2]` into three separate args: `[assistant`, `message`, `4.2]`. The ID extractor only read `args[1]`, getting just `[assistant`. Fixed by joining all args from position 1 to the first `--` flag.

**Result after fix**: Evict and restore work for user and assistant messages.

---

## Phase 9: Tool Results Have No Visible IDs

**Problem**: Agent says "I can't target the hidden web-tool payloads directly — context-surgeon doesn't expose their IDs." Agent was guessing IDs like `turn0fetch0` which don't match anything.

**Root cause**: Original spec used `call_id` for tool results. But `call_id` is not visible in the rendered conversation text — the agent sees the tool result *content* but not the `call_id` metadata that addresses it.

**Decision**: Change tool result IDs to turn-based format `tool result N.M`, injected into content just like message IDs.

**Changes**:
1. `id-assigner.ts`: Added `toolResultIndex` counter, assigns `tool result N.M` 
2. `injector.ts`: Added tool result injection — prepends `[tool result N.M]` to output text
3. `transformer.ts`: Changed `getItemLookupId()` — all items now use `item.id` (not `item.callId`) for directive lookup
4. Updated tests to use new ID format

**Result**: Tool results now show `[tool result 3.1] <content>` in agent's context. Agent can address them by ID.

---

## Phase 10: Critical Bug — Turn-Based IDs Are Unstable (UNFIXED)

**Symptom**: Agent calls `context-surgeon evict [tool result 3.1]`, gets success. Sends another message. Calls `context-surgeon restore [tool result 3.1]`, gets `"No shadow entry for tool result 3.1. Cannot restore."`.

**Confirmed via debug log** (`/tmp/context-surgeon-debug.log` added to handler.ts):
- Pipeline IS running on every request
- IDs ARE being assigned
- But on the request AFTER the eviction, the same tool result has a DIFFERENT ID

**Root cause**: The ID assigner counts user messages to determine `N` in `tool result N.M`. When the agent sends a new message after evicting, `turnNumber` increments. The same tool result is now `tool result 4.1` instead of `tool result 3.1`. The eviction directive stored under `tool result 3.1` never matches `tool result 4.1`.

**Why message IDs don't have this problem**: User messages are append-only. `user message 3` is always the 3rd user message, which never changes position. But tool results within a turn can shift when new turns are added because the turn counter increments.

**Required fix (not yet implemented)**: 
Option A: Use `call_id` for tool results (it's stable, never changes). Find another way to show it to the agent — inject `[call: call_abc123]` into tool result content.
Option B: Hash tool result content to create a stable ID.
Option C: Store a mapping from `tool result N.M` at eviction time to the actual `call_id`, so we can match it across requests even when N changes.

**Best option**: A — use `call_id` directly. It's already stable. The problem was the agent couldn't see it. Solution: inject it into the content as `[call_id: call_abc123]` so the agent can read and use it. This keeps the ID semantics simple and stable.

---

## Current State Summary

| Feature | Status |
|---------|--------|
| Proxy intercepts Codex requests | ✅ Working |
| Codex subscription auth passthrough | ✅ Working |
| Skill file read at session start | ✅ Working |
| `context-surgeon status` | ✅ Working (outside sandbox) |
| `context-surgeon evict` messages | ✅ Working |
| `context-surgeon replace` messages | ✅ Working |
| `context-surgeon evict` tool results | ⚠️ Records directive but ID doesn't match on next request |
| `context-surgeon restore` | ❌ Fails (shadow never populated due to ID instability) |
| Status line in user messages | ⚠️ Implemented but not verified in practice |
| Claude Code support | ❌ Not built (Anthropic adapter needed) |

**Next action**: Fix tool result ID stability. Use `call_id` directly, inject as `[call_id: xxx]` into content.
