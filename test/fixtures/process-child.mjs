import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [mode, path] = process.argv.slice(2);

if (mode === "normal") {
  process.exit(Number(path || 0));
}

if (mode === "descendant") {
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

if (mode === "stubborn-tree") {
  const descendant = spawn(process.execPath, [new URL(import.meta.url).pathname, "descendant"], {
    stdio: "ignore",
  });
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  writeFileSync(path, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
  setInterval(() => {}, 1_000);
}
