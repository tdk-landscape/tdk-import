import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import "./detectors/index.js";
import { type MergedService, mergeCandidates } from "./merge.js";
import { selectDetectors } from "./registry.js";
import type { Candidate, Skip } from "./types.js";

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

/** Read the one supported input, root docker-compose.yml. This function writes nothing. */
export function buildPlan(dir: string): ImportPlan {
  const root = resolve(dir);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
  const composePath = "docker-compose.yml";
  const detectors = selectDetectors(["compose"]);
  const candidates: Candidate[] = [];
  const skips: Skip[] = [];

  if (!statSync(resolve(root, composePath), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `No root docker-compose.yml found in ${root}; tdk import currently reads that file only`,
    );
  }
  for (const detector of detectors) {
    if (!detector.claim(composePath)) continue;
    try {
      const result = detector.parse(resolve(root, composePath), composePath);
      candidates.push(...result.candidates);
      skips.push(...result.skips);
    } catch (err) {
      skips.push({
        file: composePath,
        detector: detector.id,
        reason: `could not be read: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const merged = mergeCandidates(candidates, basename(root));
  const services = merged.services;
  return {
    root,
    services,
    skips: [...skips, ...merged.skips],
    unsupported: [],
    skippedProcfileProcesses: 0,
    notes: [],
    files: [composePath],
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
