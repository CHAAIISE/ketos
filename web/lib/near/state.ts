export type RawState = {
  values: { key: string; value: string }[];
  block_hash: string;
  block_height: number;
};
export type RawStatePage = RawState & { last_key?: string | null };

/** A complete, single-block snapshot; never silently accept an interrupted or overlapping page. */
export async function readContractState(
  query: (params: Record<string, unknown>) => Promise<RawStatePage | null>,
  accountId: string,
  reference: Record<string, unknown>,
): Promise<RawState | null> {
  if (typeof reference.block_id !== "string" && reference.finality !== "final") {
    throw new Error("State export requires a pinned block or final finality");
  }
  const values: RawState["values"] = [];
  const keys = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pinnedHash = typeof reference.block_id === "string" ? reference.block_id : undefined;
  let height: number | undefined;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const page = await query({ request_type: "view_state", account_id: accountId,
      prefix_base64: "", include_proof: false, limit: 100,
      ...(pinnedHash ? { block_id: pinnedHash } : { finality: "final" }),
      ...(cursor ? { after_key_base64: cursor } : {}),
    });
    if (!page) {
      if (pageNumber === 0) return null;
      throw new Error("State export disappeared between pages");
    }
    if (!page.block_hash || !Number.isSafeInteger(page.block_height) || !Array.isArray(page.values)) {
      throw new Error("Malformed state page");
    }
    if ((pinnedHash && page.block_hash !== pinnedHash) || (height !== undefined && height !== page.block_height)) {
      throw new Error("State pagination changed block");
    }
    pinnedHash = page.block_hash;
    height = page.block_height;
    for (const row of page.values) {
      if (typeof row.key !== "string" || typeof row.value !== "string" || keys.has(row.key)) {
        throw new Error("Malformed or duplicate state key");
      }
      keys.add(row.key);
      values.push(row);
    }
    if (page.last_key == null) return { block_hash: pinnedHash, block_height: height, values };
    if (typeof page.last_key !== "string" || !page.last_key || cursors.has(page.last_key)
      || page.values.at(-1)?.key !== page.last_key) {
      throw new Error("Invalid state continuation cursor");
    }
    cursors.add(page.last_key);
    cursor = page.last_key;
  }
  throw new Error("State export exceeded its page bound");
}
