"use client"

import React, { PropsWithChildren, useEffect } from 'react'
import { createConfig, http, WagmiProvider } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  initiaPrivyWalletConnector,
  injectStyles,
  InterwovenKitProvider,
} from '@initia/interwovenkit-react'
import interwovenKitStyles from '@initia/interwovenkit-react/styles.js'
import { UserProvider } from '@/lib/user-context'

const wagmiConfig = createConfig({
  connectors: [initiaPrivyWalletConnector],
  chains: [mainnet],
  transports: { [mainnet.id]: http() },
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
})

// Use "initiation-2" for testnet, "interwoven-1" for mainnet
export const CHAIN_ID = process.env.NEXT_PUBLIC_CHAIN_ID ?? 'initiation-2'

export default function Providers({ children }: PropsWithChildren) {
  useEffect(() => {
    injectStyles(interwovenKitStyles)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <InterwovenKitProvider defaultChainId={CHAIN_ID}>
          <UserProvider>
            {children}
          </UserProvider>
        </InterwovenKitProvider>
      </WagmiProvider>
    </QueryClientProvider>
  )
}