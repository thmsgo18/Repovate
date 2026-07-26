import { z } from "zod";

export const triggerSchema = z.enum(["cve", "eol_dependency", "new_technology"]);
export const severitySchema = z.enum(["critical", "high", "medium", "low"]);
export const actionSchema = z.enum(["auto_merge", "pr_only", "branch_only"]);

const matchSchema = z.object({
  trigger: triggerSchema,
  severity: z.array(severitySchema).optional(),
  cisa_kev: z.union([z.literal("any"), z.boolean()]).optional(),
});

const conditionsSchema = z.object({
  tests_pass: z.literal("required").optional(),
  max_files_changed: z.number().int().positive().optional(),
  max_lines_changed: z.number().int().positive().optional(),
});

const ruleSchema = z.object({
  match: matchSchema,
  action: actionSchema,
  conditions: conditionsSchema.optional(),
});

const autonomySchema = z.object({
  default: z.enum(["pr_only", "auto_merge"]).default("pr_only"),
  rules: z.array(ruleSchema).default([]),
});

const sourcesSchema = z.object({
  osv: z.boolean().default(true),
  ghsa: z.boolean().default(true),
  nvd: z.boolean().default(true),
  cisa_kev: z.boolean().default(true),
  ecosystem_feeds: z.array(z.string()).default([]),
});

const coordinationSchema = z.object({
  dependabot: z.boolean().default(true),
});

const limitsSchema = z.object({
  max_prs_per_run: z.number().int().positive().default(3),
  patch_retry_max_attempts: z.number().int().min(0).default(2),
});

const notificationsSchema = z.object({
  on_auto_merge: z.enum(["issue", "none"]).default("issue"),
  on_pr_opened: z.enum(["issue", "none"]).default("none"),
});

const ignoreEntrySchema = z.object({
  id: z.string(),
  reason: z.string(),
});

// Hard rules from docs/architecture.md section 4 are enforced twice on purpose:
// here (fail fast on an invalid config file) and again in the autonomy decision
// engine at run time (so a rule that somehow slips through can never fire).
const STRUCTURAL_TRIGGERS = new Set(["eol_dependency", "new_technology"]);

export const agentConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    sources: sourcesSchema.default({}),
    coordination: coordinationSchema.default({}),
    limits: limitsSchema.default({}),
    autonomy: autonomySchema.default({}),
    notifications: notificationsSchema.default({}),
    ignore: z.array(ignoreEntrySchema).default([]),
  })
  .superRefine((config, ctx) => {
    config.autonomy.rules.forEach((rule, index) => {
      if (STRUCTURAL_TRIGGERS.has(rule.match.trigger) && rule.action === "auto_merge") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["autonomy", "rules", index, "action"],
          message: `"${rule.match.trigger}" can never be auto_merge — this is a hard rule, not configurable (see docs/architecture.md section 4).`,
        });
      }
    });
  });

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AutonomyRule = z.infer<typeof ruleSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type AutonomyAction = z.infer<typeof actionSchema>;
