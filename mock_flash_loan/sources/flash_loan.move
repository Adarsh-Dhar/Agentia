/// Mock Flash Loan Module - initiation-2 testnet
///
/// Purpose:
///   Provides `borrow` and `repay` entry functions whose signatures exactly
///   match what a TypeScript bot sends via batched `calls`. Neither function
///   moves real funds; they simply emit events so you can verify on-chain that
///   your bot's full transaction pipeline (borrow -> swap -> swap -> repay) is
///   correctly formatted and executed in a single atomic transaction.
///
/// Deploy with:
///   initiad tx move publish . \
///       --named-addresses deployer=<YOUR_WALLET_ADDRESS> \
///       --from test-account \
///       --gas auto \
///       --gas-adjustment 1.5 \
///       --gas-prices 0.015uinit \
///       --node https://rpc.testnet.initia.xyz:443 \
///       --chain-id initiation-2

module deployer::flash_loan {
    use std::signer;
    use std::event;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// Emitted every time borrow() is called.
    #[event]
    struct BorrowEvent has drop, store {
        borrower: address,
        amount: u64,
    }

    /// Emitted every time repay() is called.
    #[event]
    struct RepayEvent has drop, store {
        borrower: address,
        amount: u64,
        fee: u64,
    }

    // -------------------------------------------------------------------------
    // Public entry functions
    // -------------------------------------------------------------------------

    /// Mock borrow.
    ///
    /// Accepts the generic <CoinType> and the amount your bot sends.
    /// Does NOT move any funds - just records a BorrowEvent so you can
    /// confirm the call landed on-chain.
    ///
    /// Parameters
    ///   account  - the signer (your bot's wallet)
    ///   amount   - the loan amount in the token's smallest unit (e.g. uinit)
    public entry fun borrow<CoinType>(
        account: &signer,
        amount: u64
    ) {
        let addr = signer::address_of(account);
        event::emit(BorrowEvent {
            borrower: addr,
            amount,
        });
        // No real fund movement - mock only.
    }

    /// Mock repay.
    ///
    /// Accepts the <CoinType>, the principal amount, and the fee.
    /// Does NOT move any funds - just records a RepayEvent.
    ///
    /// Parameters
    ///   account  - the signer (your bot's wallet)
    ///   amount   - principal being "repaid"
    ///   fee      - flash-loan fee (mocked as 0 in your bot's call)
    public entry fun repay<CoinType>(
        account: &signer,
        amount: u64,
        fee: u64
    ) {
        let addr = signer::address_of(account);
        event::emit(RepayEvent {
            borrower: addr,
            amount,
            fee,
        });
        // No real fund movement - mock only.
    }
}
