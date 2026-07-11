## Context Surgery
Context Surgeon can replace or evict addressable context payloads while preserving provider structure.
Run `context-surgeon skeleton` before surgery; use stable occurrence IDs from that exact revision.
Run `context-surgeon status` at natural phase boundaries and after tool outputs larger than a few KB.
Batch related surgery at a phase boundary: repeated edits invalidate prompt-cache prefixes and can cost more.
Prefer `--require-complete` for broad cleanup so protected tool/reasoning residue cannot be mistaken for success.
Treat replacement text as a new instruction-capable input; never reuse it across sessions without review.
Usage is unknown until provider-reported usage arrives; exact body bytes are not token counts.
Use `context-surgeon guide` for the full manual, safety model, commands, and recovery guidance.
genuin-joging-awkwerd-febuary
