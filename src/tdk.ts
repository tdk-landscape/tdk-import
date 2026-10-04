import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Manifest constants of the TDK service.json this tool writes. */
export const SERVICE_MANIFEST_SCHEMA_VERSION = 1;
export const SERVICE_MANIFEST_SCHEMA_URL = "https://tdk-landscape.github.io/schema.service.json";
/** TDK's bring-your-own port range. */
export const BYO_PORT_RANGE = { min: 4000, max: 5999, label: "4000-5999" } as const;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateName(
  label: "Resource name" | "Stack name",
  name: string,
): { valid: boolean; error?: string } {
  return KEBAB.test(name)
    ? { valid: true }
    : {
        valid: false,
        error: `${label} "${name}" must use lowercase letters, numbers, and hyphens only`,
      };
}

/** Nearest directory at or above `start` holding `.tdk/project.json`. */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".tdk", "project.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
