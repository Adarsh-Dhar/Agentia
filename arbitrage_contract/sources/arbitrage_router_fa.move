module deployer::arbitrage_router_fa {
    use std::signer;
    use initia_std::dex;
    use initia_std::fungible_asset;
    use initia_std::object;
    use initia_std::primary_fungible_store;

    /// Abort if input amount is zero.
    const E_ZERO_AMOUNT: u64 = 1;
    /// Abort if pool address is invalid.
    const E_INVALID_POOL: u64 = 2;
    /// Abort if execution is not net-profitable in USDC terms.
    const E_NOT_PROFITABLE: u64 = 3;

    /// FA-native execution entrypoint.
    public entry fun execute_cross_chain_trade(
        account: &signer,
        pool_a: address,
        pool_b: address,
        amount_in: u64,
        usdc_metadata_address: address,
    ) {
        assert!(amount_in > 0, E_ZERO_AMOUNT);
        assert!(pool_a != @0x0, E_INVALID_POOL);
        assert!(pool_b != @0x0, E_INVALID_POOL);

        let account_addr = signer::address_of(account);
        let starting_balance = primary_fungible_store::balance(
            account_addr,
            object::address_to_object<fungible_asset::Metadata>(usdc_metadata_address),
        );

        let input_coin = primary_fungible_store::withdraw(
            account,
            object::address_to_object<fungible_asset::Metadata>(usdc_metadata_address),
            amount_in,
        );
        let pool_a_obj = object::address_to_object<dex::Config>(pool_a);
        let pool_b_obj = object::address_to_object<dex::Config>(pool_b);
        let mid_coin = dex::swap(pool_a_obj, input_coin);
        let output_coin = dex::swap(pool_b_obj, mid_coin);
        primary_fungible_store::deposit(account_addr, output_coin);

        let ending_balance = primary_fungible_store::balance(
            account_addr,
            object::address_to_object<fungible_asset::Metadata>(usdc_metadata_address),
        );
        assert!(ending_balance > starting_balance, E_NOT_PROFITABLE);
    }
}
