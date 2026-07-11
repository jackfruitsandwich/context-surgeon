import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startProxy, type SupportedRouteHandler } from "../proxy/server.js";
import type { ControlPlaneBootstrap } from "../runtime/control-listener.js";
import {
  loadPackageVersion,
  loadPackagedText,
  printStartupBanner,
  registerRuntimeRecord,
} from "../runtime/bootstrap.js";
import {
  classifyCodexLaunch,
  probeCodexAuthMode,
  readUserCodexConfig,
  type CodexLaunchPlan,
} from "../runtime/launch-mode.js";
import { runWrappedChild } from "../runtime/process-lifecycle.js";
import { policyForMode, type ModelTrafficPolicy } from "../runtime/traffic-policy.js";
import { startCloudflaredTunnel } from "../runtime/tunnel.js";

type Target = "codex" | "claude" | "claude-ev";

export type RuntimeIntegrations = Readonly<{
  controlPlaneBootstrap?: ControlPlaneBootstrap;
  supportedRouteHandler?: SupportedRouteHandler;
}>;

function surgeryDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.CONTEXT_SURGEON_DISABLE_SURGERY === "1";
}

function loadSkillMarkdown(): string {
  try {
    return loadPackagedText("skill.md").trim();
  } catch {
    console.error("[context-surgeon] Warning: could not load skill.md");
    return "";
  }
}

function upstreamConfiguration(env: NodeJS.ProcessEnv): {
  upstreamOpenAI: string;
  upstreamChatGPT: string;
  upstreamAnthropic: string;
} {
  return {
    upstreamOpenAI:
      env.CONTEXT_SURGEON_UPSTREAM_OPENAI || "https://api.openai.com/v1",
    upstreamChatGPT:
      env.CONTEXT_SURGEON_UPSTREAM_CHATGPT || "https://chatgpt.com/backend-api",
    upstreamAnthropic:
      env.CONTEXT_SURGEON_UPSTREAM_ANTHROPIC || "https://api.anthropic.com",
  };
}

async function launchExplicitBypass(target: Target, args: readonly string[]): Promise<void> {
  const sessionId = randomUUID();
  printStartupBanner({
    target,
    mode: "explicit-bypass",
    upstreamClass: "native client configuration",
    authClass: "native client configuration",
    modelPort: null,
    controlAddress: null,
    sessionId,
    identitySource: "fresh launch",
    persistencePath: "none — explicit bypass",
    guarantee: { kind: "bypass-explicit" },
  });
  const code = await runWrappedChild({
    command: target,
    args,
    env: { ...process.env },
    runtime: { close: async () => undefined },
  });
  process.exitCode = code;
}

function rejectedPlanError(plan: Extract<CodexLaunchPlan, { supported: false }>): Error {
  return new Error(
    `${plan.reason}. Context Surgeon will not launch a paid, unmodified request. ` +
      "Use CONTEXT_SURGEON_DISABLE_SURGERY=1 to choose transparent bypass before launch."
  );
}

async function startConfiguredProxy(input: {
  target: string;
  sessionId: string;
  trafficPolicy: ModelTrafficPolicy;
  integrations: RuntimeIntegrations;
}) {
  if (!input.integrations.supportedRouteHandler) {
    throw new Error(
      "The B1 exact-dispatch handler is not integrated. Refusing to start the legacy " +
        "raw-fallback request path; surgery is not active."
    );
  }
  const maxTokens = parseInt(process.env.CONTEXT_SURGEON_MAX_TOKENS || "128000", 10);
  return await startProxy({
    skillMarkdown: loadSkillMarkdown(),
    maxTokens,
    ...upstreamConfiguration(process.env),
    target: input.target,
    version: loadPackageVersion(),
    sessionId: input.sessionId,
    trafficPolicy: input.trafficPolicy,
    controlPlaneBootstrap: input.integrations.controlPlaneBootstrap,
    supportedRouteHandler: input.integrations.supportedRouteHandler,
    // Never load the cross-session v1 directive file from the v2 launcher.
    directivesPath: null,
  });
}

function installRuntimeRecord(input: {
  target: string;
  mode: string;
  sessionId: string;
  proxy: Awaited<ReturnType<typeof startConfiguredProxy>>;
}): () => void {
  return registerRuntimeRecord({
    pid: process.pid,
    target: input.target,
    mode: input.mode,
    sessionId: input.sessionId,
    modelPort: input.proxy.modelPort,
    controlAddress: input.proxy.controlAddress,
    startedAt: new Date().toISOString(),
    guaranteeAtWrite: input.proxy.guarantee(),
  });
}

