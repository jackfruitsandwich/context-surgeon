#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { launch, launchCursor } from "./cli/launch.js";
import { runCommand } from "./cli/commands.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: string };
const packageVersion = packageJson.version ?? "unknown";

const args = process.argv.slice(2);
const commandModeCommands = new Set([
  "evict",
  "replace",
  "restore",
  "status",
  "skeleton",
]);

function printGuide(): void {
  try {
    process.stdout.write(readFileSync(new URL("../guide.md", import.meta.url), "utf8"));
  } catch {
    console.error("Error: the packaged context-surgeon guide is missing");
    process.exitCode = 1;
  }
}

// Command mode works inside wrapped sessions via CONTEXT_SURGEON_PORT, and
// from normal shells via the session port file.
if (args[0] === "guide") {
  printGuide();
} else if (process.env.CONTEXT_SURGEON_PORT || commandModeCommands.has(args[0] ?? "")) {
  runCommand(args).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  // Launcher mode: first arg is the target CLI
  const target = args[0];
  const extraArgs = args.slice(1);

  if (target === "codex" || target === "claude" || target === "claude-ev") {
    launch(target, extraArgs).catch((err) => {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
  } else if (target === "cursor") {
    launchCursor(extraArgs).catch((err) => {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
  } else {
    console.log(`context-surgeon v${packageVersion}

Usage:
  context-surgeon codex [args...]    Launch Codex with context surgery enabled
  context-surgeon claude [args...]   Launch Claude Code with context surgery enabled
  context-surgeon claude-ev [args...] Launch the claude-ev build with context surgery enabled
  context-surgeon cursor --experimental
                                     Experimental isolated model tunnel for Cursor;
                                     unsupported until the B3b translation gate
  context-surgeon guide              Print the full agent operating manual

When running inside a session:
  context-surgeon skeleton [--json]             Show current revision and occurrence IDs
  context-surgeon evict <occurrence-id> [--require-complete]
                                                Commit an eviction for one occurrence
  context-surgeon replace <occurrence-id> --content "..."
                                                Commit reviewed replacement text
  context-surgeon restore <occurrence-id>       Commit a reversal
  context-surgeon status                        Show intent, reconciliation, attempt, and usage truth`);
    process.exit(target ? 1 : 0);
  }
}
