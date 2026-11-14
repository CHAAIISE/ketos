import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { VaultView } from "@/components/vault/vault-view";
import { VAULT_IDS, vaultIdSchema } from "@/lib/near/types";
import { formatVaultName } from "@/lib/near/format";
import { Skeleton } from "@/components/app/states";

export function generateStaticParams() {
  return VAULT_IDS.map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: PageProps<"/vaults/[id]">): Promise<Metadata> {
  const { id } = await params;
  const vaultId = vaultIdSchema.safeParse(id);
  return { title: vaultId.success ? `${formatVaultName(vaultId.data)} Vault` : "Vault not found" };
}

async function VaultContent({ params }: Pick<PageProps<"/vaults/[id]">, "params">) {
  const result = vaultIdSchema.safeParse((await params).id);
  if (!result.success) notFound();
  return <VaultView key={result.data} vaultId={result.data} />;
}

export default function VaultPage({ params }: PageProps<"/vaults/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <VaultContent params={params} />
    </Suspense>
  );
}
