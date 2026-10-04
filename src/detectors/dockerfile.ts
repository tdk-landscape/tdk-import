import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path/posix";
import { registerDetector } from "../registry.js";
import type { Candidate, Skip } from "../types.js";

/** Joins `\` continuations and drops comments, keeping the first physical line number of each instruction. */
function instructions(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let pending: { line: number; text: string } | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!pending && (trimmed === "" || trimmed.startsWith("#"))) return;
    if (pending && trimmed.startsWith("#")) return;
    const continued = trimmed.endsWith("\\");
    const piece = continued ? trimmed.slice(0, -1).trim() : trimmed;
    pending = pending
      ? { line: pending.line, text: `${pending.text} ${piece}`.trim() }
      : { line: index + 1, text: piece };
    if (!continued) {
      out.push(pending);
      pending = null;
    }
  });
  if (pending) out.push(pending);
  return out;
}

function cmdToString(args: string): string {
  if (args.startsWith("[")) {
    try {
      const parsed = JSON.parse(args);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
        return parsed.join(" ");
      }
    } catch {
      // not exec form after all: fall through and keep the text
    }
  }
  return args;
}

registerDetector({
  id: "dockerfile",
  claim: (relPath) => basename(relPath) === "Dockerfile",
  parse(absPath, relPath) {
    const dir = dirname(relPath) === "." ? "" : dirname(relPath);
    const skips: Skip[] = [];
    // Only the last build stage is the image that runs.
    let ports: number[] = [];
    let command: string | undefined;
    for (const ins of instructions(readFileSync(absPath, "utf8"))) {
      const [keyword = "", ...rest] = ins.text.split(/\s+/);
      const args = rest.join(" ");
      switch (keyword.toUpperCase()) {
        case "FROM":
          ports = [];
          command = undefined;
          break;
        case "EXPOSE":
          for (const token of rest) {
            const port = Number.parseInt(token.split("/")[0] ?? "", 10);
            if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port);
          }
          break;
        case "CMD":
          command = cmdToString(args);
          break;
      }
    }
    const distinct = [...new Set(ports)];
    if (distinct.length > 1) {
      skips.push({
        file: relPath,
        detector: "dockerfile",
        reason: `EXPOSE lists several ports (${distinct.join(", ")}); port not imported`,
      });
    }
    const candidate: Candidate = {
      kind: "service",
      dir,
      dockerfile: "Dockerfile",
      ...(distinct.length === 1 ? { port: distinct[0] } : {}),
      ...(command ? { command } : {}),
      confidence: "high",
      sources: [{ file: relPath, detector: "dockerfile" }],
    };
    return { candidates: [candidate], skips };
  },
});
