import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Account, actions, baseEncode, teraToGas } from "near-api-js";
import { z } from "zod";
import { settleOutcome } from "../near/tx";

const entrySchema = z.object({ nonce: z.number().int().nonnegative(), method: z.string(), hash: z.string() });
const journalSchema = z.object({ signer: z.string(), controller: z.string(), entries: z.array(entrySchema) });

/** A nonce is never re-signed after an uncertain submission, including across restarts. */
export class HedgeSubmissions {
  constructor(private readonly path: string, private readonly signer: Account, private readonly controller: string) {}

  private load() {
    const journal = existsSync(this.path) ? journalSchema.parse(JSON.parse(readFileSync(this.path, "utf8")))
      : { signer: this.signer.accountId, controller: this.controller, entries: [] };
    if (journal.signer !== this.signer.accountId || journal.controller !== this.controller) throw new Error("Hedge journal identity mismatch");
    return journal;
  }

  locator(nonce: number): string | null {
    return this.load().entries.findLast((entry) => entry.nonce === nonce)?.hash ?? null;
  }

  async send(method: string, args: Record<string, unknown>, gas: number) {
    const nonce = z.number().int().nonnegative().parse(args.nonce);
    const journal = this.load();
    const previous = journal.entries.find((entry) => entry.nonce === nonce && entry.method === method);
    let hash = previous?.hash;
    if (!hash) {
      const other = journal.entries.find((entry) => entry.nonce === nonce);
      if (other && method !== "recover_hedge") throw new Error("Hedge nonce already submitted; reconcile original transaction");
      const signed = await this.signer.createSignedTransaction({ receiverId: this.controller,
        actions: [actions.functionCall(method, args, teraToGas(gas), 0n)] });
      hash = baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());
      journal.entries.push({ nonce, method, hash });
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(journal), { mode: 0o600, flush: true });
      renameSync(`${this.path}.tmp`, this.path);
      const directory = openSync(dirname(this.path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      // An exception leaves the original locator durable. Never construct a replacement.
      await this.signer.provider.sendTransactionUntil(signed, "INCLUDED");
    }
    const outcome = await this.signer.provider.viewTransactionStatusWithReceipts({
      txHash: hash, accountId: this.signer.accountId, waitUntil: "FINAL",
    });
    return { tx: hash, value: settleOutcome(outcome).value };
  }
}
