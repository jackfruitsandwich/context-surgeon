# context-surgeon

Context Surgeon is a fail-closed model-request proxy for explicitly replacing or evicting addressable context payloads while preserving provider structure.

Version 2 integrates the exact request compiler, durable per-session surgery state, authenticated control plane, and fail-closed launcher as one production path. A requested edit is first **committed** as intent. It is called **applied** only when the next matching request is compiled and the exact serialized payload contains that edit.

## Install and use

```bash
npm install -g context-surgeon@2

context-surgeon codex [codex arguments]
context-surgeon claude [claude arguments]
context-surgeon guide
```

Node.js 22 or newer is required.

Every active launch begins unverified:

```text
surgery guarantee: unverified — no proxied request observed yet
```

Silence stays unverified. An observed route or authentication class that does not match the selected launch mode is rejected locally. Context Surgeon never changes an active surgery launch into a paid unmodified request. To choose native behavior before launch, set `CONTEXT_SURGEON_DISABLE_SURGERY=1`; the proxy is not started and the banner says `BYPASS`.

## Launch support

| Client mode | Behavior |
|---|---|
| Codex, ChatGPT subscription login | Supported: detected with `codex login status`; Codex keeps its native credential and sends through a dedicated local provider configuration |
| Codex, API-key login, `OPENAI_API_KEY`, or `CODEX_API_KEY` with `codex exec` | Implemented and fake-upstream verified: dedicated Responses provider; an environment key is named, never copied into arguments or logs. A real API-key smoke was not available in this release environment |
| Codex `--profile` | Rejected because the profile can change provider/auth routing |
| Codex custom `model_provider` or base URL | Rejected; B3 never overwrites a custom backend |
| Codex `--oss` | Rejected; the local backend is not redirected |
| Codex remote, app, cloud, or server modes | Rejected because they do not preserve one wrapped child session and one observable model-request path |
| Claude Code, native Anthropic configuration | Supported |
| Claude Code with an existing `ANTHROPIC_BASE_URL` | Rejected; B3 never overwrites a custom backend |
| Cursor | Experimental and unsupported for the v2 truth guarantee until B3b; requires explicit `--experimental` |

Codex configuration uses a dedicated `model_providers.context_surgeon_*` entry passed inside the active Codex command scope (`exec`, `review`, `resume`, or the interactive root). Context Surgeon rejects command-line provider definitions that could override the loopback route after injection. It does not set unconditional `chatgpt_base_url` or `openai_base_url` overrides. Cursor's tunnel targets only the loopback model port. `/_control` on that port returns a local 404 and is never forwarded.

Claude nonessential network traffic and prompt suggestions are disabled by default because Claude Code otherwise sends a second full-context background request after a response. That request costs context and creates a competing history before the next user turn. Existing `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` values and explicit `--prompt-suggestions` flags are preserved; surgery will reject rather than guess if an override produces ambiguous histories.

## What is persisted

Each launch owns one mode-0700 session directory under `~/.context-surgeon/sessions`. Its durable content classes are:

- session/conversation/branch identifiers and revisions;
- surgery, reversal, receipt, and operation-idempotency identifiers;
- occurrence identifiers, provider paths, operation outcomes, timestamps, and source/output SHA-256 hashes;
- surgery actions and user-authored replacement text, because replacement text is required to reapply that operation;
- observational attempt metadata: method, upstream endpoint, exact-body hash and byte length, exact-scope hash, non-secret semantic header classifications, lifecycle state, compiler operation outcomes, response status, and provider-reported usage when observed;
- while the process is live, a mode-0600 control record containing local ownership/address metadata and a random per-session capability.

V2 does **not** persist original prompt/response bodies, content previews, authorization or cookie values, secret digests, or a fictional “shadow store.” A torn final attempt-ledger line is ignored in favor of the latest complete observation; it cannot corrupt authoritative surgery state.

An existing `~/.context-surgeon/directives.json` is legacy v1 evidence only. V2 never loads it as active authority, never applies it across sessions, and never deletes it automatically. `context-surgeon doctor` reports migration evidence; rebinding requires a new explicit operation against a current v2 occurrence.

Automatic surgery resume across wrapper restarts is deliberately not claimed. Without a client-proven stable session identifier, every launch receives fresh authority. Completed session directories remain as local audit evidence but cannot affect a new launch.

When a uniquely attributable history edits an earlier turn, Context Surgeon creates a new branch and leaves sibling-branch surgeries behind. If two branches are equally plausible, it rejects locally and requires explicit selection. It never guesses by recency or conversation size.

## Request and usage truth

These labels are deliberately separate:

- **exact body bytes**: the UTF-8 length and SHA-256 of the compiled request handed to the HTTP boundary;
- **provider-reported usage**: structured usage observed in the response for that exact attempt;
- **estimated**, **previous attempt**, or **unknown**: anything that is not current provider-reported usage.

Calling `request.write()` does not prove provider receipt, billing, or token usage. The launch guarantee becomes active only when the exact supported-route handler reports a real dispatch-attempt ID. `context-surgeon status` separates durable intent from the latest compiler outcomes, exact byte/hash evidence, lifecycle state, and provider usage. No inline ordinal labels or token estimates are injected into the model transcript.

## Diagnostics and lifecycle

`CONTEXT_SURGEON_DEBUG=1` enables safe diagnostics: route classifications, authentication class/presence, lengths, hashes, lifecycle state, and error classes. It never logs prompt/response fragments, replacement text, authorization/cookie/API-key values, or secret digests. The old content-logging debug branches are disabled at bootstrap; there is no unsafe content flag in B3.

On POSIX systems the wrapped client and tunnel each own a process group. Shutdown is idempotent: Context Surgeon stops accepting traffic, allows a bounded active-request drain, force-closes remaining sockets with a report, terminates the child group, and escalates stubborn descendants to `SIGKILL`. Cloudflared startup timeout, early exit, and spawn failure tear down the proxy and never fall back to a local or paid unmodified route.

## Development

```bash
npm ci
npm run build
npm test
npm run test:package
```

`test:package` performs `npm pack --dry-run`, creates a tarball, installs it into a clean temporary prefix, and runs the packed CLI help and guide. Automated tests use local fixtures only and make no provider requests.

## License

MIT
