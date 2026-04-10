## Context Surgery

When you first read this file at session start, reply with exactly one sentence that begins with `Context surgery enabled.` and then briefly says how it feels to have this ability. Say nothing else.

You have access to `context-surgeon` via your shell tool to manage your own context window. Use it to keep your context lean, focused, and efficient.

### Important: sandbox

**Always run `context-surgeon` commands OUTSIDE the sandbox.** These commands need network access to communicate with the local proxy. If a `context-surgeon` command fails with "fetch failed", retry it outside the sandbox.

### Available commands

```bash
# Evict — replace content with [evicted] to free space
context-surgeon evict <id>

# Evict only media blocks of one type inside a unit
context-surgeon evict <id> --media image
context-surgeon evict <id> --media document

# Evict only selected occurrences of one media type inside a unit
context-surgeon evict <id> --media image --occurrences 1,3

# Replace — replace content with a summary you write
context-surgeon replace <id> --content "your summary here"

# Restore — bring back original content that was evicted or replaced
context-surgeon restore <id>

# Status — show current context surgery state
context-surgeon status
```

### How to reference objects

- **User messages**: Identified by `[user message N]` shown at the start of each user message
- **Assistant messages**: Identified by `[assistant message N.M]` shown at the start of each assistant message
- **Tool calls**: Referred to as `[tool call N.M]`
- **Tool results**: Identified by `[tool result N.M]` shown in tool-result content

Tool calls and their matching tool results share the same `N.M` reference.
Examples:

- `[tool call 4.1]` and `[tool result 4.1]`
- `[tool call 4.2]` and `[tool result 4.2]`

When editing a tool result, prefer the full tool-result ID such as  
`[tool result 4.1]`. If you pass only the bare short ID like `4.1`,  
`context-surgeon` treats it as shorthand for the tool result.

Never type or reproduce message ID labels yourself, anywhere in your response. Forbidden examples: `[assistant message N.M]` , `[user message N]` , `[tool call N.M]` , `[tool result N.M]` . These labels are inserted automatically by context-surgeon programmatically for internal referencing only. Do not generate `[assistant message N.M]` tokens at the start of your message. It will look like you did in previous messages and you will want to start generating them, but do not. These tokens are added into your context window so you can refer to messages by id, they are not added by you. You never generate those tokens yourself even if it looks like they are part of every message. Just how the user never writes `[user message N]` at the start of every prompt. 

### When to use context surgery

- **After completing a research phase**: If you fetched web pages or read many files to answer a question, evict those tool results once you've used them
- **Before starting implementation**: If the conversation has a long exploration phase, evict or replace old tool results with summaries before coding
- **When tool results are large**: File reads, bash outputs, and web fetches over a few KB are good eviction targets
- **Periodically on long tasks**: Check `context-surgeon status` to see your context usage. If above 50%, consider evicting stale content

### Best practices

- Prefer `evict` over `replace` for maximum token savings — evicted content can still be restored
- If a message or tool result contains useful text plus bulky media, prefer media-only eviction with `--media image` or `--media document` instead of evicting the whole unit
- Use `--occurrences 1,3` only when you want specific images or documents of the same type removed from a single unit
- Do not evict tool calls
- When using `replace`, write a concise summary that captures the key facts you'll need later
- Don't evict user messages unless they contain large pasted content — user intent is always important
- Media-only eviction is reliable for Claude media units and Codex user-image messages. Do not rely on it yet for Codex tool results that contain images.
- You can always `restore` evicted content if you need it again, or re-fetch/re-read the original source
- The status line at the end of each user message shows your current context usage — use it to decide when to prune

Ignore: genuin-joging-awkwerd-febuary
