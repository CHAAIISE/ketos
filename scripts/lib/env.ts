import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnv = fileURLToPath(new URL("../../.env.local", import.meta.url));

let loaded = false;

/** Loads the repo-root `.env.local` once; variables already set in the shell win. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}

/** Returns a non-empty environment variable or exits with a message naming it (never its value). */
export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}: set it in .env.local (see .env.example).`);
    process.exit(1);
  }
  return value;
}

/** Returns an optional environment variable; empty strings count as absent. */
export function optionalEnv(name: string): string | undefined {
  loadEnv();
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
