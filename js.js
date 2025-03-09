const axios = require('axios');
const { ethers } = require('ethers');
const { constructSimpleSDK } = require('@paraswap/sdk');
require('dotenv').config();

// Configuration
const PARASWAP_API_URL = 'https://apiv5.paraswap.io';
const CHAIN_ID = 42161; // Arbitrum
const CONTRACT_ADDRESS = '0xE3F1231777f0cc3493468CEc0383ABb603162eb2';
const CHECK_INTERVAL = 5000;
const MIN_PROFIT_THRESHOLD_USD = 3.80;
const LOAN_AMOUNTS = ['1'];
const SLIPPAGE_PERCENT = 0.5; // Slippage tolerance as a percentage (e.g., 1 for 1%)

// ParaSwap Configuration
const PARASWAP_PARTNERS = {
    referrer: 'arbitrage-bot',
    fee: 0
};

// Token Configuration
const ERC20_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)'
];

const TOKENS = {
    DAI: {
        address: '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
        decimals: 18,
        abi: ERC20_ABI
    },
    WETH: {
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        decimals: 18,
        abi: ERC20_ABI
    }
};

// Initialize Ethereum components
const provider = new ethers.JsonRpcProvider(process.env.TENDERLY_RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const paraSwap = constructSimpleSDK({
    chainId: CHAIN_ID,
    fetcher: axios,
    version: '5',
    apiURL: PARASWAP_API_URL,
    partner: PARASWAP_PARTNERS.referrer
});

// Initialize contracts with corrected ABI
const arbitrageContract = new ethers.Contract(
    CONTRACT_ADDRESS,
    [
        // Core Function ABI
        {
            // NOTE: The "asset" input below is no longer used in the updated contract.
            // For the new contract version, remove the asset parameter.
            "inputs": [
                // {"internalType": "address","name": "asset","type": "address"}, // REMOVE this parameter!
                {"internalType": "uint256","name": "amount","type": "uint256"},
                {"internalType": "bytes","name": "params","type": "bytes"}
            ],
            "name": "executeFlashLoanWithSwap",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function"
        },
        // Include other necessary ABI entries from your contract
        ...require('./FlashLoanArbitrageABI.json')
    ],
    signer
);

const tokenContracts = {
    DAI: new ethers.Contract(TOKENS.DAI.address, TOKENS.DAI.abi, signer),
    WETH: new ethers.Contract(TOKENS.WETH.address, TOKENS.WETH.abi, signer)
};

// Enhanced approval system
async function ensureApprovals() {
    try {
        const spender = await getSpender(); // Retrieve ParaSwap spender address
        const arbitrageContractAddress = CONTRACT_ADDRESS; // Arbitrage contract address
        const userAddress = await signer.getAddress(); // User's wallet address

        console.log('Verifying approvals for:');
        console.log('- ParaSwap Spender:', spender);
        console.log('- Arbitrage Contract:', arbitrageContractAddress);

        // Check approvals for both ParaSwap and Arbitrage Contract
        for (const tokenSymbol of ['DAI', 'WETH']) {
            const contract = tokenContracts[tokenSymbol]; // Get ERC20 contract for the token

            // Check ParaSwap allowance
            let allowance = await contract.allowance(userAddress, spender);
            console.log(`${tokenSymbol} allowance for ParaSwap: ${ethers.formatUnits(allowance, 18)}`);
            if (allowance === 0n) {
                console.log(`Approving ${tokenSymbol} for ParaSwap...`);
                const tx = await contract.approve(spender, ethers.MaxUint256); // Approve unlimited tokens
                console.log(`Approval transaction sent for ParaSwap: ${tx.hash}`);
                const receipt = await tx.wait(); // Wait for the transaction to be mined
                console.log(`${tokenSymbol} approved for ParaSwap. Gas used: ${receipt.gasUsed.toString()}`);

                // Verify approval
                const newAllowance = await contract.allowance(userAddress, spender);
                if (newAllowance === 0n) {
                    throw new Error(`Failed to approve ${tokenSymbol} for ParaSwap`);
                }
            }

            // Check Arbitrage Contract allowance
            allowance = await contract.allowance(userAddress, arbitrageContractAddress);
            console.log(`${tokenSymbol} allowance for Arbitrage Contract: ${ethers.formatUnits(allowance, 18)}`);
            if (allowance === 0n) {
                console.log(`Approving ${tokenSymbol} for Arbitrage Contract...`);
                const tx = await contract.approve(arbitrageContractAddress, ethers.MaxUint256); // Approve unlimited tokens
                console.log(`Approval transaction sent for Arbitrage Contract: ${tx.hash}`);
                const receipt = await tx.wait(); // Wait for the transaction to be mined
                console.log(`${tokenSymbol} approved for Arbitrage Contract. Gas used: ${receipt.gasUsed.toString()}`);

                // Verify approval
                const newAllowance = await contract.allowance(userAddress, arbitrageContractAddress);
                if (newAllowance === 0n) {
                    throw new Error(`Failed to approve ${tokenSymbol} for Arbitrage Contract`);
                }
            }
        }

        console.log('All necessary approvals confirmed.');
    } catch (error) {
        console.error('Approval verification failed:', error);
        throw error; // Throw error to be handled by the calling function
    }
}

// Updated getSpender with better error handling
async function getSpender() {
    try {
        // Attempt to fetch the ParaSwap spender address
        const spender = await paraSwap.swap.getSpender();
        if (!ethers.isAddress(spender)) throw new Error('Invalid spender address returned from ParaSwap');
        return spender; // Return the fetched spender address if valid
    } catch (error) {
        console.error('Failed to get ParaSwap spender:', error.message);
        // Fallback to a known proxy address if ParaSwap request fails
        return '0xdef171fe48cf0115b1d80b88dc8eab59176fee57';
    }
}

async function getPriceRoute(srcToken, destToken, amountWei) {
    try {
        console.log('Fetching price route with params:', {
            srcToken,
            destToken,
            amount: amountWei.toString(),
            network: CHAIN_ID
        });

        const params = {
            srcToken,
            destToken,
            amount: amountWei.toString(),
            srcDecimals: 18,
            destDecimals: 18,
            network: CHAIN_ID,
            side: 'SELL',
            options: {
                partner: PARASWAP_PARTNERS.referrer,
                includeDEXS: null,
                excludeDEXS: [],
                onlyDEXS: false,
                maxImpact: 50,
            }
        };

        console.log('Sending request to ParaSwap API...');
        const response = await axios.get(`${PARASWAP_API_URL}/prices`, {
            params,
            validateStatus: false // This allows us to handle all status codes
        });

        console.log('ParaSwap API response status:', response.status);

        if (response.status !== 200) {
            console.error('ParaSwap API error details:', {
                status: response.status,
                statusText: response.statusText,
                data: response.data
            });
            throw new Error(`ParaSwap API error: ${JSON.stringify(response.data)}`);
        }

        if (!response.data?.priceRoute) {
            console.error('Invalid price route response:', response.data);
            throw new Error('Invalid price route data structure');
        }

        // Validate price route details
        const priceRoute = response.data.priceRoute;
        console.log('Price route details:', {
            srcUSD: priceRoute.srcUSD,
            destUSD: priceRoute.destUSD,
            routes: priceRoute.bestRoute?.length || 0,
            maxImpact: priceRoute.maxImpact
        });

        if (!priceRoute.bestRoute || priceRoute.bestRoute.length === 0) {
            throw new Error('No valid routes found in price route response');
        }

        return priceRoute;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Axios error in getPriceRoute:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                message: error.message
            });
        } else {
            console.error('Non-Axios error in getPriceRoute:', error);
        }
        throw error;
    }
}

