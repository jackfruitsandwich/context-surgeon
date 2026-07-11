# context-surgeon

Context Surgeon is a fail-closed model-request proxy for explicitly replacing or evicting addressable context payloads while preserving provider structure.

This branch is the v2 B3 runtime/product-safety component. It owns launcher classification, separate listener bootstrap, guarantee state, process/tunnel lifecycle, diagnostics, packaging, and product copy. The exact compiler/dispatch implementation comes from B1 and authenticated transactional state/control comes from B2 through the narrow hooks exported by B3. Until those hooks are integrated, the banner says control is not integrated and the guarantee remains unverified; B3 does not manufacture an active attempt or expose the legacy control API on the model port.

## Install and use

```bash
npm install -g context-surgeon

context-surgeon codex [codex arguments]
context-surgeon claude [claude arguments]
context-surgeon guide
```

Node.js 22 or newer is required.

Every active launch begins with:

```text
surgery guarantee: unverified — no proxied request observed yet
```

Silence stays unverified. An observed route or authentication class that does not match the selected launch mode is rejected locally. Context Surgeon never changes an active surgery launch into a paid unmodified request. To choose native behavior before launch, set `CONTEXT_SURGEON_DISABLE_SURGERY=1`; the proxy is not started and the banner says `BYPASS`.

## Launch support

| Client mode | B3 behavior |
|---|---|
| Codex, ChatGPT subscription login | Supported: detected with `codex login status`; native Codex authentication is used through a dedicated provider, without reading or copying credentials |
| Codex, API-key login, `OPENAI_API_KEY`, or `CODEX_API_KEY` with `codex exec` | Supported: dedicated Responses provider; an environment key is named, never copied into arguments or logs |
| Codex `--profile` | Rejected because the profile can change provider/auth routing |
| Codex custom `model_provider` or base URL | Rejected; B3 never overwrites a custom backend |
| Codex `--oss` | Rejected; the local backend is not redirected |
| Claude Code, native Anthropic configuration | Supported |
| Claude Code with an existing `ANTHROPIC_BASE_URL` | Rejected; B3 never overwrites a custom backend |
| Cursor | Experimental and unsupported for the v2 truth guarantee until B3b; requires explicit `--experimental` |

Codex configuration uses a dedicated `model_providers.context_surgeon_*` entry passed on the command line. B3 does not set unconditional `chatgpt_base_url` or `openai_base_url` overrides. Cursor's tunnel targets only the loopback model port. `/_control` on that port returns a local 404 and is never forwarded.

## What is persisted

The integrated v2 state branch owns one mode-0600 session directory. Its durable content classes are:

- session/conversation/branch identifiers and revisions;
- surgery, reversal, receipt, and operation-idempotency identifiers;
- occurrence identifiers, provider paths, operation outcomes, timestamps, and source/output SHA-256 hashes;
- surgery actions and user-authored replacement text, because replacement text is required to reapply that operation;
- observational attempt metadata: method, full upstream URL, exact-body hash and byte length, exact-scope hash, non-secret semantic header classifications, lifecycle state, response status, and provider-reported usage when observed;
- a control record containing local ownership/address metadata and a per-session capability as defined by B2.

V2 does **not** persist original prompt/response bodies, content previews, authorization or cookie values, secret digests, or a fictional “shadow store.” A torn final attempt-ledger line is observational damage; it is not authoritative surgery state.

The unintegrated legacy base still has `~/.context-surgeon/directives.json`. That v1 file contains chained fingerprints, human IDs, previews, token estimates, timestamps, directive actions, and replacement text. B3 does not migrate, delete, or silently claim that file is session-isolated. In particular, applying replacement text across sessions is an instruction-injection risk even when source bytes match; v2 binds operations to an explicit session and branch instead.

## Request and usage truth

These labels are deliberately separate:

- **exact body bytes**: the UTF-8 length and SHA-256 of the compiled request handed to the HTTP boundary;
- **provider-reported usage**: structured usage observed in the response for that exact attempt;
- **estimated**, **previous attempt**, or **unknown**: anything that is not current provider-reported usage.

Calling `request.write()` does not prove provider receipt, billing, or token usage. The launch guarantee becomes active only when the integrated B1 handler reports a real dispatch-attempt ID. No inline ordinal labels or token-status estimates are part of the v2 default compiler behavior; the skeleton and status control surfaces carry addressing and provenance. The legacy handler on this isolated component branch still needs the B1 integration seam to remove its old inline injection.

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
