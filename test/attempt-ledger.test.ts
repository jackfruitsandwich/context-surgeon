import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptReceipt } from "../src/contracts/truth.js";
import { AttemptLedger } from "../src/runtime/attempt-ledger.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
  const value = mkdtempSync(join(tmpdir(), "context-surgeon-ledger-"));
  temporary.push(value);
  return value;
}

function receipt(state: AttemptReceipt["state"]): AttemptReceipt {
  return Object.freeze({
    attemptId: "attempt-1",
    requestId: "request-1",
    sessionId: "session-1",
    branchId: "branch-1",
    stateRevision: 3,
    operationResults: Object.freeze([
      Object.freeze({
        surgeryId: "surgery-1",
        occurrenceId: "occurrence-1",
        expectedSourceHash: "a".repeat(64),
        outcome: "applied" as const,
        outputHash: "b".repeat(64),
      }),
    ]),
    state,
    method: "POST",
    fullUrl: "https://api.anthropic.com/v1/messages",
    exactScopeSha256: "c".repeat(64),
    bodySha256: "d".repeat(64),
    bodyLength: 123,
    semanticEnvelope: Object.freeze({
      safeEntries: Object.freeze([
        Object.freeze({ name: "content-type", value: "application/json" }),
      ]),
      secretSlots: Object.freeze([
        Object.freeze({ name: "authorization", class: "bearer-credential", present: true }),
      ]),
    }),
    connected: true,
    responseStatus: 200,
    usage: Object.freeze({ input_tokens: 41, output_tokens: 2 }),
  });
}

describe("attempt ledger", () => {
  it("persists exact non-secret attempt and applied-operation evidence at mode 0600", () => {
    const directory = temp();
    const ledger = new AttemptLedger(directory);
    const observation = ledger.record(
      receipt("response-completed"),
      "2026-07-11T13:00:00.000Z"
    );

    expect(observation.receipt.operationResults[0].outcome).toBe("applied");
    expect(ledger.latest()).toEqual(observation);
    expect(statSync(ledger.path).mode & 0o777).toBe(0o600);
    const serialized = readFileSync(ledger.path, "utf8");
    expect(serialized).toContain('"bodyLength":123');
    expect(serialized).toContain('"input_tokens":41');
    expect(serialized).not.toMatch(/Bearer\s|sk-ant-|prompt text|response text/i);
  });

  it("recovers the latest complete observation without treating a torn tail as state corruption", () => {
    const directory = temp();
    const first = new AttemptLedger(directory);
    first.record(receipt("handed-to-http"), "2026-07-11T13:00:00.000Z");
    first.record(receipt("response-completed"), "2026-07-11T13:00:01.000Z");
    appendFileSync(first.path, '{"observedAt":"torn"');

    const reopened = new AttemptLedger(directory);
    expect(reopened.latest()?.receipt.state).toBe("response-completed");
    expect(reopened.latest()?.observedAt).toBe("2026-07-11T13:00:01.000Z");
  });

  it("never persists URL query values while retaining the exact-scope hash", () => {
    const directory = temp();
    const ledger = new AttemptLedger(directory);
    const value = {
      ...receipt("response-completed"),
      fullUrl: "https://api.anthropic.com/v1/messages?api_key=do-not-persist",
    };
    ledger.record(value);

    const serialized = readFileSync(ledger.path, "utf8");
    expect(serialized).not.toContain("do-not-persist");
    expect(serialized).toContain("?<redacted>");
    expect(ledger.latest()?.receipt.fullUrl).toBe(value.fullUrl);
    const reopened = new AttemptLedger(directory);
    expect(reopened.latest()?.receipt).toMatchObject({
      fullUrl: "https://api.anthropic.com/v1/messages?<redacted>",
      urlValuesRedacted: true,
      exactScopeSha256: value.exactScopeSha256,
    });
  });
});
