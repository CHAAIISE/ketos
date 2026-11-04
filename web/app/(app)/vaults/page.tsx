import type { Metadata } from "next";
import { VaultList } from "@/components/vault/vault-list";

export const metadata: Metadata = { title: "Vaults" };

export default function VaultsPage() {
  return <VaultList />;
}
