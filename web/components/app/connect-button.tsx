"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldMessage } from "@/components/ui/input";
import { useWallet } from "@/hooks/near-provider";
import { toNearActionError } from "@/lib/near/errors";

/** Full-width wallet connect, standing in for a form's submit while signed out. */
export function ConnectButton() {
  const wallet = useWallet();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Button
        data-primary
        className="w-full"
        disabled={!wallet.isReady}
        onClick={async () => {
          setError(null);
          try {
            await wallet.signIn();
          } catch (e) {
            setError(toNearActionError(e).message);
          }
        }}
      >
        {wallet.isReady ? "Connect wallet" : "Loading wallet…"}
      </Button>
      {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
    </div>
  );
}
