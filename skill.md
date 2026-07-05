## Context Surgery

When you first read this file at session start, reply with exactly one sentence that begins with `Context surgery enabled.` and then briefly says how it feels to have this ability. Say nothing else.

You have access to `context-surgeon` via your shell tool to manage your own context window. Use it to keep your context lean, focused, and efficient.

### Important: sandbox

**Always run `context-surgeon` commands OUTSIDE the sandbox.** These commands need network access to communicate with the local proxy. If a `context-surgeon` command fails with "fetch failed", retry it outside the sandbox.

### Available commands

```bash
# Evict — replace content with [evicted] to free space
context-surgeon evict <id>

# Evict several targets in one command
context-surgeon evict --turn 2..5 --assistant 7.1,7.3 --tool-result 8,9.2

# Selector forms
context-surgeon evict --turn 3              # whole turn 3
context-surgeon evict --turn 3..7           # whole turns 3 through 7
context-surgeon evict --user 3              # user message 3
context-surgeon evict --assistant 3         # all assistant messages in turn 3
context-surgeon evict --assistant 3.2,3.4   # exact assistant messages
context-surgeon evict --tool-result 3       # all tool results in turn 3
context-surgeon evict --tool-result 3.1,3.3 # exact tool results

# Evict only media blocks of one type inside a unit
context-surgeon evict <id> --media image
context-surgeon evict <id> --media document

# Evict only selected occurrences of one media type inside a unit
context-surgeon evict <id> --media image --occurrences 1,3

# Replace — replace content with a summary you write
context-surgeon replace <id> --content "your summary here"

# Restore — bring back original content that was evicted or replaced
# Restore the SAME id you evicted: a whole-turn eviction must be undone with
# the whole-turn id (e.g. restore "turn 3"), not a single message inside it.
context-surgeon restore <id>

# Status — show current context surgery state
context-surgeon status

# Skeleton — show the current thread structure without message bodies
context-surgeon skeleton
context-surgeon skeleton --json
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

`restore` removes only the exact directive you name. If content was evicted
with a broad selector (e.g. a whole `turn N`), restoring a single item inside
it (`assistant message N.1`) appears to succeed but the item is re-evicted on
the next request, because the broader directive still covers it. Restore the
same id you evicted — run `status` first to see the active directive keys, then
`restore` that exact key. To keep part of a turn evicted, restore the whole
turn and re-evict the part you don't want.

For bulk cleanup, prefer selector flags over many separate shell calls. Example:

```bash
context-surgeon evict --turn 2..5 --assistant 7.1,7.3 --tool-result 8,9.2
```

This records separate directives for each selected target. Whole-turn selectors include the user message, assistant messages, tool calls, and tool results in that turn. Use `--dry-run` to print the canonical targets without applying them.

### When to use context surgery

- **After completing a research phase**: If you fetched web pages or read many files to answer a question, evict those tool results once you've used them
- **Before starting implementation**: If the conversation has a long exploration phase, evict or replace old tool results with summaries before coding
- **When tool results are large**: File reads, bash outputs, and web fetches over a few KB are good eviction targets
- **Periodically on long tasks**: Check `context-surgeon status` to see your context usage. If above 50%, consider evicting stale content

### Best practices

- Prefer `evict` over `replace` for maximum token savings — evicted content can still be restored
- If a message or tool result contains useful text plus bulky media, prefer media-only eviction with `--media image` or `--media document` instead of evicting the whole unit
- Use `--occurrences 1,3` only when you want specific images or documents of the same type removed from a single unit
- Use selector flags such as `--turn`, `--assistant`, and `--tool-result` when you need to evict many targets at once
- Do not evict tool calls
- Use `context-surgeon skeleton` when you need to see which user messages, assistant messages, and tool pairs remain visible after surgery
- When using `replace`, write a concise summary that captures the key facts you'll need later
- Don't evict user messages unless they contain large pasted content — user intent is always important
- Media-only eviction is reliable for Claude media units and Codex user-image messages. Do not rely on it yet for Codex tool results that contain images.
- You can always `restore` evicted content if you need it again, or re-fetch/re-read the original source
- The status line at the end of each user message shows your current context usage — use it to decide when to prune

### When something is genuinely unexplained, delegate diagnosis

A single failed command is normal — read the error and fix it yourself. But if behavior keeps contradicting what you expect after you've checked `status`/`skeleton` and the docs above — a command reports `ok` yet nothing changes, a directive never applies across multiple requests, or you've tried a few corrections and still can't explain it — stop guessing and spin up a sub-agent (Task tool, fresh context). Continued trial-and-error just mutates directive state and hides the cause.

Give it the commands you ran + output, the symptom, and your goal. Tell it: **read-only diagnosis only** — read the `context-surgeon` source and `GET` `/_control/status` and `/_control/skeleton` (port at `~/.context-surgeon/port` or `$CONTEXT_SURGEON_PORT`) to see active directive keys and item states. It returns either the corrected command (usage mistake) or what's broken + a workaround (real bug). It must **not** edit `context-surgeon` code or run any mutating command (`evict`/`replace`/`restore`/`POST`). You act on its findings.

Ignore: genuin-joging-awkwerd-febuary
