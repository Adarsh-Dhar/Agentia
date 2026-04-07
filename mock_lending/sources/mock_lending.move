module deployer::mock_lending_v2 {
    use deployer::mock_oracle_v2;
    use initia_std::fungible_asset;
    use initia_std::object;
    use initia_std::primary_fungible_store;
    use std::event;
    use std::signer;
    use std::string;
    use std::string::String;
    use std::vector;

    const HEALTH_FACTOR_ONE: u64 = 1_000_000;

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_NOT_ADMIN: u64 = 2;
    const E_POSITION_NOT_FOUND: u64 = 3;
    const E_NOT_LIQUIDATABLE: u64 = 4;
    const E_INVALID_AMOUNT: u64 = 5;
    const E_TOKEN_METADATA_NOT_FOUND: u64 = 6;

    struct Position has store, drop {
        collateral_amount: u64,
        debt_amount: u64,
        collateral_token: String,
        debt_token: String,
        owner: address,
    }

    struct TokenMetadata has store, drop {
        token: String,
        metadata: address,
    }

    #[event]
    struct LiquidationEvent has store, drop {
        liquidator: address,
        user: address,
        collateral_amount: u64,
        debt_amount: u64,
        health_factor: u64,
    }

    struct LendingState has key {
        admin: address,
        positions: vector<Position>,
        token_metadata: vector<TokenMetadata>,
    }

    public entry fun initialize(account: &signer) {
        assert!(!exists<LendingState>(@deployer), E_ALREADY_INITIALIZED);
        let admin = signer::address_of(account);
        assert!(admin == @deployer, E_NOT_ADMIN);

        move_to(account, LendingState {
            admin,
            positions: vector::empty<Position>(),
            token_metadata: vector::empty<TokenMetadata>(),
        });
    }

    public entry fun set_token_metadata(account: &signer, token: String, metadata: address) acquires LendingState {
        let state = borrow_global_mut<LendingState>(@deployer);
        assert!(signer::address_of(account) == state.admin, E_NOT_ADMIN);

        let i = 0;
        let len = vector::length(&state.token_metadata);
        while (i < len) {
            let entry = vector::borrow_mut(&mut state.token_metadata, i);
            if (string_eq(&entry.token, &token)) {
                entry.metadata = metadata;
                return;
            };
            i = i + 1;
        };

        vector::push_back(&mut state.token_metadata, TokenMetadata { token, metadata });
    }

    public entry fun open_position(
        account: &signer,
        collateral_token: String,
        debt_token: String,
        collateral_amount: u64,
        debt_amount: u64,
    ) acquires LendingState {
        assert!(collateral_amount > 0, E_INVALID_AMOUNT);
        assert!(debt_amount > 0, E_INVALID_AMOUNT);

        let state = borrow_global_mut<LendingState>(@deployer);
        let owner = signer::address_of(account);

        let metadata = find_token_metadata(&state.token_metadata, &collateral_token);
        primary_fungible_store::transfer(
            account,
            object::address_to_object<fungible_asset::Metadata>(metadata),
            @deployer,
            collateral_amount,
        );

        let idx = find_position_index(&state.positions, owner);
        if (idx < vector::length(&state.positions)) {
            vector::swap_remove(&mut state.positions, idx);
        };

        vector::push_back(&mut state.positions, Position {
            collateral_amount,
            debt_amount,
            collateral_token,
            debt_token,
            owner,
        });
    }

    public entry fun set_health_factor_unsafe(
        account: &signer,
        user_addr: address,
        new_collateral: u64,
    ) acquires LendingState {
        let state = borrow_global_mut<LendingState>(@deployer);
        assert!(signer::address_of(account) == state.admin, E_NOT_ADMIN);

        let idx = find_position_index(&state.positions, user_addr);
        assert!(idx < vector::length(&state.positions), E_POSITION_NOT_FOUND);

        let position = vector::borrow_mut(&mut state.positions, idx);
        position.collateral_amount = new_collateral;
    }

    #[view]
    public fun get_health_factor(user_addr: address): u64 acquires LendingState {
        let state = borrow_global<LendingState>(@deployer);
        let idx = find_position_index(&state.positions, user_addr);
        assert!(idx < vector::length(&state.positions), E_POSITION_NOT_FOUND);

        let position = vector::borrow(&state.positions, idx);
        let collateral_price = mock_oracle_v2::get_price(copy_string(&position.collateral_token));
        let debt_price = mock_oracle_v2::get_price(copy_string(&position.debt_token));

        let collateral_value = (position.collateral_amount as u128) * (collateral_price as u128);
        let debt_value = (position.debt_amount as u128) * (debt_price as u128);
        if (debt_value == 0) {
            return 10_000_000;
        };

        ((collateral_value * (HEALTH_FACTOR_ONE as u128)) / debt_value) as u64
    }

    public entry fun liquidate(liquidator: &signer, user_addr: address) acquires LendingState {
        let liquidator_addr = signer::address_of(liquidator);
        let hf = get_health_factor(user_addr);

        let state = borrow_global_mut<LendingState>(@deployer);
        assert!(liquidator_addr == state.admin, E_NOT_ADMIN);
        assert!(hf < HEALTH_FACTOR_ONE, E_NOT_LIQUIDATABLE);

        let idx = find_position_index(&state.positions, user_addr);
        assert!(idx < vector::length(&state.positions), E_POSITION_NOT_FOUND);

        let position = vector::swap_remove(&mut state.positions, idx);
        let metadata = find_token_metadata(&state.token_metadata, &position.collateral_token);

        primary_fungible_store::transfer(
            liquidator,
            object::address_to_object<fungible_asset::Metadata>(metadata),
            liquidator_addr,
            position.collateral_amount,
        );

        event::emit(LiquidationEvent {
            liquidator: liquidator_addr,
            user: user_addr,
            collateral_amount: position.collateral_amount,
            debt_amount: position.debt_amount,
            health_factor: hf,
        });
    }

    fun copy_string(input: &String): String {
        let src = string::bytes(input);
        let out = vector::empty<u8>();
        let i = 0;
        let len = vector::length(src);
        while (i < len) {
            vector::push_back(&mut out, *vector::borrow(src, i));
            i = i + 1;
        };
        string::utf8(out)
    }

    fun find_position_index(positions: &vector<Position>, user: address): u64 {
        let i = 0;
        let len = vector::length(positions);
        while (i < len) {
            if (vector::borrow(positions, i).owner == user) {
                return i;
            };
            i = i + 1;
        };
        len
    }

    fun find_token_metadata(metadata_entries: &vector<TokenMetadata>, token: &String): address {
        let i = 0;
        let len = vector::length(metadata_entries);
        while (i < len) {
            let entry = vector::borrow(metadata_entries, i);
            if (string_eq(&entry.token, token)) {
                return entry.metadata;
            };
            i = i + 1;
        };
        abort E_TOKEN_METADATA_NOT_FOUND
    }

    fun string_eq(a: &String, b: &String): bool {
        let a_bytes = string::bytes(a);
        let b_bytes = string::bytes(b);
        let a_len = vector::length(a_bytes);
        if (a_len != vector::length(b_bytes)) {
            return false;
        };

        let i = 0;
        while (i < a_len) {
            if (*vector::borrow(a_bytes, i) != *vector::borrow(b_bytes, i)) {
                return false;
            };
            i = i + 1;
        };
        true
    }
}
