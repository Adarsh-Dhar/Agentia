"use client"

import React, { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useInterwovenKit } from '@initia/interwovenkit-react'
import { Sidebar } from '@/components/sidebar'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { address, initiaAddress } = useInterwovenKit()
  const router = useRouter()
  const connected = !!(address || initiaAddress)

  // Redirect to landing if wallet disconnected
  useEffect(() => {
    if (!connected) {
      // Small delay so InterwovenKit can hydrate before we redirect
      const t = setTimeout(() => {
        if (!address && !initiaAddress) router.push('/')
      }, 800)
      return () => clearTimeout(t)
    }
  }, [connected, address, initiaAddress, router])

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto md:ml-64">
        {children}
      </main>
    </div>
  )
}