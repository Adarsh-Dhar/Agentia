module deployer::mock_oracle_v2 {
    use initia_std::simple_map::{Self, SimpleMap};
    use std::event;
    use std::signer;
    use std::string;
    use std::string::String;
    use std::vector;

    const E_ALREADY_INITIALIZED: u64 = 1;
    const E_NOT_ADMIN: u64 = 2;
    const E_PRICE_NOT_FOUND: u64 = 3;

    #[event]
    struct PriceUpdatedEvent has store, drop {
        token: String,
        price: u64,
        updated_by: address,
    }

    struct PriceStore has key {
        admin: address,
        prices: SimpleMap<String, u64>,
    }

    public entry fun initialize(account: &signer) {
        assert!(!exists<PriceStore>(@deployer), E_ALREADY_INITIALIZED);
        let admin = signer::address_of(account);
        assert!(admin == @deployer, E_NOT_ADMIN);

        move_to(account, PriceStore {
            admin,
            prices: simple_map::new<String, u64>(),
        });
    }

    public entry fun set_price(account: &signer, token: String, price: u64) acquires PriceStore {
        let store = borrow_global_mut<PriceStore>(@deployer);
        let caller = signer::address_of(account);
        assert!(caller == store.admin, E_NOT_ADMIN);

        let event_token = clone_string(&token);
        if (simple_map::contains_key(&store.prices, &token)) {
            *simple_map::borrow_mut(&mut store.prices, &token) = price;
        } else {
            simple_map::add(&mut store.prices, token, price);
        };

        event::emit(PriceUpdatedEvent {
            token: event_token,
            price,
            updated_by: caller,
        });
    }

    #[view]
    public fun get_price(token: String): u64 acquires PriceStore {
        let store = borrow_global<PriceStore>(@deployer);
        assert!(simple_map::contains_key(&store.prices, &token), E_PRICE_NOT_FOUND);
        *simple_map::borrow(&store.prices, &token)
    }

    #[view]
    public fun get_price_ref(token: String): u64 acquires PriceStore {
        let store = borrow_global<PriceStore>(@deployer);
        assert!(simple_map::contains_key(&store.prices, &token), E_PRICE_NOT_FOUND);
        *simple_map::borrow(&store.prices, &token)
    }

    fun clone_string(input: &String): String {
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
}
