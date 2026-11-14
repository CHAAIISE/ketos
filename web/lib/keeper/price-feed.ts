import { workerSignedObservations } from "../near/signed-prices-server";
import { signedPriceAssets, verifySignedObservations, verifySignedPrices, type SignedPriceLoader, type SignedPrices } from "../near/signed-prices";

type Observations = NonNullable<ReturnType<typeof verifySignedObservations>>;
const REQUEST_INTERVAL_MS = 10_000;
const MAX_PENDING = 5;
const MAX_SETS = 32;

/** Acquisition never owns the transaction signer or delays a risk cycle. */
export class KeeperPriceFeed {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly started = new Map<string, number>();
  private completed: Observations[] = [];
  private stopped = false;
  private updateRevision = 0;
  private readonly waiters = new Set<() => void>();

  get revision(): number { return this.updateRevision; }

  /** Remember arrivals during a running cycle as well as during its idle wait. */
  waitForUpdate(revision: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (this.stopped || signal.aborted || revision !== this.updateRevision) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(finish);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  constructor(private readonly load: SignedPriceLoader = async (assets, signer) =>
    (await workerSignedObservations(assets, signer))?.signedPrices ?? null) {}

  request(input: string[], signer: string): void {
    const assets = signedPriceAssets(input);
    if (this.stopped || !assets || this.pending.size >= MAX_PENDING) return;
    const now = Date.now();
    for (const [key, at] of this.started) {
      if (now - at >= 60_000) this.started.delete(key);
    }
    const key = JSON.stringify([signer, assets]);
    if (this.pending.has(key)) return;
    const previous = this.started.get(key);
    if (previous !== undefined && now - previous < REQUEST_INTERVAL_MS) return;
    if (!this.started.has(key) && this.started.size >= MAX_SETS) return;
    this.started.set(key, now);
    const operation = Promise.resolve().then(() => this.load(assets, signer)).then((value) => {
      const observations = verifySignedObservations(value, signer, assets);
      if (this.stopped || !observations) return;
      this.completed = this.completed.filter((entry) =>
        verifySignedObservations(entry.signedPrices, entry.signedPrices.public_key, entry.assets));
      this.completed.push(observations);
      if (this.completed.length > MAX_SETS) this.completed.shift();
      this.updateRevision++;
      for (const finish of this.waiters) finish();
    }).catch(() => {
      // Acquisition failure leaves no usable quote; callers report unavailability.
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
  }

  /** Select each asset's newest valid source timestamp, not its response arrival time. */
  available(input: string[], signer: string): Observations[] {
    const assets = signedPriceAssets(input);
    if (!assets) return [];
    const selected = new Map<string, { signedPrices: SignedPrices; timestamp: number }>();
    for (const entry of this.completed) {
      const observations = verifySignedObservations(entry.signedPrices, signer,
        assets.filter((asset) => entry.assets.includes(asset)));
      if (!observations) continue;
      const { prices } = JSON.parse(observations.signedPrices.payload) as { prices: Record<string, { publish_time: number }> };
      for (const asset of observations.assets) {
        const timestamp = prices[asset].publish_time;
        if (!selected.has(asset) || timestamp > selected.get(asset)!.timestamp) {
          selected.set(asset, { signedPrices: observations.signedPrices, timestamp });
        }
      }
    }
    const groups = new Map<SignedPrices, string[]>();
    for (const [asset, { signedPrices }] of selected) {
      const group = groups.get(signedPrices);
      if (group) group.push(asset);
      else groups.set(signedPrices, [asset]);
    }
    return [...groups].map(([signedPrices, available]) => ({ signedPrices, assets: available }));
  }

  /** An action still needs a single authentic envelope covering its entire asset set. */
  get(input: string[], signer: string): SignedPrices | null {
    const assets = signedPriceAssets(input);
    if (!assets) return null;
    let best: SignedPrices | null = null;
    let bestTimestamp = -1;
    for (const entry of this.completed) {
      if (!assets.every((asset) => entry.assets.includes(asset))) continue;
      const value = verifySignedPrices(entry.signedPrices, signer, assets);
      if (!value) continue;
      const { prices } = JSON.parse(value.payload) as { prices: Record<string, { publish_time: number }> };
      const timestamp = Math.min(...assets.map((asset) => prices[asset].publish_time));
      if (timestamp > bestTimestamp) {
        best = value;
        bestTimestamp = timestamp;
      }
    }
    return best;
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const finish of this.waiters) finish();
    await Promise.all(this.pending.values());
  }
}
