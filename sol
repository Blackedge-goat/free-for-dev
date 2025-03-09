// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract FlashLoanArbitrage is Ownable {
    using SafeERC20 for IERC20;

    IPool public immutable POOL;
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;

    // Token addresses
    address public constant DAI = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1;
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    // Accumulated profit in DAI
    uint256 private profitBalanceDAI;

    // Events for logging and debugging.
    event FlashLoanInitiated(
        address indexed initiator,
        address indexed asset,
        uint256 amount,
        bytes params,
        uint256 timestamp
    );
    event FlashLoanReceived(address indexed asset, uint256 amount);
    event SwapExecuted(
        address indexed fromToken,
        address indexed toToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 timestamp
    );
    event SwapFailed(string message, bytes returnData, uint256 timestamp);
    event SlippageValidation(
        uint256 minAcceptable,
        uint256 received,
        uint256 timestamp
    );
    event ProfitGenerated(uint256 profit);
    event ProfitUpdated(uint256 oldBalance, uint256 newBalance, uint256 timestamp);
    event PreRepayment(
        uint256 repayAmount,
        uint256 currentBalance,
        uint256 amountToApprove,
        uint256 timestamp
    );
    event PostRepayment(uint256 repayAmount, uint256 remainingBalance, uint256 timestamp);
    event PreApproval(
        address token,
        address spender,
        uint256 currentAllowance,
        uint256 amount,
        uint256 timestamp
    );
    event PostApproval(address token, address spender, uint256 newAllowance, uint256 timestamp);
    event ApprovalEnsured(address token, address spender, uint256 amount);

    /**
     * @notice Constructor.
     * @param _addressesProvider The Aave PoolAddressesProvider address.
     */
    constructor(address _addressesProvider) Ownable(msg.sender) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressesProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
    }

    /**
     * @notice Initiates a flash loan in WETH and performs a single swap from WETH to DAI.
     * @param amount The flash loan amount (in WETH).
     * @param params Encoded parameters for the swap:
     *   (address router, bytes swapData, uint256 minAcceptableDAI)
     *
     * The JS script encodes these as:
     *   ethers.AbiCoder.defaultAbiCoder().encode(
     *       ["address", "bytes", "uint256"],
     *       [txData.to, txData.data, minAcceptableDestAmount]
     *   );
     */
    function executeFlashLoanWithSwap(
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        require(amount > 0, "Flash loan amount must be > 0");
        emit FlashLoanInitiated(msg.sender, WETH, amount, params, block.timestamp);

        // Initiate flash loan in WETH.
        POOL.flashLoanSimple(
            address(this),
            WETH,
            amount,
            params,
            0
        );
    }

    /**
     * @notice Aave flash loan callback.
     * @dev This function is called by the Aave Pool. It executes the swap and repays the loan.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address, /* initiator */
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "Unauthorized caller");
        require(asset == WETH, "Flash loan asset must be WETH");

        emit FlashLoanReceived(asset, amount);
        return executeFlashLoanWithSwapInternal(amount, premium, params);
    }

    /**
     * @notice Internal function to perform a single swap from WETH to DAI.
     * @param amount The flash loan amount (in WETH).
     * @param premium The flash loan fee.
     * @param params Encoded parameters: (address router, bytes swapData, uint256 minAcceptableDAI)
     *
     * Note: This implementation uses a fixed fraction of the flash loan (here, 50%) for the swap.
     * To ensure the flash loan can be repaid (WETH balance >= amount+premium), the contract must
     * hold additional WETH if the swapped portion is removed.
     */
    function executeFlashLoanWithSwapInternal(
        uint256 amount,
        uint256 premium,
        bytes calldata params
    ) internal returns (bool) {
        // Decode parameters from your JS script.
        (address router, bytes memory swapData, uint256 minAcceptableDAI) = abi.decode(
            params,
            (address, bytes, uint256)
        );

        // For this example, we swap a fixed fraction (50%) of the flash-loaned WETH.
        uint256 swapAmount = amount / 2;

        // Approve the router to spend the swapAmount of WETH.
        ensureApproval(WETH, router, swapAmount);

        // Record the DAI balance before the swap.
        uint256 preDAIBalance = IERC20(DAI).balanceOf(address(this));

        // Execute the swap via the router.
        (bool swapSuccess, bytes memory swapResult) = router.call(swapData);
        if (!swapSuccess) {
            string memory reason = _getRevertMsg(swapResult);
            emit SwapFailed(reason, swapResult, block.timestamp);
            revert(reason);
        }

        // Calculate DAI received.
        uint256 postDAIBalance = IERC20(DAI).balanceOf(address(this));
        uint256 daiReceived = postDAIBalance - preDAIBalance;

        emit SlippageValidation(minAcceptableDAI, daiReceived, block.timestamp);
        require(daiReceived >= minAcceptableDAI, "Swap slippage exceeded");
        emit SwapExecuted(WETH, DAI, swapAmount, daiReceived, block.timestamp);

        // Repayment: The flash loan requires repaying (amount + premium) in WETH.
        // Since swapAmount of the flash loan was used for the swap, the contract must have additional WETH
        // (e.g., pre-funded) so that the overall WETH balance is >= (amount + premium).
        uint256 currentWETH = IERC20(WETH).balanceOf(address(this));
        uint256 repayAmount = amount + premium;
        require(currentWETH >= repayAmount, "Insufficient WETH for repayment");

        emit PreRepayment(repayAmount, currentWETH, repayAmount, block.timestamp);
        IERC20(WETH).approve(address(POOL), repayAmount);
        emit PostRepayment(repayAmount, currentWETH - repayAmount, block.timestamp);

        // Update profit (profit is measured in DAI).
        uint256 oldProfit = profitBalanceDAI;
        profitBalanceDAI += daiReceived;
        emit ProfitGenerated(daiReceived);
        emit ProfitUpdated(oldProfit, profitBalanceDAI, block.timestamp);

        return true;
    }

    /**
     * @notice Internal helper to ensure a spender is approved to spend a given token amount.
     */
    function ensureApproval(
        address token,
        address spender,
        uint256 amount
    ) internal {
        emit PreApproval(token, spender, IERC20(token).allowance(address(this), spender), amount, block.timestamp);

        if (IERC20(token).allowance(address(this), spender) < amount) {
            IERC20(token).approve(spender, type(uint256).max);
            emit ApprovalEnsured(token, spender, type(uint256).max);
        }

        // Additionally, ensure approval for a common token transfer proxy if needed.
        address tokenTransferProxy = 0x216B4B4Ba9F3e719726886d34a177484278Bfcae;
        if (IERC20(token).allowance(address(this), tokenTransferProxy) < amount) {
            IERC20(token).approve(tokenTransferProxy, type(uint256).max);
            emit ApprovalEnsured(token, tokenTransferProxy, type(uint256).max);
        }
        emit PostApproval(token, spender, IERC20(token).allowance(address(this), spender), block.timestamp);
    }

    /**
     * @notice Decodes revert messages from failed low-level calls.
     */
    function _getRevertMsg(bytes memory _returnData) internal pure returns (string memory) {
        // If _returnData length is less than 68, then the transaction reverted silently.
        if (_returnData.length < 68) return "Transaction reverted silently";
        assembly {
            // Skip the function selector.
            _returnData := add(_returnData, 0x04)
        }
        return abi.decode(_returnData, (string));
    }

    /**
     * @notice Returns the accumulated profit in DAI.
     */
    function profitBalanceDAIView() external view returns (uint256) {
        return profitBalanceDAI;
    }

    // Allow the contract to receive ETH.
    receive() external payable {
        payable(owner()).transfer(msg.value);
    }

    /**
     * @notice Allows the owner to rescue any tokens mistakenly sent to the contract.
     */
    function rescueTokens(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), balance);
    }
}
