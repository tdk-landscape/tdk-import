import { ImportError } from "./errors.js";
import type { Detector } from "./types.js";

const detectors: Detector[] = [];

/** Detectors register themselves from `detectors/index.ts`; the order is the merge precedence. */
export function registerDetector(detector: Detector): void {
  if (detectors.some((d) => d.id === detector.id)) {
    throw new Error(`Import detector "${detector.id}" is already registered`);
  }
  detectors.push(detector);
}

export function listDetectors(): readonly Detector[] {
  return detectors;
}

export function detectorIds(): string[] {
  return detectors.map((d) => d.id);
}

/** Resolves `--only`. An unknown id fails here, before any file is read. */
export function selectDetectors(only?: string[]): Detector[] {
  if (!only || only.length === 0) return [...detectors];
  const unknown = only.filter((id) => !detectors.some((d) => d.id === id));
  if (unknown.length > 0) {
    throw new ImportError(`Unknown import detector: ${unknown.join(", ")}`, [
      `Registered detectors: ${detectorIds().join(", ")}`,
    ]);
  }
  return detectors.filter((d) => only.includes(d.id));
}

/** Lower number wins a field. Unregistered ids rank last. */
export function precedence(detectorId: string): number {
  const index = detectors.findIndex((d) => d.id === detectorId);
  return index === -1 ? detectors.length : index;
}
