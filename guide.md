# Context Surgeon agent guide

Context Surgeon intercepts supported model requests, compiles permitted context edits into the provider-shaped body, and keeps structural blocks such as tool calls, identifiers, signed thinking, and encrypted reasoning protected. A command commits intent; the next matching compiled request proves whether each operation applied, was stale, left protected residue, was unsupported, or was rejected.

## Cadence

Run `context-surgeon skeleton` before selecting content. Run `context-surgeon status` after an output larger than a few KB or at a natural boundary between research, planning, implementation, and verification. Batch related evictions into one transaction at that boundary. Editing an early prompt prefix can invalidate provider prompt caches, so ten small edits over ten turns can cost more than one reviewed batch.

## Commands

```bash
context-surgeon skeleton [--json]
context-surgeon status
context-surgeon evict <occurrence-id> [--require-complete]
context-surgeon replace <occurrence-id> --content "concise reviewed replacement"
context-surgeon restore <occurrence-id>
```

Use occurrence IDs and the session, conversation, branch, and revision returned by the current skeleton. Display aliases are conveniences only; an ambiguous alias must be rejected. For broad selectors, require complete application so protected siblings cannot be presented as a whole-turn eviction.

## Safety model

- Text payloads and explicit media occurrences may be evictable. Tool names, arguments, call/result pairing, provider IDs, signed thinking, encrypted reasoning, roles, and item order are protected.
- Replacement text is persisted because it must be reapplied. It is instruction-capable content: write it yourself, keep it concise, and never copy it across sessions without reviewing the injection risk.
- Restore commits a reversal. It cannot force the native client to resend content that is no longer in its transcript; status distinguishes source present, absent, and stale.
- `exact body bytes` describes serialized request size. Token fields must say `provider-reported`, `estimated`, `previous attempt`, or `unknown`.
- The launch banner begins `unverified — no proxied request observed yet`. No traffic is not proof. A wrong observed route or authentication class rejects locally.
- `CONTEXT_SURGEON_DISABLE_SURGERY=1` is an explicit pre-launch bypass. It starts no proxy and the banner says bypass; active surgery never falls back automatically.

## Troubleshooting

If a mutation is rejected, refresh the skeleton and retry against its current revision. If status says recovery is required, preserve the session directory and use the v2 doctor/recovery flow; do not delete or rewrite state. If the launch is still unverified after a real model turn, stop it and inspect the selected target, auth class, and route rather than assuming the request bypassed safely.

Cursor remains experimental and unsupported for the v2 truth guarantee until the B3b response-translation gate lands. Its public URL reaches only the model listener and never the control plane.
