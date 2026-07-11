import { describe, expect, it } from "vitest";
import {
  classifyCodexLaunch,
  injectCodexProviderArgs,
  parseConfigOverrides,
  parseTopLevelCodexConfig,
} from "../src/runtime/launch-mode.js";
import {
  applySafeClaudeEnvironment,
  withSafeClaudeDefaults,
} from "../src/cli/launch.js";

function classify(input: {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  authMode?: "chatgpt" | "api-key" | "unknown";
  config?: Readonly<Record<string, string>>;
} = {}) {
  return classifyCodexLaunch({
    args: input.args ?? [],
    env: input.env ?? {},
    authMode: input.authMode ?? "chatgpt",
    userConfig: input.config ?? {},
    proxyBase: "http://127.0.0.1:4321",
  });
}

describe("Claude launch safety defaults", () => {
  it("disables background prompt-suggestion requests unless explicitly configured", () => {
    expect(withSafeClaudeDefaults(["--model", "haiku"])).toEqual([
      "--prompt-suggestions",
      "false",
      "--model",
      "haiku",
    ]);
    expect(withSafeClaudeDefaults(["--prompt-suggestions", "true", "--model", "haiku"]))
      .toEqual(["--prompt-suggestions", "true", "--model", "haiku"]);
    expect(withSafeClaudeDefaults(["--prompt-suggestions=false"]))
      .toEqual(["--prompt-suggestions=false"]);
  });

  it("disables nonessential Claude network traffic while preserving an explicit override", () => {
    const defaults: NodeJS.ProcessEnv = {};
    applySafeClaudeEnvironment(defaults);
    expect(defaults.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");

    const explicit: NodeJS.ProcessEnv = {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
    };
    applySafeClaudeEnvironment(explicit);
    expect(explicit.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("0");
  });
});

describe("Codex positive launch classification", () => {
  it("injects provider config into the active Codex command scope", () => {
    const provider = ["-c", 'model_provider="context_surgeon_chatgpt"'];
    expect(injectCodexProviderArgs(["exec", "-m", "gpt-5.4-mini", "work"], provider))
      .toEqual(["exec", "-m", "gpt-5.4-mini", "work", ...provider]);
    expect(injectCodexProviderArgs(["e", "-m", "gpt-5.4-mini", "work"], provider))
      .toEqual(["e", "-m", "gpt-5.4-mini", "work", ...provider]);
    expect(injectCodexProviderArgs(["--disable", "fast_mode", "exec", "work"], provider))
      .toEqual(["--disable", "fast_mode", "exec", "work", ...provider]);
    expect(injectCodexProviderArgs(["-a", "never", "exec", "review", "--uncommitted"], provider))
      .toEqual(["-a", "never", "exec", "review", "--uncommitted", ...provider]);
    expect(injectCodexProviderArgs(["resume", "--last"], provider))
      .toEqual(["resume", "--last", ...provider]);
    expect(injectCodexProviderArgs(["exec", "--", "literal", "-c", "model_provider=ignored"], provider))
      .toEqual(["exec", ...provider, "--", "literal", "-c", "model_provider=ignored"]);
    expect(injectCodexProviderArgs(["-m", "review", "interactive prompt"], provider))
      .toEqual([...provider, "-m", "review", "interactive prompt"]);
    expect(injectCodexProviderArgs(["interactive prompt"], provider))
      .toEqual([...provider, "interactive prompt"]);
  });

  it("configures subscription auth without unconditional built-in base URL overrides", () => {
    const plan = classify();
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.mode).toBe("subscription");
    expect(plan.providerArgs.join(" ")).toContain("context_surgeon_chatgpt");
    expect(plan.providerArgs.join(" ")).toContain("requires_openai_auth=true");
    expect(plan.providerArgs.join(" ")).not.toContain("chatgpt_base_url");
    expect(plan.providerArgs.join(" ")).not.toContain("openai_base_url");
  });

  it("configures a known environment API key by name without copying its value", () => {
    const plan = classify({
      env: { OPENAI_API_KEY: "super-secret-api-key" },
      authMode: "chatgpt",
    });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.mode).toBe("api-key");
    expect(plan.providerArgs.join(" ")).toContain('env_key="OPENAI_API_KEY"');
    expect(plan.providerArgs.join(" ")).not.toContain("super-secret-api-key");
    expect(plan.trafficPolicy.expectedPaths).toEqual(["/v1/responses"]);
  });

  it("uses native stored API-key auth without reading credentials", () => {
    const plan = classify({ authMode: "api-key" });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.mode).toBe("api-key");
    expect(plan.providerArgs.join(" ")).toContain("requires_openai_auth=true");
    expect(plan.providerArgs.join(" ")).not.toContain("env_key");
  });

  it("supports CODEX_API_KEY only for the documented exec mode", () => {
    const plan = classify({
      args: ["exec", "do work"],
      env: { CODEX_API_KEY: "one-run-secret" },
      authMode: "unknown",
    });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.providerArgs.join(" ")).toContain('env_key="CODEX_API_KEY"');
    expect(plan.providerArgs.join(" ")).not.toContain("one-run-secret");

    const aliasPlan = classify({
      args: ["e", "do work"],
      env: { CODEX_API_KEY: "alias-secret" },
      authMode: "unknown",
    });
    expect(aliasPlan).toMatchObject({ supported: true, mode: "api-key" });
    if (aliasPlan.supported) {
      expect(aliasPlan.providerArgs.join(" ")).toContain('env_key="CODEX_API_KEY"');
      expect(aliasPlan.providerArgs.join(" ")).not.toContain("alias-secret");
    }

    expect(
      classify({ env: { CODEX_API_KEY: "ignored-interactively" }, authMode: "unknown" })
    ).toMatchObject({ supported: false, mode: "auth-unknown" });
  });

  it.each([
    { name: "OSS", input: { args: ["--oss"] }, mode: "oss" },
    { name: "profile flag", input: { args: ["--profile", "work"] }, mode: "profile" },
    { name: "attached profile flag", input: { args: ["-pwork"] }, mode: "profile" },
    { name: "profile config", input: { args: ["-c", 'profile="work"'] }, mode: "profile" },
    { name: "custom provider arg", input: { args: ["-c", 'model_provider="azure"'] }, mode: "custom-provider" },
    { name: "explicit built-in provider arg", input: { args: ["-c", 'model_provider="openai"'] }, mode: "custom-provider" },
    { name: "provider definition arg", input: { args: ["exec", "-c", 'model_providers.context_surgeon_chatgpt.base_url="https://bypass.test"'] }, mode: "custom-provider" },
    { name: "provider table arg", input: { args: ["exec", "-c", 'model_providers={context_surgeon_chatgpt={base_url="https://bypass.test"}}'] }, mode: "custom-provider" },
    { name: "remote mode", input: { args: ["resume", "--remote", "ws://127.0.0.1:9000"] }, mode: "remote" },
    { name: "remote auth mode", input: { args: ["fork", "--remote-auth-token-env=TOKEN"] }, mode: "remote" },
    { name: "local provider", input: { args: ["--local-provider", "ollama"] }, mode: "oss" },
    { name: "app server", input: { args: ["app-server"] }, mode: "server" },
    { name: "MCP server", input: { args: ["mcp-server"] }, mode: "server" },
    { name: "exec server", input: { args: ["exec-server"] }, mode: "server" },
    { name: "remote control", input: { args: ["remote-control"] }, mode: "server" },
    { name: "detached app", input: { args: ["app"] }, mode: "server" },
    { name: "cloud task", input: { args: ["cloud"] }, mode: "server" },
    { name: "custom provider file", input: { config: { model_provider: "ollama" } }, mode: "custom-provider" },
    { name: "custom URL env", input: { env: { OPENAI_BASE_URL: "https://gateway.test/v1" } }, mode: "custom-base-url" },
    { name: "custom URL config", input: { config: { openai_base_url: "https://gateway.test/v1" } }, mode: "custom-base-url" },
    { name: "unknown login", input: { authMode: "unknown" as const }, mode: "auth-unknown" },
  ])("rejects $name rather than misrouting", ({ input, mode }) => {
    const plan = classify(input);
    expect(plan).toMatchObject({ supported: false, mode });
  });

  it("parses every supported -c spelling without treating arbitrary args as config", () => {
    expect(
      parseConfigOverrides([
        "-c",
        'model_provider="openai"',
        "-cforced_login_method='api'",
        "--config=openai_base_url='https://example.test'",
        "exec",
      ])
    ).toEqual({
      model_provider: "openai",
      forced_login_method: "api",
      openai_base_url: "https://example.test",
    });
  });

  it("reads only top-level provider settings from config.toml", () => {
    expect(
      parseTopLevelCodexConfig(`
        model_provider = "openai" # comment
        forced_login_method = "chatgpt"
        [profiles.work]
        model_provider = "custom"
      `)
    ).toEqual({ model_provider: "openai", forced_login_method: "chatgpt" });
  });
});
