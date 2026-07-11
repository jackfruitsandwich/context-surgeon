import type http from "node:http";
import { classifyAuth, safePathname, type AuthClassification } from "./diagnostics.js";

export type TrafficMode =
  | "codex-subscription"
  | "codex-api-key"
  | "claude"
  | "cursor-experimental"
  | "unrestricted-test";

export type ModelTrafficPolicy = Readonly<{
  mode: TrafficMode;
  expectedPaths: readonly string[];
  authClasses: readonly AuthClassification[];
}>;

export type TrafficDecision =
  | Readonly<{ kind: "accepted"; path: string; authClass: AuthClassification }>
  | Readonly<{ kind: "not-model-traffic"; path: string }>
  | Readonly<{ kind: "rejected-route"; path: string; reason: string }>
  | Readonly<{
      kind: "rejected-auth";
      path: string;
      authClass: AuthClassification;
      reason: string;
    }>;

function frozenPolicy(
  mode: TrafficMode,
  expectedPaths: readonly string[],
  authClasses: readonly AuthClassification[]
): ModelTrafficPolicy {
  return Object.freeze({
    mode,
    expectedPaths: Object.freeze([...expectedPaths]),
    authClasses: Object.freeze([...authClasses]),
  });
}

export function isSurgeryCapablePath(path: string): boolean {
  return [
    "/v1/responses",
    "/backend-api/codex/responses",
    "/anthropic/v1/messages",
    "/v1/messages",
    "/v1/chat/completions",
    "/chat/completions",
  ].some((candidate) => path === candidate || path.startsWith(`${candidate}/`));
}

export function policyForMode(mode: TrafficMode): ModelTrafficPolicy {
  switch (mode) {
    case "codex-subscription":
      return frozenPolicy(mode, ["/backend-api/codex/responses"], ["bearer", "cookie"]);
    case "codex-api-key":
      return frozenPolicy(mode, ["/v1/responses"], ["bearer"]);
    case "claude":
      return frozenPolicy(mode, ["/anthropic/v1/messages"], ["api-key", "bearer"]);
    case "cursor-experimental":
      return frozenPolicy(
        mode,
        ["/v1/chat/completions", "/chat/completions"],
        ["bearer", "api-key"]
      );
    case "unrestricted-test":
      return frozenPolicy(
        mode,
        [
          "/v1/responses",
          "/backend-api/codex/responses",
          "/anthropic/v1/messages",
          "/v1/messages",
          "/v1/chat/completions",
          "/chat/completions",
        ],
        ["bearer", "api-key", "cookie", "none", "other", "basic"]
      );
  }
}

export function evaluateTraffic(
  req: http.IncomingMessage,
  policy: ModelTrafficPolicy
): TrafficDecision {
  const path = safePathname(req.url || "");
  if ((req.method || "GET") !== "POST" || !isSurgeryCapablePath(path)) {
    return { kind: "not-model-traffic", path };
  }
  if (!policy.expectedPaths.includes(path)) {
    return {
      kind: "rejected-route",
      path,
      reason: `observed ${path}, expected ${policy.expectedPaths.join(" or ")} for ${policy.mode}`,
    };
  }
  const authClass = classifyAuth(req.headers);
  if (!policy.authClasses.includes(authClass)) {
    return {
      kind: "rejected-auth",
      path,
      authClass,
      reason: `observed auth class ${authClass}, expected ${policy.authClasses.join(" or ")} for ${policy.mode}`,
    };
  }
  return { kind: "accepted", path, authClass };
}
