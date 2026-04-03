/// MockBridge - interwoven_bridge module
/// 
/// This module simulates an IBC/L1 bridge for local testing purposes.
/// It accepts a sweep call with a coin type and amount, logs a simulated
/// success, and returns without touching real chain state.
///
/// Deploy this to Initia testnet so your Yield Sweeper bot can test
/// its full execution path without needing real IBC proofs.

module deployer::interwoven_bridge {

    // ----------------------------------------------------------------
    // Events (optional - uncomment if you want on-chain sweep receipts)
    // ----------------------------------------------------------------
    // struct SweepEvent has drop, store {
    //     sender: address,
    //     amount: u64,
    // }

    /// Mock bridge entry point.
    ///
    /// Accepts the amount to sweep.
    ///
    /// CoinType is retained to keep module upgrades backward compatible
    /// with the first published version.
    ///
    /// On a real bridge this would:
    ///   1. Lock `amount` of CoinType in an escrow account
    ///   2. Emit an IBC packet toward the destination chain ID
    ///   3. Wait for a relayer to pick up the packet and deliver it
    ///
    /// Here it does nothing - that's the point.
    public entry fun sweep_to_l1<CoinType>(_amount: u64) {
        // Intentionally empty.
        // A successful no-op transaction proves:
        //   - Your bot constructed the payload correctly
        //   - Gas estimation works
        //   - The contract address / function path resolves
        //   - End-to-end signing & broadcast succeeds
        //
        // Replace this body with real IBC logic when you go to mainnet.
    }
}