async function calculateNetProfit(priceRoute, _loanAmount) {
    try {
        // Remove gas estimation
        // const gasPrice = await provider.getFeeData();
        // const estimatedGasCost = gasPrice.gasPrice * BigInt(gasLimit);
        // const gasCostETH = parseFloat(ethers.formatEther(estimatedGasCost));
        // const gasCostUSD = gasCostETH * parseFloat(priceRoute.srcUSD); // Approximate USD gas cost

        // Calculate gross profit
        const grossProfitUSD = parseFloat(priceRoute.destUSD) - parseFloat(priceRoute.srcUSD);

        // Calculate net profit (without gas costs)
        // const netProfitUSD = grossProfitUSD - gasCostUSD;
        const netProfitUSD = grossProfitUSD; // Just use gross profit now

        console.log(`Gross profit: $${grossProfitUSD.toFixed(4)}`);
        // console.log(`Estimated gas cost: $${gasCostUSD.toFixed(4)}`);
        console.log(`Net profit: $${netProfitUSD.toFixed(4)}`);

        return netProfitUSD;
    } catch (error) {
        console.error('Profit calculation error:', error);
        return -999; // Return large negative number to ensure skip
    }
}

async function buildSwapTransaction(priceRoute, srcToken, destToken, loanAmountWei, userAddress) {
    try {
        console.log("Full Price Route JSON:", JSON.stringify(priceRoute, null, 2));

        const expectedDestAmount = BigInt(priceRoute.destAmount);
        const minAcceptableDestAmount = expectedDestAmount * BigInt(Math.round((1 - (SLIPPAGE_PERCENT / 100)) * 10000)) / BigInt(10000);

        console.log("Expected Destination Amount (DAI):", expectedDestAmount.toString());
        console.log("Minimum Acceptable Destination Amount (DAI) with slippage:", minAcceptableDestAmount.toString());


        const txParams = {
            srcToken,
            destToken,
            srcDecimals: 18,
            destDecimals: 18,
            srcAmount: loanAmountWei.toString(),
            slippage: SLIPPAGE_PERCENT * 100, // Pass slippage as basis points
            deadline: Math.floor(Date.now() / 1000) + 600,  // 1 hour deadline
            partner: 'arbitrage-bot',
            ignoreChecks: true,
            onlyParams: false,
            userAddress,
            priceRoute
        };

        console.log('Requesting transaction build with params:', txParams);
        const response = await paraSwap.swap.buildTx(txParams);
        const txData = response.data;

        if (!txData?.to || !txData?.data) {
            console.error('Invalid transaction data received:', txData);
            throw new Error('Invalid transaction data structure');
        }

        console.log('Transaction data received:', {
            to: txData.to,
            dataLength: txData.data.length,
            value: txData.data || '0'
        });

        return { txData, minAcceptableDestAmount }; // Return both txData and minAcceptableDestAmount
    } catch (error) {
        console.error('Detailed error in buildSwapTransaction:', {
            message: error.message,
            response: error.response?.data,
            request: error.config?.data
        });
        throw error;
    }
}

