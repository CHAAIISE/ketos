// Stops the local sandbox started by sandbox-up.mjs and removes its data and web/.env.e2e.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const STATE_DIR = join(tmpdir(), "ketos-sandbox");
export const STATE_FILE = join(STATE_DIR, "state.json");
export const LOG_FILE = join(STATE_DIR, "node.log");
const ENV_FILE = fileURLToPath(new URL("../web/.env.e2e", import.meta.url));

/** @returns {{ pid: number, nodePid: number | null, rpcUrl: string, homeDir: string } | null} */
export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pids, ms) {
  const deadline = Date.now() + ms;
  while (pids.some(alive) && Date.now() < deadline) await sleep(100);
  return !pids.some(alive);
}

/** Stops the node if one is recorded; a graceful SIGTERM first, SIGKILL if it hangs. */
export async function stopSandbox() {
  const state = readState();
  if (state) {
    const pids = [state.pid, state.nodePid].filter(Boolean);
    if (alive(state.pid)) process.kill(state.pid, "SIGTERM");
    if (!(await waitForExit(pids, 15_000))) {
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
      await waitForExit(pids, 5_000);
    }
    if (state.homeDir) rmSync(state.homeDir, { recursive: true, force: true });
    rmSync(STATE_FILE, { force: true });
  }
  rmSync(ENV_FILE, { force: true });
  return state !== null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stopped = await stopSandbox();
  console.log(stopped ? "sandbox stopped" : "no sandbox running");
  if (existsSync(STATE_FILE)) process.exit(1);
}
