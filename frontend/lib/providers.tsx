"use client"

import React, { PropsWithChildren, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  injectStyles,
  InterwovenKitProvider,
  TESTNET
} from '@initia/interwovenkit-react'
import interwovenKitStyles from '@initia/interwovenkit-react/styles.js'
import { UserProvider } from '@/lib/user-context'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
})


export default function Providers({ children }: PropsWithChildren) {
  useEffect(() => {
    injectStyles(interwovenKitStyles)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <InterwovenKitProvider
        {...TESTNET}
        enableAutoSign={{
          [TESTNET.defaultChainId]: [
            "/initia.move.v1.MsgExecute",
          ],
        }}
      >
        <UserProvider>
          {children}
        </UserProvider>
      </InterwovenKitProvider>
    </QueryClientProvider>
  )
}