// Config from environment (invariant 7): no absolute paths baked in, no
// assumptions about a shared filesystem. Fail loudly and early on missing
// required config — a half-configured component is worse than a dead one.

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (v === undefined || v === "") {
    throw new Error(`missing required environment variable ${name} (see .env.example)`);
  }
  return v;
}

export function optionalEnv(
  name: string,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const v = env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function intEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`environment variable ${name} must be an integer, got "${v}"`);
  return n;
}
