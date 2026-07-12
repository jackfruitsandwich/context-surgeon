import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import type { ExactBody, AttemptReceipt, DispatchArtifact } from "../src/contracts/truth.js";
import { DirectiveStore } from "../src/store/directive-store.js";
import { ConversationTracker } from "../src/proxy/conversations.js";
import {
  compileSupportedRequest,
  type HandlerConfig,
} from "../src/proxy/handler.js";
import { handleSupportedRoute } from "../src/proxy/supported-route.js";
import { dispatchArtifact } from "../src/proxy/stream.js";
import { startProxy } from "../src/proxy/server.js";
import { startFakeUpstream } from "./fakes/upstream.js";

type HttpResult = Readonly<{ status: number; body: Buffer }>;

function request(input: {
  baseUrl: string;
  path: string;
  body: Buffer;
  headers?: Record<string, string>;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(input.baseUrl);
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: input.path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(input.body.length),
          ...input.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    req.end(input.body);
  });
}

function configFor(
  upstreamBase: string,
  onAttemptReceipt?: (receipt: AttemptReceipt) => void
): HandlerConfig {
  return {
    directiveStore: new DirectiveStore(null),
    tracker: new ConversationTracker(),
    skillMarkdown: "",
    maxTokens: 128000,
    upstreamOpenAI: `${upstreamBase}/v1`,
    upstreamAnthropic: upstreamBase,
    upstreamChatGPT: `${upstreamBase}/backend-api`,
    onAttemptReceipt,
  };
}

