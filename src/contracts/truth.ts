import { createHash, randomUUID } from "node:crypto";

export type ProviderKind =
  | "openai-responses"
  | "anthropic-messages"
  | "openai-chat-completions";

export type SupportedRoute = Readonly<{
  provider: ProviderKind;
  incomingPath: string;
  upstreamUrl: string;
}>;

export type ReceivedRequest = Readonly<{
  requestId: string;
  route: SupportedRoute;
  encoding: "identity" | "gzip" | "deflate" | "zstd";
  receivedLength: number;
  receivedSha256: string;
  decodedLength: number;
  decodedSha256: string;
  providerValue: Readonly<Record<string, unknown>>;
}>;

export type OperationOutcome =
  | "committed"
  | "applied"
  | "protected-residue"
  | "unsupported"
  | "stale"
  | "rejected";

export type OperationResult = Readonly<{
  surgeryId: string;
  occurrenceId: string;
  expectedSourceHash: string;
  outcome: OperationOutcome;
  outputHash?: string;
  reason?: string;
}>;

export type ProviderValidationReceipt = Readonly<{
  valid: boolean;
  itemCountBefore: number;
  itemCountAfter: number;
  orderHashBefore: string;
  orderHashAfter: string;
  protectedHashesMatch: boolean;
  errors: readonly string[];
}>;

export type CompiledRequest = Readonly<{
  requestId: string;
  sessionId: string;
  branchId: string;
  stateRevision: number;
  receivedSha256: string;
  provider: ProviderKind;
  fullUrl: string;
  normalizedValue: Readonly<Record<string, unknown>>;
  operationResults: readonly OperationResult[];
  validation: ProviderValidationReceipt;
  bodyLength: number;
  bodySha256: string;
}>;

export type SafeHeaderEntry = Readonly<{
  name: string;
  value: string;
}>;

export type SecretHeaderSlot = Readonly<{
  name: "authorization" | "cookie" | "proxy-authorization" | string;
  class: string;
  present: boolean;
}>;

/**
 * This is constructive, not a redacted view of an ambient header bag. Dispatch
 * must build its outgoing headers from these entries plus the named secret
 * slots, and from no other source.
 */
export type ConstructiveHeaderEnvelope = Readonly<{
  safeEntries: readonly SafeHeaderEntry[];
  secretSlots: readonly SecretHeaderSlot[];
}>;

export type AttemptState =
  | "compiled"
  | "rejected-before-handoff"
  | "handed-to-http"
  | "request-stream-finished-locally"
  | "response-started"
  | "response-completed"
  | "response-aborted"
  | "failed-no-connection"
  | "failed-after-connection-delivery-unknown";

export type UsageProvenance =
  | Readonly<{
      kind: "provider-reported";
      attemptId: string;
      observedAt: string;
      requestsAgo: number;
    }>
  | Readonly<{
      kind: "estimated";
      method: string;
    }>
  | Readonly<{
      kind: "previous-attempt";
      attemptId: string;
      requestsAgo: number;
    }>
  | Readonly<{ kind: "unknown"; reason: string }>;

export type AttemptReceipt = Readonly<{
  attemptId: string;
  requestId: string;
  sessionId: string;
  branchId: string;
  stateRevision: number;
  operationResults: readonly OperationResult[];
  state: AttemptState;
  method: "POST";
  fullUrl: string;
  exactScopeSha256: string;
  bodySha256: string;
  bodyLength: number;
  semanticEnvelope: ConstructiveHeaderEnvelope;
  connected: boolean;
  responseStatus?: number;
  abortSource?: "client" | "upstream" | "unknown";
  usage?: Readonly<Record<string, number | null>>;
  usagePartialStream?: boolean;
  error?: string;
}>;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lengthDelimited(parts: readonly (string | Buffer)[]): Buffer {
  const encoded: Buffer[] = [];
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    encoded.push(length, bytes);
  }
  return Buffer.concat(encoded);
}

/**
 * Encapsulates the authoritative request bytes. Node Buffers cannot be frozen,
 * so callers receive defensive copies. The dispatch copy is re-hashed at the
 * last possible local boundary and rejected if the private bytes changed.
 */
export class ExactBody {
  readonly length: number;
  readonly sha256: string;
  #bytes: Buffer;

  private constructor(bytes: Buffer) {
    this.#bytes = Buffer.from(bytes);
    this.length = this.#bytes.length;
    this.sha256 = sha256(this.#bytes);
    Object.freeze(this);
  }

  static fromUtf8(value: string): ExactBody {
    return new ExactBody(Buffer.from(value, "utf8"));
  }

  static fromBuffer(value: Buffer): ExactBody {
    return new ExactBody(value);
  }

  inspectCopy(): Buffer {
    return Buffer.from(this.#bytes);
  }

  copyForHandoff(): Buffer {
    const bytes = Buffer.from(this.#bytes);
    const actual = sha256(bytes);
    if (actual !== this.sha256 || bytes.length !== this.length) {
      throw new Error(
        `Exact body integrity check failed: expected ${this.sha256}/${this.length}, got ${actual}/${bytes.length}`
      );
    }
    return bytes;
  }
}

export function exactScopeSha256(
  method: string,
  fullUrl: string,
  body: ExactBody
): string {
  return sha256(lengthDelimited([method, fullUrl, body.inspectCopy()]));
}

export type DispatchArtifact = Readonly<{
  attemptId: string;
  compiled: CompiledRequest;
  method: "POST";
  fullUrl: string;
  semanticEnvelope: ConstructiveHeaderEnvelope;
  exactBody: ExactBody;
  bodySha256: string;
  exactScopeSha256: string;
}>;

export function createDispatchArtifact(input: {
  compiled: CompiledRequest;
  semanticEnvelope: ConstructiveHeaderEnvelope;
  exactBody: ExactBody;
  attemptId?: string;
}): DispatchArtifact {
  if (input.compiled.bodySha256 !== input.exactBody.sha256) {
    throw new Error("Compiled request hash does not match exact body");
  }
  if (input.compiled.bodyLength !== input.exactBody.length) {
    throw new Error("Compiled request length does not match exact body");
  }
  return Object.freeze({
    attemptId: input.attemptId ?? randomUUID(),
    compiled: input.compiled,
    method: "POST" as const,
    fullUrl: input.compiled.fullUrl,
    semanticEnvelope: input.semanticEnvelope,
    exactBody: input.exactBody,
    bodySha256: input.exactBody.sha256,
    exactScopeSha256: exactScopeSha256(
      "POST",
      input.compiled.fullUrl,
      input.exactBody
    ),
  });
}
