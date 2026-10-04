import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path/posix";
import { registerDetector } from "../registry.js";

/** `bun` or `node` as the program, after any `KEY=value` prefixes. Anything else is not sure. */
function runtimeOf(command: string): "bun" | "node" | undefined {
  const words = command.trim().split(/\s+/);
  const program = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return program === "bun" || program === "node" ? program : undefined;
}

registerDetector({
  id: "package-json",
  claim: (relPath) => basename(relPath) === "package.json",
  parse(absPath, relPath) {
    const dir = dirname(relPath) === "." ? "" : dirname(relPath);
    const source = { file: relPath, detector: "package-json" };
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(absPath, "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.scripts === "object") {
        scripts = parsed.scripts ?? {};
      }
    } catch (err) {
      return {
        candidates: [],
        skips: [{ ...source, reason: `invalid JSON: ${(err as Error).message}` }],
      };
    }
    const pick = (key: string) =>
      typeof scripts[key] === "string" ? (scripts[key] as string) : "";
    const command = pick("start") || pick("dev");
    if (!command) {
      return {
        candidates: [],
        skips: [{ ...source, reason: "no `start` or `dev` script" }],
      };
    }
    const language = runtimeOf(command);
    return {
      candidates: [
        {
          kind: "service",
          dir,
          command,
          ...(language ? { language } : {}),
          confidence: language ? "high" : "low",
          sources: [source],
        },
      ],
      skips: [],
    };
  },
});
