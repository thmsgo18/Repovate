export interface DependencyRef {
  name: string;
  version: string;
  ecosystem: "npm";
  /** True if declared directly in package.json (dependencies/devDependencies), false if only pulled in transitively. */
  direct: boolean;
  /** Path (relative to repo root) of the manifest this dependency was found under — a monorepo can have several. */
  manifestPath: string;
}
