# Context Surgeon — Motivation, Goals, and Desired UX

## The Problem

AI coding agents (Claude Code, Codex, OpenCode) have no ability to manage their own context window. As conversations grow, stale tool results — file reads, web fetches, bash outputs — accumulate and consume tokens. This increases cost, degrades quality (signal-to-noise ratio drops), slows responses (more input tokens = higher latency), and eventually triggers crude automatic compaction that drops useful context indiscriminately.

Every CLI handles this the same way: let context grow until it hits a threshold, then do blunt compression. Nobody gives the agent fine-grained control over what stays and what goes.

## The Insight

What if the agent could edit its own context window? Not automatic pruning — deliberate, surgical decisions by the agent itself. "I finished my research phase, let me evict those web fetches. I'm about to start coding, let me keep only what's relevant."

This is a new primitive for agent architectures. Not an optimization — a behavior.

## Personal Goals

- Create a novel, open-source contribution to the AI agent field
- Position this as a new paradigm ("agent manages its own memory")
- Get coverage in AI newsletters, YouTube channels, developer communities
- Become the reference implementation that other frameworks adopt
- Name recognition among early adopters

## Virality Strategy

- Lead with a compelling demo video (token counter dropping visually)
- Frame as a paradigm shift, not a feature: "We gave an AI agent a delete key for its own context"
- Blog post + spec defining "context surgery" as a concept
- Launch simultaneously on Twitter, HN, Reddit (r/LocalLLaMA, r/ClaudeAI)
- The product must be installable and usable in under 60 seconds
- Must work with existing workflows — no behavior change required from the user
- Back the launch with real before/after token usage data from actual sessions

## Desired UX

### Installation
```bash
npm install -g context-surgeon
```

### Usage
```bash
context-surgeon codex    # launches Codex with context surgery enabled
context-surgeon claude   # launches Claude Code with context surgery enabled
```

The user types their normal command with `context-surgeon` prepended. Everything else is identical to their normal workflow. The proxy starts automatically, runs invisibly, and shuts down when the CLI exits.

### Agent Experience

The agent reads a skill file at session start that teaches it about context surgery. It then has three bash commands available:

- `context-surgeon evict <id>` — remove content, keep skeleton
- `context-surgeon replace <id> --content "summary"` — replace with agent-written summary
- `context-surgeon restore <id>` — bring back evicted/replaced content
- `context-surgeon status` — show current context state

The agent decides when and what to prune. The human never interacts with context surgery directly.

### What Success Looks Like

- Conversations run 2-3x longer before hitting context limits
- Cost per conversation drops measurably (backed by real session data)
- Agent quality improves on long tasks (less noise, more focus)
- The agent naturally manages context without being prompted — emergent behavior

---

## Additional Context / Lessons Learned

### On Marketing
- The narrative is 80% of the launch. The code is 20%. Lead with the concept, not the implementation.
- "Invisible automatic optimization" is less compelling than "agent that manages its own memory" — the meta angle is the story.
- Don't lead with "proxy" in marketing — lead with the capability. The proxy is an implementation detail.
- The blog post should include real before/after token usage data from actual sessions.

### On Distribution
- The proxy architecture was initially a concern for distribution (feels "hacky", could be banned). But it's just a URL rewrite on localhost — perfectly safe, used by enterprise customers constantly.
- The real issue with the proxy is perception, not reality. The wrapper approach (`context-surgeon codex`) sidesteps this — the user never thinks about proxies.
- npm install -g + shell alias = one-command install. Instant gratification.

### On Future Platform Support
- **Codex desktop app**: Reads the same `~/.codex/config.toml` as the CLI. But app doesn't launch through our wrapper, so we can't start/stop proxies dynamically. Would require a daemon approach with `openai_base_url` written to config.toml, or a Codex plugin. This is v2.
- **OpenCode**: Stores sessions in SQLite and re-queries on every turn — editing the DB mid-session works immediately. We could build a direct integration without a proxy for OpenCode.
- **Hermes**: Python agent framework. Has direct access to the messages list in memory. Could add context surgery tools directly as Hermes skills with no proxy needed.
- **Claude Code**: Not open source, compiled Bun binary. JSONL session storage, held in memory. Same proxy approach as Codex. MCP server approach could work for delivering tools but can't modify the messages array.

### On the Agent Behavior
- The agent will try to manage its context even without explicit instructions — the tools just need to exist and be discoverable.
- Codex runs bash commands in a sandbox that blocks localhost network by default. The agent needs to run context-surgeon commands outside the sandbox. This is a known friction point.
- The agent naturally understands "evict the search results I don't need anymore" when the tools are explained to it.