async function startHandlerServer(config: HandlerConfig) {
  const server = http.createServer((req, res) => {
    void handleSupportedRoute(req, res, config, false);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

describe("supported-route exact dispatch", () => {
  it("constructs exact method, URL, body, and headers for all four routing modes", async () => {
    const upstream = await startFakeUpstream();
    const proxy = await startProxy({
      skillMarkdown: "",
      maxTokens: 128000,
      upstreamOpenAI: `${upstream.baseUrl}/v1`,
      upstreamAnthropic: upstream.baseUrl,
      upstreamChatGPT: `${upstream.baseUrl}/backend-api`,
      directivesPath: null,
    });
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const cases = [
      {
        path: "/v1/responses?case=responses",
        upstreamPath: "/v1/responses?case=responses",
        value: {
          model: "gpt-5.6",
          instructions: "be concise",
          input: [{ type: "message", role: "user", content: "hello" }],
        },
      },
      {
        path: "/v1/chat/completions?case=chat",
        upstreamPath: "/v1/chat/completions?case=chat",
        value: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      {
        path: "/anthropic/v1/messages?case=anthropic",
        upstreamPath: "/v1/messages?case=anthropic",
        value: {
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          system: "be concise",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      {
        path: "/backend-api/codex/responses?case=subscription",
        upstreamPath: "/backend-api/codex/responses?case=subscription",
        value: {
          model: "gpt-5.6-codex",
          instructions: "be concise",
          input: [{ type: "message", role: "user", content: "hello" }],
        },
      },
    ];

    try {
      for (const testCase of cases) {
        const body = Buffer.from(JSON.stringify(testCase.value), "utf8");
        const result = await request({
          baseUrl: proxyUrl,
          path: testCase.path,
          body,
          headers: {
            authorization: "Bearer exact-secret",
            "x-client-trace-id": "safe-trace",
            "x-unsafe-forward-me": "must-be-dropped",
          },
        });
        expect(result.status).toBe(200);
        const captured = upstream.requests.at(-1)!;
        expect(captured.method).toBe("POST");
        expect(captured.url).toBe(testCase.upstreamPath);
        expect(captured.body.equals(body)).toBe(true);
        expect(captured.headers["content-length"]).toBe(String(body.length));
        expect(captured.headers["content-type"]).toBe("application/json");
        expect(captured.headers.authorization).toBe("Bearer exact-secret");
        expect(captured.headers["x-client-trace-id"]).toBe("safe-trace");
        expect(captured.headers["x-unsafe-forward-me"]).toBeUndefined();
        expect(captured.headers.connection).toBe("close");
      }
      expect(upstream.requests).toHaveLength(cases.length);
    } finally {
      proxy.close();
      await once(proxy.server, "close");
      await upstream.close();
    }
  });

  it("fails closed for decode, parse, shape, codec, and validation failures", async () => {
    const upstream = await startFakeUpstream();
    const proxy = await startProxy({
      skillMarkdown: "",
      maxTokens: 128000,
      upstreamOpenAI: `${upstream.baseUrl}/v1`,
      upstreamAnthropic: upstream.baseUrl,
      upstreamChatGPT: `${upstream.baseUrl}/backend-api`,
      directivesPath: null,
    });
    const baseUrl = `http://127.0.0.1:${proxy.port}`;
    const invalid = [
      {
        path: "/v1/responses",
        body: Buffer.from("{not-json", "utf8"),
      },
      {
        path: "/v1/chat/completions",
        body: Buffer.from(JSON.stringify({ model: "gpt", messages: {} }), "utf8"),
      },
      {
        path: "/v1/responses",
        body: Buffer.from(JSON.stringify({ model: "gpt", input: [null] }), "utf8"),
      },
      {
        path: "/anthropic/v1/messages",
        body: Buffer.from(
          JSON.stringify({
            model: "claude",
            messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "late" }, { type: "text", text: "" }] }],
          }),
          "utf8"
        ),
      },
    ];
    try {
      for (const testCase of invalid) {
        const result = await request({
          baseUrl,
          path: testCase.path,
          body: testCase.body,
        });
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.status).toBeLessThan(500);
      }
      const encoded = await request({
        baseUrl,
        path: "/v1/responses",
        body: Buffer.from("not-brotli", "utf8"),
        headers: { "content-encoding": "br" },
      });
      expect(encoded.status).toBe(415);
      const multiple = await request({
        baseUrl,
        path: "/v1/responses",
        body: Buffer.from("not-compressed", "utf8"),
        headers: { "content-encoding": "gzip, deflate" },
      });
      expect(multiple.status).toBe(415);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      proxy.close();
      await once(proxy.server, "close");
      await upstream.close();
    }
  });

  it("correlates lifecycle and usage to each attempt closure and never receipts secrets", async () => {
    let responseNumber = 0;
    const upstream = await startFakeUpstream((_captured, res) => {
      responseNumber += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `resp_${responseNumber}`,
          usage: {
            input_tokens: 100 + responseNumber,
            input_tokens_details: {
              cached_tokens: responseNumber,
              cache_write_tokens: responseNumber + 10,
            },
            output_tokens: 3,
            total_tokens: 103 + responseNumber,
          },
        })
      );
    });
    const receipts: AttemptReceipt[] = [];
    const server = await startHandlerServer(
      configFor(upstream.baseUrl, (receipt) => receipts.push(receipt))
    );
    const value = {
      model: "gpt-5.6",
      instructions: "",
      input: [{ type: "message", role: "user", content: "same body" }],
    };
    const body = Buffer.from(JSON.stringify(value), "utf8");
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await request({
          baseUrl: server.baseUrl,
          path: "/v1/responses?attempt=same",
          body,
          headers: { authorization: "Bearer lifecycle-secret" },
        });
        expect(response.status).toBe(200);
      }
      const completed = receipts.filter(
        (receipt) => receipt.state === "response-completed"
      );
      expect(completed).toHaveLength(2);
      expect(completed[0].attemptId).not.toBe(completed[1].attemptId);
      expect(completed[0].bodySha256).toBe(completed[1].bodySha256);
      expect(completed[0].usage?.input_tokens).toBe(101);
      expect(completed[1].usage?.input_tokens).toBe(102);
      expect(completed[0].usage?.cache_write_input_tokens).toBe(11);
      expect(completed[1].providerUsageRaw).toMatchObject({
        mergeVersion: "provider-usage-v1",
        state: "complete",
        merged: {
          input_tokens_details: { cached_tokens: 2, cache_write_tokens: 12 },
        },
      });
      expect(completed.every((receipt) => receipt.connected)).toBe(true);

      for (const receipt of completed) {
        const states = receipts
          .filter((entry) => entry.attemptId === receipt.attemptId)
          .map((entry) => entry.state);
        expect(states).toEqual([
          "compiled",
          "handed-to-http",
          "request-stream-finished-locally",
          "response-started",
          "response-completed",
        ]);
        expect(receipt.fullUrl).toBe(
          `${upstream.baseUrl}/v1/responses?attempt=same`
        );
        expect(receipt.bodySha256).toBe(
          createHash("sha256").update(body).digest("hex")
        );
        expect(receipt.cacheObservation).toMatchObject({
          attemptId: receipt.attemptId,
          bodyTruth: {
            receivedSha256: receipt.bodySha256,
            decodedSha256: receipt.bodySha256,
            compiledSha256: receipt.bodySha256,
            dispatchedSha256: receipt.bodySha256,
          },
          observed: "provider-reported-read-and-write",
          sentMap: {
            exactBodySha256: receipt.bodySha256,
            canonicalization: "json-insertion-v1",
          },
        });
        expect(receipt.cacheObservation?.explanationCodes).toContain(
          "provider-cache-residency-not-claimed"
        );
        const serializedReceipt = JSON.stringify(receipt);
        expect(serializedReceipt).not.toContain("lifecycle-secret");
        expect(serializedReceipt).not.toContain(
          createHash("sha256").update("lifecycle-secret").digest("hex")
        );
      }
    } finally {
      await server.close();
      await upstream.close();
    }
  });

  it("records upstream close as response-aborted and retains parsed partial-stream usage", async () => {
    const upstream = await startFakeUpstream((_captured, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":77,"output_tokens":2,"total_tokens":79}}}\n\n'
      );
      setImmediate(() => res.destroy());
    });
    const receipts: AttemptReceipt[] = [];
    const server = await startHandlerServer(
      configFor(upstream.baseUrl, (receipt) => receipts.push(receipt))
    );
    const body = Buffer.from(
      JSON.stringify({
        model: "gpt-5.6",
        instructions: "",
        input: [{ type: "message", role: "user", content: "hello" }],
      }),
      "utf8"
    );
    try {
      await request({
        baseUrl: server.baseUrl,
        path: "/v1/responses",
        body,
      });
      const final = receipts.at(-1)!;
      expect(final.state).toBe("response-aborted");
      expect(final.abortSource).toBe("upstream");
      expect(final.usagePartialStream).toBe(true);
      expect(final.usage?.input_tokens).toBe(77);
      expect(final.providerUsageRaw?.state).toBe("partial");
      expect(final.cacheObservation?.bodyTruth.compiledSha256).toBe(final.bodySha256);
    } finally {
      await server.close();
      await upstream.close();
    }
  });

  it("labels a connected transport failure as delivery unknown without inferring receipt", async () => {
    const rawUpstream = net.createServer((socket) => {
      socket.once("data", () => socket.destroy());
    });
    rawUpstream.listen(0, "127.0.0.1");
    await once(rawUpstream, "listening");
    const address = rawUpstream.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const receipts: AttemptReceipt[] = [];
    const server = await startHandlerServer(
      configFor(
        `http://127.0.0.1:${address.port}`,
        (receipt) => receipts.push(receipt)
      )
    );
    const body = Buffer.from(
      JSON.stringify({
        model: "gpt-5.6",
        instructions: "",
        input: [{ type: "message", role: "user", content: "hello" }],
      }),
      "utf8"
    );
    try {
      const response = await request({
        baseUrl: server.baseUrl,
        path: "/v1/responses",
        body,
      });
      expect(response.status).toBe(502);
      const final = receipts.at(-1)!;
      expect(final.state).toBe("failed-after-connection-delivery-unknown");
      expect(final.connected).toBe(true);
      expect(final.responseStatus).toBeUndefined();
    } finally {
      await server.close();
      rawUpstream.close();
      await once(rawUpstream, "close");
    }
  });

  it("rejects a corrupt exact-body test double before any HTTP handoff", async () => {
    const upstream = await startFakeUpstream();
    const config = configFor(upstream.baseUrl);
    const body = Buffer.from(
      JSON.stringify({
        model: "gpt-5.6",
        instructions: "",
        input: [{ type: "message", role: "user", content: "hello" }],
      }),
      "utf8"
    );
    const compiled = await compileSupportedRequest(
      "/v1/responses",
      body,
      { "content-type": "application/json" },
      config
    );
    const corruptBody = {
      length: compiled.artifact.exactBody.length,
      sha256: compiled.artifact.exactBody.sha256,
      inspectCopy: () => compiled.artifact.exactBody.inspectCopy(),
      copyForHandoff: () => Buffer.from("corrupt", "utf8"),
    } as unknown as ExactBody;
    const corruptArtifact = {
      ...compiled.artifact,
      exactBody: corruptBody,
    } as DispatchArtifact;
    const receipts: AttemptReceipt[] = [];
    const server = http.createServer((_, res) => {
      void dispatchArtifact(corruptArtifact, res, {
        secretHeaders: compiled.secretHeaders,
        format: compiled.format,
        onAttemptReceipt: (receipt) => receipts.push(receipt),
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      const response = await request({
        baseUrl: `http://127.0.0.1:${address.port}`,
        path: "/dispatch",
        body: Buffer.alloc(0),
      });
      expect(response.status).toBe(500);
      expect(receipts.map((receipt) => receipt.state)).toEqual([
        "compiled",
        "rejected-before-handoff",
      ]);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      server.close();
      await once(server, "close");
      await upstream.close();
    }
  });
});
