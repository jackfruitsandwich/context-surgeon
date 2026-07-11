import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import zlib from "node:zlib";
import type { ReceivedRequest, SupportedRoute } from "../contracts/truth.js";
import { deepFreeze, isRecord } from "../providers/shared.js";
import { TruthCoreError } from "./errors.js";

export const MAX_RECEIVED_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_DECODED_BODY_BYTES = 32 * 1024 * 1024;

type SupportedEncoding = ReceivedRequest["encoding"];
type ZlibWithZstd = typeof zlib & {
  zstdDecompressSync?: (
    input: Buffer,
    options?: { maxOutputLength?: number }
  ) => Buffer;
};

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseContentEncoding(value: string | undefined): SupportedEncoding {
  if (!value || value.trim().toLowerCase() === "identity") return "identity";
  const normalized = value.trim().toLowerCase();
  if (normalized.includes(",")) {
    throw new TruthCoreError(
      "Multiple content encodings are not supported on surgery routes",
      415,
      "unsupported-content-encoding"
    );
  }
  if (
    normalized !== "gzip" &&
    normalized !== "deflate" &&
    normalized !== "zstd"
  ) {
    throw new TruthCoreError(
      `Unsupported content encoding: ${normalized}`,
      415,
      "unsupported-content-encoding"
    );
  }
  return normalized;
}

export function decodeBody(
  receivedBytes: Buffer,
  encoding: SupportedEncoding
): Buffer {
  if (receivedBytes.length > MAX_RECEIVED_BODY_BYTES) {
    throw new TruthCoreError(
      "Supported request body exceeds the received-size limit",
      413,
      "request-too-large"
    );
  }
  try {
    let decoded: Buffer;
    if (encoding === "identity") {
      decoded = Buffer.from(receivedBytes);
    } else if (encoding === "gzip") {
      decoded = zlib.gunzipSync(receivedBytes, {
        maxOutputLength: MAX_DECODED_BODY_BYTES,
      });
    } else if (encoding === "deflate") {
      decoded = zlib.inflateSync(receivedBytes, {
        maxOutputLength: MAX_DECODED_BODY_BYTES,
      });
    } else {
      const zstd = (zlib as ZlibWithZstd).zstdDecompressSync;
      if (typeof zstd !== "function") {
        throw new TruthCoreError(
          "zstd decoding is unavailable in this Node runtime",
          415,
          "zstd-unavailable"
        );
      }
      decoded = zstd(receivedBytes, {
        maxOutputLength: MAX_DECODED_BODY_BYTES,
      });
    }
    if (decoded.length > MAX_DECODED_BODY_BYTES) {
      throw new TruthCoreError(
        "Supported request body exceeds the decoded-size limit",
        413,
        "request-too-large"
      );
    }
    return decoded;
  } catch (error) {
    if (error instanceof TruthCoreError) throw error;
    throw new TruthCoreError(
      `Could not decode supported request body: ${
        error instanceof Error ? error.message : "invalid compressed data"
      }`,
      422,
      "decode-failed"
    );
  }
}

export function parseJsonObject(decodedBytes: Buffer): Readonly<Record<string, unknown>> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes);
  } catch {
    throw new TruthCoreError(
      "Supported request body is not valid UTF-8",
      422,
      "invalid-utf8"
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TruthCoreError(
      "Supported request body is not valid JSON",
      400,
      "invalid-json"
    );
  }
  if (!isRecord(value)) {
    throw new TruthCoreError(
      "Supported request body must be a JSON object",
      422,
      "invalid-envelope"
    );
  }
  return deepFreeze(value);
}

export function receiveRequest(input: {
  requestId: string;
  route: SupportedRoute;
  contentEncoding?: string;
  receivedBytes: Buffer;
  providerValue?: Readonly<Record<string, unknown>>;
  decodedBytes?: Buffer;
}): ReceivedRequest {
  const encoding = parseContentEncoding(input.contentEncoding);
  const decodedBytes = input.decodedBytes ?? decodeBody(input.receivedBytes, encoding);
  const providerValue = input.providerValue ?? parseJsonObject(decodedBytes);
  return Object.freeze({
    requestId: input.requestId,
    route: input.route,
    encoding,
    receivedLength: input.receivedBytes.length,
    receivedSha256: sha256(input.receivedBytes),
    decodedLength: decodedBytes.length,
    decodedSha256: sha256(decodedBytes),
    providerValue,
  });
}
