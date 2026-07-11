import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string; files: string[]; scripts: Record<string, string> };
const lock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")
) as { version: string; packages: Record<string, { version?: string }> };

describe("package metadata", () => {
  it("keeps package and lock versions aligned", () => {
    expect(lock.version).toBe(packageJson.version);
    expect(lock.packages[""].version).toBe(packageJson.version);
  });

  it("ships the compact bootstrap and full guide with a packed-install gate", () => {
    const skill = readFileSync(new URL("../skill.md", import.meta.url), "utf8").trim();
    expect(skill.split(/\r?\n/).length).toBeLessThanOrEqual(11);
    expect(skill).toContain("context-surgeon guide");
    expect(packageJson.files).toContain("guide.md");
    expect(packageJson.scripts["test:package"]).toContain("test-packed-install.mjs");
  });
});
