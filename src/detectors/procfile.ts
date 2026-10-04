import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path/posix";
import { registerDetector } from "../registry.js";
import type { Candidate, Skip } from "../types.js";

const LINE = /^([A-Za-z0-9_-]+):\s*(.*)$/;

registerDetector({
  id: "procfile",
  claim: (relPath) => /^Procfile(\..+)?$/.test(basename(relPath)),
  parse(absPath, relPath) {
    const dir = dirname(relPath) === "." ? "" : dirname(relPath);
    const candidates: Candidate[] = [];
    const skips: Skip[] = [];
    const lines = readFileSync(absPath, "utf8").split(/\r?\n/);
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      const match = LINE.exec(line);
      if (!match) {
        skips.push({
          file: relPath,
          detector: "procfile",
          line: index + 1,
          reason: "not a `name: command` line",
        });
        return;
      }
      const [, name, command] = match as unknown as [string, string, string];
      if (!command) {
        skips.push({
          file: relPath,
          detector: "procfile",
          line: index + 1,
          reason: `process "${name}" has no command`,
        });
        return;
      }
      candidates.push({
        kind: name === "release" ? "job" : "service",
        name,
        dir,
        command,
        confidence: "high",
        sources: [{ file: relPath, detector: "procfile" }],
      });
    });
    return { candidates, skips };
  },
});
