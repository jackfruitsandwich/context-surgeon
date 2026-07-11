import { describe, expect, it } from "vitest";
import {
  ExactBody,
  createDispatchArtifact,
  exactScopeSha256,
  type CompiledRequest,
} from "../src/contracts/truth.js";

function compiled(body: ExactBody): CompiledRequest {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    branchId: "branch-1",
    stateRevision: 0,
    receivedSha256: "received",
    provider: "openai-responses",
    fullUrl: "https://example.test/v1/responses",
    normalizedValue: { input: [] },
    operationResults: [],
    validation: {
      valid: true,
      itemCountBefore: 0,
      itemCountAfter: 0,
      orderHashBefore: "same",
      orderHashAfter: "same",
      protectedHashesMatch: true,
      errors: [],
    },
    bodyLength: body.length,
    bodySha256: body.sha256,
  };
}

describe("truth contracts", () => {
  it("keeps authoritative bytes private and returns defensive copies", () => {
    const body = ExactBody.fromUtf8('{"input":[]}');
    const inspected = body.inspectCopy();
    inspected.fill(0);

    expect(body.copyForHandoff().toString("utf8")).toBe('{"input":[]}');
  });

  it("binds exact scope to method, full URL, and body", () => {
    const body = ExactBody.fromUtf8('{"input":[]}');
    expect(
      exactScopeSha256("POST", "https://example.test/v1/responses", body)
    ).not.toBe(
      exactScopeSha256("POST", "https://example.test/v1/messages", body)
    );
  });

  it("refuses a compiled hash that does not match the exact body", () => {
    const body = ExactBody.fromUtf8('{"input":[]}');
    expect(() =>
      createDispatchArtifact({
        compiled: { ...compiled(body), bodySha256: "wrong" },
        semanticEnvelope: { safeEntries: [], secretSlots: [] },
        exactBody: body,
      })
    ).toThrow(/hash does not match/);
  });

  it("creates a per-attempt artifact over the exact scope", () => {
    const body = ExactBody.fromUtf8('{"input":[]}');
    const artifact = createDispatchArtifact({
      compiled: compiled(body),
      semanticEnvelope: {
        safeEntries: [{ name: "content-type", value: "application/json" }],
        secretSlots: [{ name: "authorization", class: "bearer", present: true }],
      },
      exactBody: body,
      attemptId: "attempt-1",
    });

    expect(artifact.attemptId).toBe("attempt-1");
    expect(artifact.bodySha256).toBe(body.sha256);
    expect(artifact.exactScopeSha256).toBe(
      exactScopeSha256("POST", compiled(body).fullUrl, body)
    );
  });
});

