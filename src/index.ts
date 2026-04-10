#!/usr/bin/env node

import { launch } from "./cli/launch.js";
import { runCommand } from "./cli/commands.js";

const args = process.argv.slice(2);

// If CONTEXT_SURGEON_PORT is set, we're in command mode
// (called by the agent inside a wrapped session)
if (process.env.CONTEXT_SURGEON_PORT) {
  runCommand(args).catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  // Launcher mode: first arg is the target CLI
  const target = args[0];
  const extraArgs = args.slice(1);

  if (target === "codex" || target === "claude") {
    launch(target, extraArgs).catch((err) => {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
  } else {
    console.log(`context-surgeon v0.1.0

Usage:
  context-surgeon codex [args...]    Launch Codex with context surgery enabled
  context-surgeon claude [args...]   Launch Claude Code with context surgery enabled

When running inside a session:
  context-surgeon evict <id> [--media image|document] [--occurrences 1,3]
                                                Evict a whole unit or just media blocks
  context-surgeon replace <id> --content "..."  Replace content with summary
  context-surgeon restore <id>                  Restore evicted/replaced content
  context-surgeon status                        Show context surgery state`);
    process.exit(target ? 1 : 0);
  }
}
