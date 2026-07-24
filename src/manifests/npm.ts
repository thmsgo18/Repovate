import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { DependencyRef } from "./types.js";

export interface NpmDetectionResult {
  /** Path to package.json, relative to repo root. */
  manifestPath: string;
  /** Path to package-lock.json, relative to repo root — null if none was found. */
  lockfilePath: string | null;
  dependencies: DependencyRef[];
  /**
   * "full" once a lockfile was parsed (direct + transitive, exact resolved
   * versions). "direct-only" when there is no lockfile — per
   * docs/architecture.md 4.2.1, this must be surfaced to the user
   * ("dépendances transitives non vérifiées, aucun lockfile présent"),
   * never silently treated as equivalent to full coverage.
   */
  transitiveCoverage: "full" | "direct-only";
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".repovate-tooling"]);

/** Finds every package.json in the repo (a monorepo can have several), skipping node_modules. */
export async function findPackageJsonFiles(repoRoot: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "package.json") {
        found.push(path.relative(repoRoot, path.join(dir, entry.name)));
      }
    }
  }

  await walk(repoRoot);
  return found.sort();
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface LockfileV2Or3 {
  lockfileVersion: 2 | 3;
  packages: Record<
    string,
    {
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
}

interface LockfileV1Entry {
  version: string;
  dependencies?: Record<string, LockfileV1Entry>;
}

interface LockfileV1 {
  lockfileVersion?: 1;
  dependencies?: Record<string, LockfileV1Entry>;
}

/** Strips a leading npm range operator (^, ~, >=, >, <=, <, =) to approximate a floor version when no lockfile pins an exact one. */
function approximateVersion(range: string): string {
  return range.replace(/^[\^~]|^>=?|^<=?|^=/, "").trim();
}

function nameFromPackagesKey(key: string): string | null {
  if (key === "") return null;
  const marker = "node_modules/";
  const idx = key.lastIndexOf(marker);
  if (idx === -1) return null;
  return key.slice(idx + marker.length);
}

function parseLockfileV2Or3(lockfile: LockfileV2Or3, manifestPath: string): DependencyRef[] {
  const root = lockfile.packages[""];
  const directNames = new Set([
    ...Object.keys(root?.dependencies ?? {}),
    ...Object.keys(root?.devDependencies ?? {}),
  ]);

  const deps: DependencyRef[] = [];
  for (const [key, entry] of Object.entries(lockfile.packages)) {
    const name = nameFromPackagesKey(key);
    if (!name || !entry.version) continue;
    // A package can be both a real root dependency ("node_modules/uuid") and,
    // independently, a *different, nested* copy pulled in by another package
    // at a different version ("node_modules/sequelize/node_modules/uuid").
    // Only the top-level entry is "direct" — same name, deeper path, is a
    // transitive copy regardless of whether the name also appears at root.
    const isTopLevel = key === `node_modules/${name}`;
    deps.push({
      name,
      version: entry.version,
      ecosystem: "npm",
      direct: isTopLevel && directNames.has(name),
      manifestPath,
    });
  }
  return deps;
}

function parseLockfileV1(lockfile: LockfileV1, manifestPath: string, directNames: Set<string>): DependencyRef[] {
  const deps: DependencyRef[] = [];

  // lockfileVersion 1 hoists non-conflicting transitive packages to the same
  // top-level `dependencies` object as truly-direct ones — the tree shape
  // alone can't tell them apart. package.json's own dependency names are the
  // only reliable signal, regardless of where an entry sits in this tree.
  function walk(tree: Record<string, LockfileV1Entry> | undefined): void {
    if (!tree) return;
    for (const [name, entry] of Object.entries(tree)) {
      deps.push({ name, version: entry.version, ecosystem: "npm", direct: directNames.has(name), manifestPath });
      walk(entry.dependencies);
    }
  }

  walk(lockfile.dependencies);
  return deps;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Parses one package.json (and its sibling package-lock.json, if any) into dependency refs. */
export async function parseNpmManifest(repoRoot: string, manifestPath: string): Promise<NpmDetectionResult> {
  const manifestDir = path.dirname(manifestPath);
  const lockfileRelPath = path.join(manifestDir, "package-lock.json");
  const [lockfile, packageJson] = await Promise.all([
    readJson<LockfileV1 | LockfileV2Or3>(path.join(repoRoot, lockfileRelPath)),
    readJson<PackageJsonShape>(path.join(repoRoot, manifestPath)),
  ]);
  const directNames = new Set([
    ...Object.keys(packageJson?.dependencies ?? {}),
    ...Object.keys(packageJson?.devDependencies ?? {}),
  ]);

  if (lockfile && "lockfileVersion" in lockfile && (lockfile.lockfileVersion === 2 || lockfile.lockfileVersion === 3)) {
    return {
      manifestPath,
      lockfilePath: lockfileRelPath,
      dependencies: parseLockfileV2Or3(lockfile, manifestPath),
      transitiveCoverage: "full",
    };
  }
  if (lockfile && "dependencies" in lockfile && lockfile.dependencies) {
    return {
      manifestPath,
      lockfilePath: lockfileRelPath,
      dependencies: parseLockfileV1(lockfile as LockfileV1, manifestPath, directNames),
      transitiveCoverage: "full",
    };
  }

  const direct = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) };
  const dependencies: DependencyRef[] = Object.entries(direct).map(([name, range]) => ({
    name,
    version: approximateVersion(range),
    ecosystem: "npm",
    direct: true,
    manifestPath,
  }));

  return { manifestPath, lockfilePath: null, dependencies, transitiveCoverage: "direct-only" };
}

/** Discovers and parses every npm manifest in the repo. */
export async function findNpmDependencies(repoRoot: string): Promise<NpmDetectionResult[]> {
  const manifestPaths = await findPackageJsonFiles(repoRoot);
  return Promise.all(manifestPaths.map((manifestPath) => parseNpmManifest(repoRoot, manifestPath)));
}
