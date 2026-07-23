import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import { onboardingPath } from "./paths.js";

export const testSuiteSchema = z.object({
  present: z.boolean(),
  framework: z.string().nullable().default(null),
  command: z.string().nullable().default(null),
  coverage_estimate: z.string().nullable().default(null),
});

export const onboardingSchema = z.object({
  generated_at: z.string().datetime(),
  agent_version: z.string(),
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  architecture_summary: z.string(),
  entry_points: z.array(z.string()),
  code_conventions: z.string(),
  test_suite: testSuiteSchema,
  manifests_detected: z.array(z.string()),
  last_refresh_reason: z.string().nullable().default(null),
});

export type Onboarding = z.infer<typeof onboardingSchema>;
export type TestSuite = z.infer<typeof testSuiteSchema>;

/** Returns null if no onboarding has run yet for this repo. */
export async function readOnboarding(repoRoot: string): Promise<Onboarding | null> {
  return readJsonFile(onboardingPath(repoRoot), onboardingSchema);
}

export async function writeOnboarding(repoRoot: string, data: Onboarding): Promise<void> {
  await writeJsonFile(onboardingPath(repoRoot), onboardingSchema, data);
}
