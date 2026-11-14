#!/usr/bin/env bash
set -euo pipefail
# install|uninstall [--dry-run]; override KEEPER_LAUNCHD_DIR for a disposable plist directory.
# ensure-secret [env-file] only ensures CRON_SECRET; the default is the root .env.local.
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
export KETOS_KEEPER_PROJECT_ROOT="$PROJECT_ROOT"
exec node - "$@" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { parseEnv } = require("node:util");

const root = process.env.KETOS_KEEPER_PROJECT_ROOT;
const label = "com.ketos.keeper";
const script = path.join(root, "scripts", "keeper-launchd.sh");
const [command, argument, ...extra] = process.argv.slice(2);
const dryRun = argument === "--dry-run";

function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function ensureSecret(file) {
  let content = "";
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("The environment path must be a regular file.");
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (parseEnv(content).CRON_SECRET?.trim()) return;
  const assignment = `CRON_SECRET=${crypto.randomBytes(32).toString("hex")}`;
  let replaced = false;
  // Quoted dotenv values can span lines, including whitespace-only secrets.
  const updated = content.replace(
    /^[ \t]*(?:export[ \t]+)?CRON_SECRET[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\r\n]*)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/gm,
    (existing) => {
      if (replaced) return "";
      replaced = true;
      const newline = existing.endsWith("\r\n") ? "\r\n" : existing.endsWith("\n") ? "\n" : "";
      return assignment + newline;
    },
  );
  atomicWrite(file, replaced ? updated : `${content}${content.endsWith("\n") || !content ? "" : "\n"}${assignment}\n`);
}

function executable(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`Cannot find ${name} on PATH.`);
}

function xml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function launchctl(args, allowFailure = false) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`launchctl ${args[0]} failed; check your GUI login session and launchd permissions.`);
  }
  return !result.error && result.status === 0;
}

function main() {
  if (extra.length || !["install", "uninstall", "ensure-secret", "run"].includes(command)
    || (["install", "uninstall"].includes(command) && argument && !dryRun)) {
    throw new Error("Usage: bash scripts/keeper-launchd.sh install|uninstall [--dry-run] | ensure-secret [env-file]");
  }
  if (command === "ensure-secret") {
    ensureSecret(argument ? path.resolve(argument) : path.join(root, ".env.local"));
    console.log("CRON_SECRET is configured; its value was not printed.");
    return;
  }
  if (command === "run") {
    // launchd owns the persistent runner and restarts it after an unexpected exit.
    const result = spawnSync(argument || executable("pnpm"), ["keeper"], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.error) throw new Error("Could not start pnpm keeper.");
    process.exitCode = result.status ?? 1;
    return;
  }
  if (process.platform !== "darwin" && !dryRun) {
    throw new Error("launchd installation requires macOS; use --dry-run to generate the plist elsewhere.");
  }
  const directory = process.env.KEEPER_LAUNCHD_DIR
    ? path.resolve(process.env.KEEPER_LAUNCHD_DIR)
    : path.join(process.env.HOME || (() => { throw new Error("HOME is not set."); })(), "Library", "LaunchAgents");
  const plist = path.join(directory, `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${label}`;
  if (fs.existsSync(plist)) {
    if (!fs.lstatSync(plist).isFile()
      || !fs.readFileSync(plist, "utf8").includes(`<key>Label</key>\n  <string>${label}</string>`)) {
      throw new Error("Refusing to replace or remove an unrecognized launchd plist.");
    }
  }
  if (command === "uninstall") {
    if (!dryRun && launchctl(["print", service], true)) launchctl(["bootout", service]);
    fs.rmSync(plist, { force: true });
    console.log(dryRun ? "Keeper plist removed without contacting launchctl." : "Keeper launch agent uninstalled.");
    return;
  }

  const pnpm = executable("pnpm");
  const searchPath = [...new Set([
    path.dirname(process.execPath), path.dirname(pnpm),
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ])].join(path.delimiter);
  const logs = path.join(root, "out", "keeper");
  ensureSecret(path.join(root, ".env.local"));
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const strings = (values) => values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${strings(["/bin/bash", script, "run", pnpm])}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(searchPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logs, "stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logs, "stderr.log"))}</string>
</dict>
</plist>
`;
  atomicWrite(plist, content);
  if (!dryRun) {
    if (launchctl(["print", service], true)) launchctl(["bootout", service]);
    launchctl(["bootstrap", domain, plist]);
  }
  console.log(dryRun ? `Keeper plist generated at ${plist}; launchctl was not called.` : "Keeper launch agent installed (continuous risk/depth cycles while this Mac is awake and logged in).");
}

try {
  main();
} catch (error) {
  // Never print child output or environment file contents in installation errors.
  console.error(error instanceof Error && ["ENOENT", "EACCES", "EPERM"].includes(error.code)
    ? `Keeper setup failed (${error.code}); check file and executable permissions.`
    : error instanceof Error ? error.message : "Keeper setup failed.");
  process.exitCode = 1;
}
NODE
