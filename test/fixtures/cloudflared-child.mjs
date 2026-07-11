import { writeFileSync } from "node:fs";

const mode = process.argv[2];
const pidPath = process.env.FAKE_TUNNEL_PID_PATH;
if (pidPath) writeFileSync(pidPath, String(process.pid));

if (mode === "url") {
  process.stderr.write("https://split-url.trycloud");
  setTimeout(() => process.stderr.write("flare.com\n"), 10);
  setInterval(() => {}, 1_000);
} else if (mode === "exit") {
  process.exit(17);
} else if (mode === "silent") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
