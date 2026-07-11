import http from "node:http";
import { once } from "node:events";

export type CapturedRequest = Readonly<{
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}>;

export type FakeUpstream = Readonly<{
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}>;

export async function startFakeUpstream(
  respond?: (
    request: CapturedRequest,
    response: http.ServerResponse
  ) => void
): Promise<FakeUpstream> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      if (respond) {
        respond(captured, res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake upstream failed to bind");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

