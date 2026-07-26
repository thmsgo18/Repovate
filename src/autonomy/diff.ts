import path from "node:path";

export type FileCategory = "manifest" | "lockfile" | "source";

// Basename match, not full path — a monorepo's backend/package.json is still
// a manifest. requirements.txt has no lockfile concept, so it's always
// "manifest" even though npm's install step regenerates nothing for it.
const MANIFEST_BASENAMES = new Set(["package.json", "requirements.txt"]);
const LOCKFILE_BASENAMES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);

export function classifyFile(filePath: string): FileCategory {
  const base = path.basename(filePath);
  if (MANIFEST_BASENAMES.has(base)) return "manifest";
  if (LOCKFILE_BASENAMES.has(base)) return "lockfile";
  return "source";
}

export interface FileDiffStat {
  path: string;
  linesChanged: number;
  category: FileCategory;
}

export interface DiffStats {
  files: FileDiffStat[];
  filesChangedExcludingLockfiles: number;
  linesChangedExcludingLockfiles: number;
  /** docs/architecture.md section 4: the only "patch simple" definition — objective, mechanically verifiable from the diff itself. */
  touchesSourceFile: boolean;
  isSimplePatch: boolean;
}

const DIFF_GIT_LINE = /^diff --git a\/(.+) b\/(.+)$/;

/**
 * Parses `git diff` unified-diff output into per-file stats. Deliberately
 * minimal — this only needs file paths and a line-change count per file,
 * not a full patch model.
 */
export function parseDiffStats(diffText: string): DiffStats {
  const files: FileDiffStat[] = [];
  let current: FileDiffStat | null = null;

  for (const line of diffText.split("\n")) {
    const gitLineMatch = DIFF_GIT_LINE.exec(line);
    if (gitLineMatch?.[2]) {
      current = { path: gitLineMatch[2], linesChanged: 0, category: classifyFile(gitLineMatch[2]) };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      current.linesChanged += 1;
    }
  }

  const nonLockfiles = files.filter((f) => f.category !== "lockfile");
  const touchesSourceFile = files.some((f) => f.category === "source");

  return {
    files,
    filesChangedExcludingLockfiles: nonLockfiles.length,
    linesChangedExcludingLockfiles: nonLockfiles.reduce((sum, f) => sum + f.linesChanged, 0),
    touchesSourceFile,
    isSimplePatch: !touchesSourceFile,
  };
}
