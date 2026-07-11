import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "context-surgeon-pack-"));

try {
  execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", temporary],
      { cwd: root, encoding: "utf8" }
    )
  );
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return a filename");
  const tarball = join(temporary, filename);
  const prefix = join(temporary, "install");
  execFileSync("npm", ["install", "--ignore-scripts", "--prefix", prefix, tarball], {
    stdio: "inherit",
  });

  const packageJson = JSON.parse(readFileSync(join(prefix, "node_modules", "context-surgeon", "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (packageJson.version !== lock.version) {
    throw new Error(`packed version ${packageJson.version} does not match lock ${lock.version}`);
  }

  const bin = join(prefix, "node_modules", ".bin", "context-surgeon");
  execFileSync(bin, [], { stdio: ["ignore", "pipe", "inherit"] });
  execFileSync(bin, ["guide"], { stdio: ["ignore", "pipe", "inherit"] });
  console.log(`packed install verified: context-surgeon@${packageJson.version}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