// Updated executeFlashArbitrage function
async function executeFlashArbitrage(srcToken, destToken, loanAmount) {
    try {
        const loanAmountWei = ethers.parseUnits(loanAmount, 18);
        console.log(`\n=== Processing ${loanAmount} ETH flash loan ===`);

        // Get user's address
        const userAddress = await signer.getAddress();

        // Get price route first
        const priceRoute = await getPriceRoute(srcToken, destToken, loanAmountWei);

        // Calculate expected profit
        const netProfitUSD = await calculateNetProfit(priceRoute, loanAmount);
        if (netProfitUSD < MIN_PROFIT_THRESHOLD_USD) {
            console.log(`Skipping - Below profit threshold`);
            return;
        }

        // Build swap params and get minAcceptableDestAmount
        const { txData, minAcceptableDestAmount } = await buildSwapTransaction(priceRoute, srcToken, destToken, loanAmountWei, userAddress);

        // Encode the flash loan parameters, including minAcceptableDestAmount
        const encodedParams = ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "bytes", "uint256"], // Updated encoding to include minAcceptableDestAmount
            [txData.to, txData.data, minAcceptableDestAmount] // Include minAcceptableDestAmount in encoded params
        );

        // Remove gas price estimation
        // const feeData = await provider.getFeeData();

        // Execute flash loan
        console.log('Executing flash loan with params:', {
            srcToken,
            amount: ethers.formatEther(loanAmountWei),
            encodedParamsLength: encodedParams.length,
            minAcceptableDestAmount: minAcceptableDestAmount.toString() // Log minAcceptableDestAmount
        });

        // NOTE: The updated contract's executeFlashLoanWithSwap function only accepts two parameters:
        // the loan amount and the encoded params. Therefore, remove the extra srcToken parameter.
        const tx = await arbitrageContract.executeFlashLoanWithSwap(
            // srcToken, // REMOVE this parameter for the updated contract!
            loanAmountWei,
            encodedParams,
            {
                gasLimit: 5_000_000,
                // Removed gas price estimation
                // maxFeePerGas: feeData.maxFeePerGas ? feeData.maxFeePerGas * 15n / 10n : undefined,
                // maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas * 15n / 10n : undefined
            }
        );

        console.log('Flash loan transaction sent:', tx.hash);
        const receipt = await tx.wait();

        console.log('Transaction completed:', {
            status: receipt.status,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: ethers.formatUnits(receipt.effectiveGasPrice, 'gwei')
        });

    } catch (error) {
        console.error('\n=== Flash Loan Error Details ===');
        if (error.response?.data) {
            console.error('API Response:', error.response.data);
        }
        if (error.error?.error?.data) {
            const errorData = error.error.error.data;
            try {
                // Try to decode custom error if present
                const decodedError = arbitrageContract.interface.parseError(errorData);
                console.error('Decoded contract error:', decodedError);
            } catch (e) {
                console.error('Raw error data:', errorData);
            }
        }
        throw error;
    }
}

// Monitor loop with improved error handling
async function monitor() {
    console.log('🚀 Starting arbitrage monitor...');
    try {
        // Initial approval check before any swaps occur
        await ensureApprovals();

        while (true) {
            try {
                for (const amount of LOAN_AMOUNTS) {
                    // For a single swap (WETH -> DAI flash loan) only call this once.
                    await executeFlashArbitrage(TOKENS.WETH.address, TOKENS.DAI.address, amount);
                    // The following call (DAI -> WETH) does not match the contract's logic and should be removed.
                    // await executeFlashArbitrage(TOKENS.DAI.address, TOKENS.WETH.address, amount);
                }
            } catch (error) {
                console.error('Cycle error:', error.message);
            }
            await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
        }
    } catch (error) {
        console.error('Fatal monitor error:', error);
        process.exit(1);
    }
}

// Add initial setup verification
async function verifySetup() {
    try {
        console.log('Verifying network connection...');
        const network = await provider.getNetwork();
        console.log(`Connected to network: ${network.name} (${network.chainId})`);

        console.log('Verifying signer...');
        const address = await signer.getAddress();
        const balance = await provider.getBalance(address);
        console.log(`Signer address: ${address}`);
        console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

        return true;
    } catch (error) {
        console.error('Setup verification failed:', error);
        return false;
    }
}

// Main execution
async function main() {
    const setupOk = await verifySetup();
    if (setupOk) {
        await monitor();
    } else {
        console.error('Exiting due to setup verification failure');
        process.exit(1);
    }
}

main().catch(console.error);
