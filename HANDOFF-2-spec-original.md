# Context Surgeon — Original Product Spec (Pre-Implementation)

> This is the spec we crystalized before writing any code. Reference this to understand original intent vs. what was actually built.

---

## Core Operations (MVP)

Three operations the agent can perform on its own context window:

1. **Evict** — replace content with `[evicted]`, freeing tokens
2. **Replace** — replace content with an agent-written summary
3. **Restore** — bring back original content from shadow store

**Non-goals for MVP**: automatic eviction rules, second model for summarization, persistent state across sessions, thinking block support, image support.

---

## Architecture

### Entry Point
```bash
context-surgeon codex    # wraps Codex
context-surgeon claude   # wraps Claude Code
```

1. Start HTTP proxy on random localhost port
2. Set `OPENAI_BASE_URL` (or `ANTHROPIC_BASE_URL`) to point to proxy
3. Spawn the CLI as a child process (inherits env)
4. CLI sends all API requests through proxy
5. Proxy modifies outgoing requests, streams responses back unmodified
6. When CLI exits, proxy exits

### Proxy Behavior Per Request
1. Receive request body from CLI
2. Parse into internal `ContextObject` abstraction
3. Assign turn-based IDs to user/assistant messages
4. Apply any pending eviction/replacement directives
5. Inject IDs into message content text
6. Inject status line into last user message
7. Forward modified request to real API
8. Pipe SSE response back unmodified (no response interception)

### Agent Interaction
The agent uses bash tool calls:
```bash
context-surgeon evict <id>
context-surgeon replace <id> --content "summary text"
context-surgeon restore <id>
context-surgeon status
```

These commands talk to the proxy's control API at `localhost:PORT/_control/*`.

### State
- **Directive store**: `Map<id, Directive>` — in-memory, per-session
- **Shadow store**: `Map<id, originalContent>` — in-memory, per-session
- **Both die when proxy exits** — no persistence between sessions

---

## Object Addressing

| Object | ID Format | Example |
|--------|-----------|---------|
| User messages | `user message N` | `user message 3` |
| Assistant messages | `assistant message N.M` | `assistant message 2.1` |
| Tool results | `call_id` (existing) | `call_abc123` |
| Tool calls | `call_id` (existing) | `call_abc123` |

IDs are injected as text prefixes into message content: `[user message 3] ...text...`

---

## Structural Integrity

- Never delete messages from the array — APIs require paired tool calls/results
- Replace content only, keep the skeleton
- When evicting a tool result, replace output with `"[evicted]"`
- When evicting a message, replace text blocks with `"[evicted]"`
- Tool call/result pairing (Anthropic: `tool_use_id`; OpenAI: `call_id`) must remain intact

---

## Status Line

Injected at the end of every user message on every request:
```
[context-surgeon: ~48,200/128,000 tokens (37.7%) | 3 evicted (15,420 tokens recoverable)]
```

Shows: estimated visible tokens, max tokens (configurable), percentage, evicted count and token estimate.

---

## Skill File

A `skill.md` file injected into the system prompt on every request. Teaches the agent:
- What tools are available and exact command syntax
- ID format for referencing objects
- When to evict (after phase transitions, large tool results no longer needed)
- When to replace (keep summary of important findings)
- How to check status
- Run context-surgeon commands outside the sandbox

**Decision**: Skip system prompt injection (format compatibility issues). Instead, pass skill file path as initial prompt: agent reads it silently at session start.

---

## Platform Support

**MVP**: Codex (OpenAI Responses API, `POST /backend-api/codex/responses` for subscription users)

**Release**: + Claude Code (Anthropic Messages API, `POST /v1/messages`)

**Later**: OpenCode, Hermes, desktop app

---

## Wire Format Abstraction

Provider-agnostic `ContextObject` type:
```typescript
type ContextObject = {
  systemPrompt: string;
  items: ContextItem[];
  rawRequest: Record<string, unknown>; // untouched fields
  format: "openai-responses" | "anthropic-messages";
};
```

Adapters handle format-specific parsing/serialization. Core logic (ID assignment, directive application, injection) is format-agnostic.

---

## Session Parallelism

Each `context-surgeon codex` invocation:
- Gets its own proxy on a random port
- Has completely isolated directive/shadow stores
- Port written to `~/.context-surgeon/port` for bash CLI discovery
- Multiple sessions = multiple proxies = zero interference

---

## Restore Behavior

- Agent calls `context-surgeon restore <id>`
- Proxy removes the eviction directive
- Shadow store content is restored on the **next API call** (not immediately)
- Agent does NOT see the content until the next API request
- If no shadow entry exists, return error: `"No shadow entry for X. Cannot restore."`
- MVP: refuse restore if shadow is empty (no overflow handling)

---

## Compaction Coexistence

All target CLIs track costs/compaction from API response token counts, not local estimates. If our proxy reduces tokens before forwarding:
- CLI sees the lower token count from the API response
- Compaction triggers later than it would without surgery
- Net effect: longer conversations, lower perceived cost

When the CLI's own compaction fires and removes old turns, directives referencing those turns become orphaned no-ops. This is acceptable behavior.

---

## Tech Stack

- Node.js 22+ (TypeScript)
- Zero runtime dependencies (Node built-ins only)
- `tsup` or `tsc` for build
- `vitest` for tests
- `npm install -g context-surgeon` for installation
- MIT license

---

## What We Decided NOT to Build (MVP)

- ❌ Automatic eviction rules
- ❌ Second model for summarization (agent writes its own)
- ❌ Persistent state across sessions (state dies with proxy)
- ❌ `--defer` flag on restore
- ❌ Thinking block support
- ❌ Image eviction support
- ❌ Cross-CLI conversation porting
- ❌ Codex desktop app support
- ❌ 24/7 daemon
- ❌ Shell alias modifications (`install` command)
