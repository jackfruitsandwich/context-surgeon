import { controlUrl } from "./session-discovery.js";

const CONTROL_RETRY_DELAYS_MS = [0, 150, 500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenErrorText(error: unknown): string {
  if (error instanceof Error) {
    const causeText =
      "cause" in error && error.cause !== undefined
        ? ` ${flattenErrorText(error.cause)}`
        : "";
    return `${error.name} ${error.message}${causeText}`;
  }
  return String(error);
}

export function isRetryableControlError(error: unknown): boolean {
  const text = flattenErrorText(error);
  return /fetch failed|econnreset|econnrefused|epipe|etimedout|socket hang up|networkerror/i.test(
    text
  );
}

function controlUnavailableError(lastError: unknown): Error {
  const detail = lastError ? ` Last error: ${flattenErrorText(lastError)}.` : "";
  return new Error(
    "Context-surgeon is temporarily unavailable." +
      " If your Mac just woke from sleep, wait a moment and retry." +
      " If it keeps failing, restart the wrapped session." +
      detail
  );
}

class ControlHttpError extends Error {}

export async function requestJson(
  path: string,
  init?: RequestInit
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt < CONTROL_RETRY_DELAYS_MS.length; attempt++) {
    if (CONTROL_RETRY_DELAYS_MS[attempt] > 0) {
      await sleep(CONTROL_RETRY_DELAYS_MS[attempt]);
    }

    try {
      const res = await fetch(controlUrl(path), init);
      const payload = await res.json();
      if (!res.ok) {
        const error =
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof payload.error === "string"
            ? payload.error
            : `HTTP ${res.status}`;
        throw new ControlHttpError(error);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (
        attempt === CONTROL_RETRY_DELAYS_MS.length - 1 ||
        !isRetryableControlError(error)
      ) {
        break;
      }
    }
  }

  if (lastError instanceof ControlHttpError) {
    throw new Error(lastError.message);
  }
  throw controlUnavailableError(lastError);
}

