/** Our own canonical ecosystem identifiers — each detect/ source client maps these to whatever casing/name that specific API expects (OSV wants "PyPI", GHSA wants "PIP", neither matches the other or us). */
export type Ecosystem = "npm" | "pypi";

export interface DependencyRef {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  /** True if declared directly in the manifest (package.json deps, or every line of a flat requirements.txt), false if only pulled in transitively. */
  direct: boolean;
  /** Path (relative to repo root) of the manifest this dependency was found under — a monorepo can have several. */
  manifestPath: string;
}

/** Shared shape returned by every per-ecosystem manifest parser (npm, python, ...). */
export interface ManifestDetectionResult {
  manifestPath: string;
  lockfilePath: string | null;
  dependencies: DependencyRef[];
  /**
   * "full" once a real lockfile was parsed (direct + transitive, exact
   * resolved versions). "direct-only" when there is no lockfile — per
   * docs/architecture.md 4.2.1, this must be surfaced to the user
   * ("dépendances transitives non vérifiées, aucun lockfile présent"),
   * never silently treated as equivalent to full coverage.
   */
  transitiveCoverage: "full" | "direct-only";
}
