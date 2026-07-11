import http from "node:http";
import { describe, expect, it } from "vitest";
import { startFakeUpstream } from "./fakes/upstream.js";

function post(url: string, body: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: "/capture?mode=exact",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("fake upstream proof harness", () => {
  it("captures the exact method, URL, headers, and body bytes", async () => {
    const upstream = await startFakeUpstream();
    try {
      const body = Buffer.from('{"snowman":"☃"}', "utf8");
      await post(upstream.baseUrl, body);

      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0].method).toBe("POST");
      expect(upstream.requests[0].url).toBe("/capture?mode=exact");
      expect(upstream.requests[0].headers["content-length"]).toBe(
        String(body.length)
      );
      expect(upstream.requests[0].body.equals(body)).toBe(true);
    } finally {
      await upstream.close();
    }
  });
});

