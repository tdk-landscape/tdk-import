import { posix } from "node:path";
import type { Skip } from "./types.js";

interface UnsupportedFormat {
  label: string;
  matches(name: string): boolean;
}

/** Orchestration formats people expect to import. They are named and skipped, never translated. */
const UNSUPPORTED: UnsupportedFormat[] = [
  { label: "Helm", matches: (name) => name === "Chart.yaml" },
  { label: "Kustomize", matches: (name) => /^kustomization\.ya?ml$/.test(name) },
];

/** Skips for recognised-but-unsupported files, so a repo is never silently reported as empty. */
export function findUnsupported(files: string[]): { skips: Skip[]; labels: string[] } {
  const skips: Skip[] = [];
  const labels = new Set<string>();
  for (const file of files) {
    const name = posix.basename(file);
    for (const format of UNSUPPORTED) {
      if (!format.matches(name)) continue;
      labels.add(format.label);
      skips.push({
        file,
        detector: "unsupported",
        reason: `${format.label} is not imported`,
      });
    }
  }
  return { skips, labels: [...labels] };
}
