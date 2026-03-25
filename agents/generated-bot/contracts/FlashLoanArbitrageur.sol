// ============================================================
// FILE: contracts/FlashLoanArbitrageur.sol
// Aave V3 Flash Loan Arbitrageur — ARBITRUM
// Strategy: multi_hop
// 
// Deploy this contract BEFORE running the agent.
// The agent calls executeArbitrage() to trigger the flash loan.
// ============================================================

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// Interface for DEX router (Uniswap V3 / compatible)
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

/**
 * @title FlashLoanArbitrageur
 * @notice Executes flash loan-funded arbitrage across two DEXs in a single tx.
 * @dev Only the owner (your agent wallet) can call executeArbitrage().
 */
contract FlashLoanArbitrageur is FlashLoanSimpleReceiverBase, Ownable {
    
    // Aave Pool Addresses Provider for arbitrum
    address public constant ADDRESSES_PROVIDER = 
        0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;

    // DEX Router addresses (set in constructor)
    address public dexA;  // e.g. Uniswap V3
    address public dexB;  // e.g. SushiSwap

    // Track active arbitrage parameters during flash loan callback
    struct ArbitrageParams {
        address tokenBorrow;   // Token to borrow from Aave
        address tokenInterim;  // Intermediate token (e.g., ETH when doing USDC->ETH->USDC)
        uint256 amountBorrow;  // Amount to borrow
        uint24 feeDexA;        // Pool fee tier on DEX A
        uint24 feeDexB;        // Pool fee tier on DEX B
        uint256 minProfit;     // Minimum acceptable profit in tokenBorrow units
    }

    ArbitrageParams private activeParams;

    event ArbitrageExecuted(
        address indexed tokenBorrow,
        uint256 amountBorrowed,
        uint256 profit
    );

    constructor(address _dexA, address _dexB)
        FlashLoanSimpleReceiverBase(
            IPoolAddressesProvider(ADDRESSES_PROVIDER)
        )
        Ownable(msg.sender)
    {
        dexA = _dexA;
        dexB = _dexB;
    }

    /**
     * @notice Entry point called by the agent to kick off arbitrage.
     * @param params Arbitrage configuration (tokens, amounts, DEX fees)
     */
    function executeArbitrage(ArbitrageParams calldata params) 
        external onlyOwner 
    {
        activeParams = params;
        
        // Request flash loan from Aave — this triggers executeOperation() callback
        POOL.flashLoanSimple(
            address(this),          // receiver
            params.tokenBorrow,     // asset to borrow
            params.amountBorrow,    // amount
            abi.encode(params),     // params (passed back in callback)
            0                       // referralCode
        );
    }

    /**
     * @notice Aave calls this WITHIN the flash loan transaction.
     * @dev Must repay amount + premium (0.09% Aave fee) by end of this function.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /* initiator */,
        bytes calldata /* params */
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Only Aave pool");
        
        ArbitrageParams memory p = activeParams;
        uint256 totalDebt = amount + premium; // amount + 0.09% Aave fee

        // ── STEP 1: Swap borrowed token -> interim token on DEX A ──────────
        IERC20(asset).approve(p.dexA, amount);
        
        uint256 interimAmount = ISwapRouter(dexA).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: asset,
                tokenOut: p.tokenInterim,
                fee: p.feeDexA,
                recipient: address(this),
                deadline: block.timestamp + 60,
                amountIn: amount,
                amountOutMinimum: 0, // Agent pre-calculates safe minimum
                sqrtPriceLimitX96: 0
            })
        );

        // ── STEP 2: Swap interim token -> original token on DEX B ──────────
        IERC20(p.tokenInterim).approve(dexB, interimAmount);
        
        uint256 returnedAmount = ISwapRouter(dexB).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: p.tokenInterim,
                tokenOut: asset,
                fee: p.feeDexB,
                recipient: address(this),
                deadline: block.timestamp + 60,
                amountIn: interimAmount,
                amountOutMinimum: totalDebt, // Must at least cover debt
                sqrtPriceLimitX96: 0
            })
        );

        // ── STEP 3: Verify profit meets minimum threshold ───────────────────
        require(
            returnedAmount >= totalDebt + p.minProfit, 
            "Insufficient profit"
        );

        // ── STEP 4: Approve Aave to pull back the debt ──────────────────────
        IERC20(asset).approve(address(POOL), totalDebt);

        uint256 profit = returnedAmount - totalDebt;
        emit ArbitrageExecuted(asset, amount, profit);

        return true;
    }

    /**
     * @notice Withdraw accumulated profits to owner wallet.
     */
    function withdrawProfit(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "Nothing to withdraw");
        IERC20(token).transfer(owner(), balance);
    }

    // Allow contract to receive ETH
    receive() external payable {}
}