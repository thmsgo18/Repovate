import { describe, expect, it } from "vitest";
import { agentConfigSchema } from "./schema.js";
import { ConfigValidationError, parseConfig } from "./load.js";

describe("agentConfigSchema", () => {
  it("fills in reasonable defaults for an empty config", () => {
    const config = parseConfig({});
    expect(config.enabled).toBe(true);
    expect(config.autonomy.default).toBe("pr_only");
    expect(config.sources).toEqual({
      osv: true,
      ghsa: true,
      nvd: true,
      cisa_kev: true,
      ecosystem_feeds: [],
    });
    expect(config.limits).toEqual({ max_prs_per_run: 3, patch_retry_max_attempts: 2 });
  });

  it("accepts a fully specified config matching docs/architecture.md", () => {
    const config = parseConfig({
      enabled: true,
      sources: { osv: true, ghsa: true, nvd: false, cisa_kev: true, ecosystem_feeds: ["npm-security"] },
      coordination: { dependabot: true },
      limits: { max_prs_per_run: 5, patch_retry_max_attempts: 1 },
      autonomy: {
        default: "pr_only",
        rules: [
          {
            match: { trigger: "cve", severity: ["critical", "high"], cisa_kev: "any" },
            action: "auto_merge",
            conditions: { tests_pass: "required", max_files_changed: 5, max_lines_changed: 150 },
          },
          { match: { trigger: "cve", severity: ["medium", "low"] }, action: "pr_only" },
          { match: { trigger: "eol_dependency" }, action: "pr_only" },
          { match: { trigger: "new_technology" }, action: "branch_only" },
        ],
      },
      notifications: { on_auto_merge: "issue", on_pr_opened: "none" },
      ignore: [{ id: "GHSA-xxxx-xxxx-xxxx", reason: "vendored fork, patché localement" }],
    });
    expect(config.autonomy.rules).toHaveLength(4);
  });

  it("rejects an unknown top-level key structure gracefully (wrong type)", () => {
    expect(() => parseConfig({ enabled: "yes" })).toThrow();
  });

  it.each(["eol_dependency", "new_technology"] as const)(
    "rejects auto_merge on the structural trigger %s — hard rule, never overridable",
    (trigger) => {
      expect(() =>
        parseConfig({
          autonomy: { rules: [{ match: { trigger }, action: "auto_merge" }] },
        }),
      ).toThrow(ConfigValidationError);
    },
  );

  it("allows auto_merge on a cve trigger", () => {
    const config = parseConfig({
      autonomy: { rules: [{ match: { trigger: "cve", severity: ["critical"] }, action: "auto_merge" }] },
    });
    expect(config.autonomy.rules[0]?.action).toBe("auto_merge");
  });

  it("reports readable issue paths on validation failure", () => {
    try {
      parseConfig({ autonomy: { rules: [{ match: { trigger: "eol_dependency" }, action: "auto_merge" }] } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      expect(issues[0]).toContain("autonomy.rules.0.action");
    }
  });

  it("agentConfigSchema.safeParse matches parseConfig for a valid input", () => {
    const result = agentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
