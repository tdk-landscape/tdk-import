const NODE_PROGRAMS = new Set(["node", "npm", "npx", "yarn", "pnpm"]);

/** The program a shell command starts, after any `KEY=value` prefixes. */
function programOf(command: string): string | undefined {
  return command
    .trim()
    .split(/\s+/)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
}

/**
 * A Dockerfile for a Procfile process, only when the command names a runtime we can build
 * for (Node or Bun). Anything else returns undefined: the base image would be a guess.
 */
export function scaffoldDockerfile(command: string): string | undefined {
  const program = programOf(command);
  if (!program) return undefined;
  const node = NODE_PROGRAMS.has(program);
  if (!node && program !== "bun") return undefined;
  const install = node
    ? "RUN if [ -f package.json ]; then npm install --omit=dev; fi"
    : "RUN if [ -f package.json ]; then bun install --production; fi";
  return [
    "# Scaffolded by tdk-import from a Procfile command. Edit freely.",
    `FROM ${node ? "node:22-alpine" : "oven/bun:1-alpine"}`,
    "WORKDIR /app",
    "COPY . .",
    install,
    `CMD ["sh", "-c", ${JSON.stringify(command)}]`,
    "",
  ].join("\n");
}
