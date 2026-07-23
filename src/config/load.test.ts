import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigValidationError, CONFIG_FILENAME, loadConfig } from "./load.js";

describe("loadConfig", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "repovate-config-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("returns schema defaults when .agentconfig.yml is missing", async () => {
    const config = await loadConfig(repoRoot);
    expect(config.enabled).toBe(true);
    expect(config.autonomy.default).toBe("pr_only");
  });

  it("parses a real YAML file from disk", async () => {
    await writeFile(
      path.join(repoRoot, CONFIG_FILENAME),
      [
        "enabled: true",
        "limits:",
        "  max_prs_per_run: 7",
        "autonomy:",
        "  default: pr_only",
        "  rules:",
        "    - match: { trigger: cve, severity: [critical, high] }",
        "      action: auto_merge",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = await loadConfig(repoRoot);
    expect(config.limits.max_prs_per_run).toBe(7);
    expect(config.autonomy.rules[0]?.action).toBe("auto_merge");
  });

  it("throws ConfigValidationError on a malformed YAML config rather than guessing a default", async () => {
    await writeFile(
      path.join(repoRoot, CONFIG_FILENAME),
      ["autonomy:", "  rules:", "    - match: { trigger: eol_dependency }", "      action: auto_merge", ""].join(
        "\n",
      ),
      "utf8",
    );
    await expect(loadConfig(repoRoot)).rejects.toBeInstanceOf(ConfigValidationError);
  });
});
