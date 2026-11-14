import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replayHedge, REPLAY_ANCHOR, REPLAY_ASSUMPTIONS, REPLAY_SCENARIOS } from "../web/lib/hedge/replay.ts";
const directory = fileURLToPath(new URL("../out/deployments/", import.meta.url));
const result = { kind: "synthetic-counterfactual-not-live-fills", anchor: REPLAY_ANCHOR,
  assumptions: REPLAY_ASSUMPTIONS, scenarios: REPLAY_SCENARIOS.map(replayHedge) };
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/hedge-replay.json`, `${JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`);
console.log("Wrote out/deployments/hedge-replay.json: synthetic replay, not live execution evidence.");
