import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOnboard } from "./index.js";
import { readOnboarding } from "./memory/onboarding.js";

describe("runOnboard", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "repovate-onboard-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function writeRawOnboarding(content: unknown): Promise<void> {
    const agentDir = path.join(repoRoot, ".agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "onboarding.json"), JSON.stringify(content), "utf8");
  }

  const validRawShape = {
    languages: ["php"],
    frameworks: ["symfony"],
    architecture_summary: "A Symfony MVC app.",
    entry_points: ["src/Kernel.php"],
    code_conventions: "PSR-4 autoloading under App\\.",
    test_suite: { present: false, framework: null, command: null, coverage_estimate: null },
    manifests_detected: ["composer.json"],
  };

  it("stamps generated_at/agent_version and writes a schema-valid file", async () => {
    await writeRawOnboarding(validRawShape);
    process.env.REPOVATE_VERSION = "test-sha";

    await runOnboard(repoRoot);

    const result = await readOnboarding(repoRoot);
    expect(result?.agent_version).toBe("test-sha");
    expect(result?.generated_at).toBeTruthy();
    expect(result?.languages).toEqual(["php"]);
    delete process.env.REPOVATE_VERSION;
  });

  it("ignores generated_at/agent_version if Claude wrote them anyway — our own values win", async () => {
    await writeRawOnboarding({ ...validRawShape, generated_at: "2000-01-01T00:00:00Z", agent_version: "bogus" });

    await runOnboard(repoRoot);

    const result = await readOnboarding(repoRoot);
    expect(result?.generated_at).not.toBe("2000-01-01T00:00:00Z");
    expect(result?.agent_version).not.toBe("bogus");
  });

  it("throws when the raw onboarding file is missing", async () => {
    await expect(runOnboard(repoRoot)).rejects.toThrow(/could not be read/);
  });

  it("throws when the analysis is missing a required field — never commit a shape downstream code can't rely on", async () => {
    const { architecture_summary: _drop, ...incomplete } = validRawShape;
    await writeRawOnboarding(incomplete);
    await expect(runOnboard(repoRoot)).rejects.toThrow();
  });

  it("does not (yet) reject an internally inconsistent test_suite (present=true, framework=null)", async () => {
    await writeRawOnboarding({
      ...validRawShape,
      test_suite: { present: true, framework: null, command: null, coverage_estimate: null },
    });
    // Not enforced by the schema today (framework may legitimately be
    // unknown) — documents current behavior so a future schema tightening
    // is a deliberate decision, not a silent regression.
    await expect(runOnboard(repoRoot)).resolves.toBeUndefined();
  });
});
