"use client";

import { isEthereumWallet } from "@dynamic-labs/ethereum";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { useCallback } from "react";

/** The message signer handed to `signInWithEthereum`, built from Dynamic's wallet
 *  client rather than wagmi's `useSignMessage`.
 *
 *  This is not interchangeable with the wagmi hook. `runSignIn` switches chains
 *  and then signs immediately, and wagmi resolves a signer through
 *  `getConnectorClient`, whose connector cache only re-syncs on the connector's
 *  own `chainChanged` event — so it can still be mid-update and throw
 *  "Connector not connected" right after a Dynamic-initiated switch. Dynamic
 *  builds its client straight off the wallet's provider, so it already reflects
 *  the chain we just switched to.
 *
 *  (Borrowed from Superform's v2 app, which hit exactly this and documents it in
 *  src/shared/hooks/useSignMessageProvider.ts.) */
export function useDynamicSigner(): (args: { message: string }) => Promise<string> {
  const { primaryWallet } = useDynamicContext();

  return useCallback(
    async ({ message }: { message: string }) => {
      if (!primaryWallet) throw new Error("No wallet connected");
      if (!isEthereumWallet(primaryWallet)) {
        throw new Error("Connected wallet is not an Ethereum wallet");
      }

      const walletClient = await primaryWallet.getWalletClient();
      // Pass the account explicitly. With WalletConnect + Ledger the client can
      // carry several accounts and its default is not necessarily the one
      // Dynamic considers primary — signing with the wrong one produces a
      // signature the server recovers to an address the message doesn't claim,
      // which fails verification for no visible reason.
      return walletClient.signMessage({
        account: primaryWallet.address as `0x${string}`,
        message,
      });
    },
    [primaryWallet],
  );
}
