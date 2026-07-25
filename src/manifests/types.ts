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