export async function launch(
  target: Target,
  extraArgs: string[],
  integrations: RuntimeIntegrations = {}
): Promise<void> {
  if (surgeryDisabled(process.env)) {
    await launchExplicitBypass(target, extraArgs);
    return;
  }

  const sessionId = randomUUID();
  let mode: string;
  let upstreamClass: string;
  let authClass: string;
  let trafficPolicy: ModelTrafficPolicy;
  let childArgs = [...extraArgs];

  if (target === "codex") {
    const provisional = classifyCodexLaunch({
      args: extraArgs,
      env: process.env,
      authMode: probeCodexAuthMode("codex"),
      userConfig: readUserCodexConfig(process.env),
      proxyBase: "http://127.0.0.1:0",
    });
    if (!provisional.supported) throw rejectedPlanError(provisional);
    mode = provisional.mode;
    upstreamClass = provisional.upstreamClass;
    authClass = provisional.authClass;
    trafficPolicy = provisional.trafficPolicy;
  } else {
    if (process.env.ANTHROPIC_BASE_URL) {
      throw new Error(
        "ANTHROPIC_BASE_URL already selects a custom backend; refusing to replace it. " +
          "Surgery is not active. Use CONTEXT_SURGEON_DISABLE_SURGERY=1 for explicit bypass."
      );
    }
    mode = "claude-native-auth";
    upstreamClass = "anthropic-api";
    authClass = "native Claude credential forwarding";
    trafficPolicy = policyForMode("claude");
  }

  const proxy = await startConfiguredProxy({ target, sessionId, trafficPolicy, integrations });
  const cleanupRecord = installRuntimeRecord({ target, mode, sessionId, proxy });
  const childEnv = { ...process.env, ...proxy.controlEnvironment };

  if (target === "codex") {
    const plan = classifyCodexLaunch({
      args: extraArgs,
      env: process.env,
      authMode: mode === "subscription" ? "chatgpt" : "api-key",
      userConfig: readUserCodexConfig(process.env),
      proxyBase: `http://127.0.0.1:${proxy.modelPort}`,
    });
    if (!plan.supported) {
      await proxy.close({ reason: "launch classification changed" });
      cleanupRecord();
      throw rejectedPlanError(plan);
    }
    childArgs = [...plan.providerArgs, ...extraArgs];
  } else {
    childEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.modelPort}/anthropic`;
  }

  printStartupBanner({
    target,
    mode,
    upstreamClass,
    authClass,
    modelPort: proxy.modelPort,
    controlAddress: proxy.controlAddress,
    sessionId,
    identitySource: "fresh random launch id",
    persistencePath: proxy.controlAddress
      ? join(homedir(), ".context-surgeon", "sessions", sessionId)
      : null,
    guarantee: proxy.guarantee(),
  });

  try {
    const code = await runWrappedChild({
      command: target,
      args: childArgs,
      env: childEnv,
      runtime: proxy,
      cleanup: cleanupRecord,
    });
    process.exitCode = code;
  } catch (error) {
    console.error(`[context-surgeon] Failed to start ${target}`);
    throw error;
  }
}

export async function launchCursor(
  extraArgs: string[],
  integrations: RuntimeIntegrations = {}
): Promise<void> {
  if (surgeryDisabled(process.env)) {
    throw new Error(
      "Cursor has no local child CLI to launch transparently; explicit bypass refuses to start a proxy or tunnel."
    );
  }
  if (!extraArgs.includes("--experimental")) {
    throw new Error(
      "Cursor v2 surgery is unsupported until the B3b response-translation gate lands. " +
        "Pass --experimental to run the isolated model tunnel without a v2 truth guarantee."
    );
  }

  const sessionId = randomUUID();
  const proxy = await startConfiguredProxy({
    target: "cursor",
    sessionId,
    trafficPolicy: policyForMode("cursor-experimental"),
    integrations,
  });
  const cleanupRecord = installRuntimeRecord({
    target: "cursor",
    mode: "cursor-experimental-unsupported",
    sessionId,
    proxy,
  });
  let tunnel: Awaited<ReturnType<typeof startCloudflaredTunnel>> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (reason: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      await tunnel?.close();
      await proxy.close({ reason });
      cleanupRecord();
    })();
    return shutdownPromise;
  };

  try {
    const noTunnel = extraArgs.includes("--no-tunnel");
    const baseUrl = noTunnel
      ? `http://127.0.0.1:${proxy.modelPort}/v1`
      : `${(
          tunnel = await startCloudflaredTunnel({
            modelPort: proxy.modelPort,
            startupTimeoutMs: parseInt(
              process.env.CONTEXT_SURGEON_TUNNEL_STARTUP_TIMEOUT_MS || "15000",
              10
            ),
          })
        ).publicUrl}/v1`;

    printStartupBanner({
      target: "cursor",
      mode: "experimental/unsupported until B3b",
      upstreamClass: "openai-api via Cursor backend",
      authClass: "Cursor BYOK forwarding",
      modelPort: proxy.modelPort,
      controlAddress: proxy.controlAddress,
      sessionId,
      identitySource: "fresh random launch id",
      persistencePath: proxy.controlAddress
        ? join(homedir(), ".context-surgeon", "sessions", sessionId)
        : null,
      guarantee: proxy.guarantee(),
    });
    console.error(
      `[context-surgeon] Cursor model URL: ${baseUrl}\n` +
        "[context-surgeon] Control is never served on this URL. Ctrl-C to stop."
    );

    await new Promise<void>((resolve) => {
      let resolved = false;
      const stop = (signal: NodeJS.Signals): void => {
        if (resolved) return;
        resolved = true;
        void shutdown(`received ${signal}`).then(resolve);
      };
      process.once("SIGINT", () => stop("SIGINT"));
      process.once("SIGTERM", () => stop("SIGTERM"));
      tunnel?.child.once("exit", () => {
        if (resolved) return;
        resolved = true;
        console.error("[context-surgeon] Tunnel exited; shutting down instead of falling back");
        void shutdown("tunnel exited").then(resolve);
      });
    });
  } catch (error) {
    await shutdown("cursor startup failed");
    throw error;
  }
}
