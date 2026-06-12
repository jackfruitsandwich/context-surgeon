# context-surgeon

Give your agents the ability to edit their own context window.

<!-- TODO: Replace with actual demo GIF -->
<!-- ![Demo](demo.gif) -->

---

Your AI agent accumulates stale file reads, web fetches, and bash outputs as it works. Each one sits in the context window forever, eating tokens, slowing responses, and eventually triggering crude auto-compaction that throws away things you still need.

**context-surgeon** gives the agent three surgical tools — **evict**, **replace**, and **restore** — so it can manage its own memory. The agent decides what to keep and what to discard. Token usage drops in real-time. Conversations run longer. The agent stays focused.

Works with **Codex CLI** and **Claude Code**. One command to install. Zero config.

## Install

```bash
npm install -g context-surgeon
```

Requires Node.js 22+.

## Usage

```bash
# Wrap your CLI — everything else stays the same
context-surgeon codex
context-surgeon claude

# Or expose the proxy to Cursor IDE (BYOK mode)
context-surgeon cursor
```

That's it. The agent reads its instructions automatically and gains context surgery abilities. You use your CLI exactly as before.

### What the agent can do

```bash
# Evict — remove content from context, keep a placeholder
context-surgeon evict "tool result 2.1"

# Replace — swap content with a shorter summary the agent writes
context-surgeon replace "tool result 2.1" --content "Express server on port 3000, GET / route"

# Restore — bring back the original content
context-surgeon restore "tool result 2.1"

# Status — see what's in context and what's been evicted
context-surgeon status

# Evict just the images from a message, keep the text
context-surgeon evict "user message 3" --media image
```

The agent calls these through its shell tool during normal operation. You don't need to do anything.

## How it works

```
You run:  context-surgeon codex
          ├── starts a local proxy on a random port
          ├── points Codex at the proxy
          ├── proxy intercepts every API request
          │   ├── assigns IDs to messages and tool results
          │   ├── applies any evict/replace directives
          │   ├── injects a status line (token count, eviction state)
          │   └── forwards the modified request to the real API
          ├── streams the response back unmodified
          └── when Codex exits, the proxy exits
```

The proxy is ephemeral — it lives only as long as your CLI session. No background daemons, no config files, no cleanup.

When the agent calls `context-surgeon evict`, the CLI records the directive. On the next API request, the proxy replaces the evicted content with `[evicted]`. The original content is saved in a shadow store so it can be restored later.

### What the agent sees

Every message and tool result gets a bracketed ID:

```
[user message 1] Read the file src/app.ts

[assistant message 1.1] I'll read that file for you.

[tool result 1.1] import express from 'express';
const app = express();
...

[assistant message 1.2] Here's the content of src/app.ts.
```

After eviction:

```
[tool result 1.1] [evicted]
```

A status line appears at the end of each user message:

```
[context-surgeon: ~48,200 / 128,000 tokens (37.7%) | 2 evicted (12,400 tokens saved)]
```

## Supported platforms

| Platform | Status |
|----------|--------|
| Codex CLI (subscription + API key) | Supported |
| Claude Code | Supported |
| Cursor IDE (custom API key) | Experimental |
| Codex desktop app | Not yet (requires daemon approach) |

### Cursor IDE setup

Cursor routes all model calls through its own backend — even with your own API
key — so the proxy must be reachable from the public internet. `context-surgeon
cursor` starts the proxy plus a [cloudflared quick
tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
(install with `brew install cloudflared`) and prints a public URL:

1. Run `context-surgeon cursor`
2. In Cursor: Settings → Models → API Keys → enable **OpenAI API Key** and paste your key
3. Enable **Override OpenAI Base URL** and paste the printed tunnel URL
4. Click Verify, pick an OpenAI model, and chat

The agent runs `context-surgeon evict/replace/restore/status` through the
integrated terminal as usual. Caveats: custom API keys are billed to your
OpenAI account, only work with chat models (Tab stays on Cursor's models), and
agent mode support varies. Your prompts transit the tunnel; the tunnel URL is
unguessable but treat it as sensitive.

## Architecture

```
context-surgeon/
├── src/
│   ├── proxy/          # HTTP proxy server, request pipeline, SSE streaming
│   ├── context/        # ID assignment, injection, directive transformer
│   ├── adapters/       # OpenAI Responses API + Anthropic Messages API
│   ├── store/          # In-memory directive store + shadow store
│   ├── api/            # Control endpoints (evict, replace, restore, status)
│   └── cli/            # Launcher (wraps CLI) + command handler
```

- **Zero runtime dependencies** — built on Node.js built-ins only
- **Format-agnostic core** — the same eviction logic works across API formats
- **Proxy-per-session** — each CLI invocation gets its own isolated proxy

## Known limitations

- **Subagent ID overlap**: In Claude Code, subagent messages share the ID namespace with the parent. Evicting a parent message may affect a subagent message with the same ID. Working on a fix.
- **Claude Code `/` commands**: Some slash commands may interact unexpectedly with the proxy. If you hit issues, restart the session.
- **Session state is ephemeral**: Eviction directives are lost when the session ends

## How is this different from auto-compaction?

Auto-compaction is a blunt instrument — it fires when context is full and drops old content indiscriminately. Context surgery is a scalpel — the agent decides what to keep, what to discard, and what to summarize based on what it's working on right now. The agent can evict a 15KB web fetch result right after answering the question, freeing space immediately instead of waiting for a threshold.

## FAQ

**Does this save money?**
Yes. Fewer input tokens = lower API costs. All supported CLIs display token usage from the API response, so you see the real savings in your CLI's token counter.

**Does the agent do this automatically?**
The agent learns about context surgery from a skill file loaded at session start. It then uses the tools when it judges they're helpful — typically after research phases, before implementation phases, or when context is getting full. You can also ask it to evict specific items.

**Is this safe to use?**
The proxy only modifies the outgoing request body. It doesn't touch API keys, doesn't log content, and doesn't persist anything to disk. When the session ends, everything is gone.

**Why a proxy and not an MCP server?**
MCP servers can add tools but can't modify the messages array that gets sent to the API. To actually remove content from context, you need to intercept the request. The proxy is the only approach that works universally.

## Contributing

PRs welcome. The main areas that need work:

- Codex desktop app support (daemon + config.toml approach)
- Persistent state across sessions (export/import directives)
- Automatic eviction rules (config-driven, e.g. "auto-evict web fetches after 3 turns")
- OpenCode direct integration (SQLite, no proxy needed)
- Cross-CLI conversation porting

## License

MIT
