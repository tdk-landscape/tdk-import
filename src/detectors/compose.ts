import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path/posix";
import { isAlias, isMap, type Node, parseDocument, visit } from "yaml";
import { registerDetector } from "../registry.js";
import type { Candidate, Skip } from "../types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Container-side port of one `ports:` entry, in short or long syntax. */
function containerPort(entry: unknown): number | undefined {
  if (typeof entry === "number") return entry;
  if (isObj(entry)) return typeof entry.target === "number" ? entry.target : undefined;
  if (typeof entry !== "string") return undefined;
  const last = entry.split("/")[0]?.split(":").pop() ?? "";
  const first = last.split("-")[0] ?? "";
  return /^\d+$/.test(first) ? Number.parseInt(first, 10) : undefined;
}

const NON_HTTP_PORTS = new Set([3306, 5432, 6379, 27017, 5672, 9092, 9200, 11211]);

function envNames(environment: unknown): string[] {
  if (Array.isArray(environment)) {
    return environment
      .filter((e) => typeof e === "string")
      .map((e) => (e as string).split("=")[0] as string);
  }
  return isObj(environment) ? Object.keys(environment) : [];
}

function commandOf(command: unknown): string | undefined {
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string"))
    return command.join(" ");
  return undefined;
}

function healthPathOf(healthcheck: unknown): string | undefined {
  if (!isObj(healthcheck) || !Array.isArray(healthcheck.test)) return undefined;
  const test = healthcheck.test
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  const match = test.match(/https?:\/\/[^\s"']+(\/[^\s"']*)?/i);
  if (!match) return undefined;
  try {
    return new URL(match[0]).pathname || "/";
  } catch {
    return undefined;
  }
}

registerDetector({
  id: "compose",
  claim: (relPath) => relPath === "docker-compose.yml",
  parse(absPath, relPath) {
    const composeDir = dirname(relPath) === "." ? "" : dirname(relPath);
    const base = { file: relPath, detector: "compose" };
    const skips: Skip[] = [];
    const candidates: Candidate[] = [];

    const doc = parseDocument(readFileSync(absPath, "utf8"), { merge: true });
    if (doc.errors.length > 0) {
      return {
        candidates,
        skips: [{ ...base, reason: `invalid YAML: ${doc.errors[0]?.message}` }],
      };
    }
    let usesAnchors = false;
    visit(doc, {
      Alias() {
        usesAnchors = true;
      },
      Node(_key, node: Node) {
        if ((node as { anchor?: string }).anchor || isAlias(node)) usesAnchors = true;
      },
    });
    if (usesAnchors) {
      skips.push({
        ...base,
        reason: "uses YAML anchors/aliases; values were read after resolution",
      });
    }
    const root = doc.toJS() as unknown;
    const services = isObj(root) && isObj(root.services) ? root.services : null;
    if (!services || !isMap(doc.get("services", true))) {
      return { candidates, skips: [...skips, { ...base, reason: "no `services:` map" }] };
    }

    for (const [name, raw] of Object.entries(services)) {
      if (!isObj(raw)) {
        skips.push({ ...base, reason: `service "${name}" is not a map` });
        continue;
      }
      if (raw.extends !== undefined) {
        skips.push({
          ...base,
          reason: `service "${name}" uses \`extends\`; values are not resolved`,
        });
        continue;
      }
      if (raw.profiles !== undefined) {
        skips.push({
          ...base,
          reason: `service "${name}" has profiles ${JSON.stringify(raw.profiles)}; profiles are not enforced by TDK`,
        });
        continue;
      }

      let dir = composeDir;
      let dockerfile: string | undefined;
      let standalone = true;
      if (raw.build !== undefined) {
        const build = isObj(raw.build) ? raw.build : { context: raw.build };
        const context = typeof build.context === "string" ? build.context : ".";
        const resolved = normalize(join(composeDir, context));
        if (isAbsolute(context) || context.includes("://") || resolved.startsWith("..")) {
          skips.push({
            ...base,
            reason: `service "${name}" build context "${context}" is outside the imported tree`,
          });
        } else {
          dir = resolved === "." ? "" : resolved;
          standalone = false;
          dockerfile = typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile";
        }
      }

      const ports = [
        ...new Set(
          (Array.isArray(raw.ports) ? raw.ports : [])
            .map(containerPort)
            .filter((p): p is number => p !== undefined),
        ),
      ];
      const httpPorts = ports.filter((port) => port <= 5999 && !NON_HTTP_PORTS.has(port));
      const selectedPort =
        httpPorts.length === 1 ? httpPorts[0] : ports.length === 1 ? ports[0] : undefined;
      if (ports.length > 1 && selectedPort === undefined) {
        skips.push({
          ...base,
          reason: `service "${name}" lists several ports (${ports.join(", ")}); no single HTTP container port could be identified`,
        });
      } else if (ports.length > 1) {
        skips.push({
          ...base,
          reason: `service "${name}" publishes extra container ports (${ports.filter((port) => port !== selectedPort).join(", ")}); TDK routes only ${selectedPort}`,
        });
      }
      const dependsOn = Array.isArray(raw.depends_on)
        ? raw.depends_on.filter((d): d is string => typeof d === "string")
        : isObj(raw.depends_on)
          ? Object.keys(raw.depends_on)
          : [];
      const command = commandOf(raw.command);
      const envKeys = envNames(raw.environment);
      const healthCheckPath = healthPathOf(raw.healthcheck);
      const exposeViaProxy =
        selectedPort !== undefined && !NON_HTTP_PORTS.has(selectedPort) && selectedPort <= 5999;

      candidates.push({
        kind: "service",
        name,
        dir,
        standalone,
        ...(typeof raw.image === "string" ? { image: raw.image } : {}),
        ...(dockerfile ? { dockerfile } : {}),
        ...(command ? { command } : {}),
        ...(selectedPort !== undefined ? { port: selectedPort } : {}),
        ...(healthCheckPath ? { healthCheckPath } : {}),
        exposeViaProxy,
        ...(envKeys.length ? { envKeys } : {}),
        ...(dependsOn.length ? { dependsOn } : {}),
        confidence: "high",
        sources: [base],
      });
    }
    return { candidates, skips };
  },
});
