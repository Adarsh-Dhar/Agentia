module deployer::arbitrage_router {
    /// Abort if input amount is zero.
    const E_ZERO_AMOUNT: u64 = 1;
    /// Abort if pool address is invalid.
    const E_INVALID_POOL: u64 = 2;

    /// Router entrypoint expected by the bot runtime.
    ///
    /// This is currently a safe execution stub that validates payload shape.
    /// Wire real DEX swap legs and profit assertions here once pool integration
    /// details are finalized.
    public entry fun execute_cross_chain_trade(
        _account: &signer,
        pool_a: address,
        pool_b: address,
        amount_in: u64,
    ) {
        assert!(amount_in > 0, E_ZERO_AMOUNT);
        assert!(pool_a != @0x0, E_INVALID_POOL);
        assert!(pool_b != @0x0, E_INVALID_POOL);
    }
}
