import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import "./detectors/index.js";
import { type MergedService, mergeCandidates } from "./merge.js";
import { selectDetectors } from "./registry.js";
import { isNodeCommand } from "./scaffold.js";
import { scanTree } from "./scan.js";
import type { Candidate, Skip } from "./types.js";
import { findUnsupported } from "./unsupported.js";

export interface ImportPlan {
  root: string;
  services: MergedService[];
  skips: Skip[];
  /** Formats found but not imported (Helm, Kustomize), by name. */
  unsupported: string[];
  /** Valid Procfile processes skipped because no supported command, Dockerfile, or image exists. */
  skippedProcfileProcesses: number;
  notes: string[];
  files: string[];
}

/** Scan, detect, merge. Reads files, writes nothing. An unknown `--only` id throws before the walk. */
export function buildPlan(dir: string, only?: string[]): ImportPlan {
  const root = resolve(dir);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  const detectors = selectDetectors(only);
  const scan = scanTree(root);
  const candidates: Candidate[] = [];
  const skips: Skip[] = [];

  for (const file of scan.files) {
    for (const detector of detectors) {
      if (!detector.claim(file)) continue;
      try {
        const result = detector.parse(resolve(root, file), file);
        candidates.push(...result.candidates);
        skips.push(...result.skips);
      } catch (err) {
        skips.push({
          file,
          detector: detector.id,
          reason: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  const unsupported = findUnsupported(scan.files);
  const merged = mergeCandidates(candidates, basename(root));
  const services = [];
  let skippedProcfileProcesses = 0;
  for (const service of merged.services) {
    const unsupportedCommands = service.procfileCommands.filter(
      (command) => !isNodeCommand(command),
    );
    if (unsupportedCommands.length > 0 && !service.image && !service.dockerfile) {
      skippedProcfileProcesses += 1;
      const source = service.sources.find((candidate) => candidate.detector === "procfile");
      skips.push({
        file: source?.file ?? "Procfile",
        detector: "procfile",
        reason: `process "${service.name}" skipped: command "${unsupportedCommands[0]}" is not a supported Node command and no Dockerfile or image is associated; add a Dockerfile or image`,
      });
      continue;
    }
    services.push(service);
  }
  return {
    root,
    services,
    skips: [...skips, ...merged.skips, ...unsupported.skips],
    unsupported: unsupported.labels,
    skippedProcfileProcesses,
    notes: scan.notes,
    files: scan.files,
  };
}

/** Ports already claimed by service.json files under `dir` (best effort). */
export function usedManifestPorts(dir: string): Map<string, number> {
  const ports = new Map<string, number>();
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }).map(String);
  } catch {
    return ports;
  }
  for (const entry of entries) {
    if (!entry.endsWith("service.json") || entry.split(/[\\/]/).includes("node_modules")) continue;
    const abs = resolve(dir, entry);
    try {
      const port = JSON.parse(readFileSync(abs, "utf8")).port;
      if (typeof port === "number") ports.set(abs, port);
    } catch {
      // unreadable or not JSON: it claims no port
    }
  }
  return ports;
}
