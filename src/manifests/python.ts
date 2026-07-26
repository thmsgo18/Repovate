import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { DependencyRef, ManifestDetectionResult } from "./types.js";

const SKIP_DIRS = new Set([".git", "venv", ".venv", "__pycache__", "node_modules", ".repovate-tooling"]);
const REQUIREMENTS_FILENAME = "requirements.txt";

/** Finds every requirements.txt in the repo, skipping virtualenvs/caches. */
export async function findRequirementsFiles(repoRoot: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === REQUIREMENTS_FILENAME) {
        found.push(path.relative(repoRoot, path.join(dir, entry.name)));
      }
    }
  }

  await walk(repoRoot);
  return found.sort();
}

const VERSION_SPECIFIER = /==|>=|<=|~=|!=|>|</;

/** Strips a leading pip version-specifier operator to approximate a floor version, same convention as npm.ts's fallback for an unresolved range. */
function approximateVersion(specifier: string): string {
  return specifier.replace(/^(==|>=|<=|~=|!=|>|<)/, "").trim();
}

/**
 * Parses one requirement line into name+version, or null for a line that
 * isn't a plain package requirement (comment, blank, option flag, a
 * recursive -r include, a local/VCS path, or an unparseable line — none of
 * those are things we can meaningfully version-check).
 */
export function parseRequirementLine(rawLine: string): { name: string; version: string } | null {
  // Strip an environment marker (`; python_version >= "3.8"`) and any
  // trailing comment first — both can contain characters that would
  // otherwise confuse the specifier split below.
  let line = rawLine.split(";")[0]!.split("#")[0]!.trim();
  if (line === "" || line.startsWith("-")) return null;

  const match = line.match(VERSION_SPECIFIER);
  if (!match) return null; // unpinned ("requests") — nothing to version-check

  const name = line.slice(0, match.index).trim();
  const specifier = line.slice(match.index);
  if (!name) return null;

  // Drop an extras marker, e.g. "psycopg[binary]" -> "psycopg" — same
  // underlying PyPI package, vulnerability status doesn't depend on it.
  const bareName = name.replace(/\[[^\]]*\]/, "");

  return { name: bareName, version: approximateVersion(specifier) };
}

/**
 * Parses one requirements.txt. There is no universal lockfile for this
 * format (unlike package-lock.json) — poetry.lock/Pipfile.lock belong to
 * different tools entirely — so this is always direct-only, exact-pin
 * versions when the file pins with "==", approximated otherwise.
 */
export async function parseRequirementsFile(repoRoot: string, manifestPath: string): Promise<ManifestDetectionResult> {
  const content = await readFile(path.join(repoRoot, manifestPath), "utf8");
  const dependencies: DependencyRef[] = [];

  for (const rawLine of content.split("\n")) {
    const parsed = parseRequirementLine(rawLine);
    if (!parsed) continue;
    dependencies.push({
      name: parsed.name,
      version: parsed.version,
      ecosystem: "pypi",
      direct: true,
      manifestPath,
    });
  }

  return { manifestPath, lockfilePath: null, dependencies, transitiveCoverage: "direct-only" };
}

/** Discovers and parses every requirements.txt in the repo. */
export async function findPythonDependencies(repoRoot: string): Promise<ManifestDetectionResult[]> {
  const manifestPaths = await findRequirementsFiles(repoRoot);
  return Promise.all(manifestPaths.map((manifestPath) => parseRequirementsFile(repoRoot, manifestPath)));
}
