import { describe, expect, it } from "vitest";
import {
  constructHeaderEnvelope,
  materializeHeaders,
} from "../src/compiler/headers.js";

describe("constructive header privacy", () => {
  it("forwards the ChatGPT account id without persisting it as a safe value", () => {
    const material = constructHeaderEnvelope({
      incoming: {
        authorization: "Bearer secret",
        "chatgpt-account-id": "account-private-value",
      },
      fullUrl: "https://chatgpt.com/backend-api/codex/responses",
      bodyLength: 10,
    });
    expect(material.envelope.safeEntries).not.toContainEqual(
      expect.objectContaining({ name: "chatgpt-account-id" })
    );
    expect(material.envelope.secretSlots).toContainEqual({
      name: "chatgpt-account-id",
      class: "account-id",
      present: true,
    });
    expect(materializeHeaders(material.envelope, material.secretValues)).toMatchObject({
      authorization: "Bearer secret",
      "chatgpt-account-id": "account-private-value",
    });
  });
});
