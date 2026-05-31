// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChessEscrow} from "../src/ChessEscrow.sol";

/// Minimal forge-script cheatcode surface (avoids a forge-std dependency so the
/// repo stays offline-buildable).
interface VmScript {
    function envAddress(string calldata) external view returns (address);
    function envOr(string calldata, address) external view returns (address);
    function envOr(string calldata, uint256) external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Deploy. Only ORACLE is required; everything else has a sane default.
///
/// Base Sepolia (testnet):
///   ORACLE=0x<oracle-addr> forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $BASE_SEPOLIA_RPC --private-key $DEPLOYER_KEY --broadcast --verify
///
/// Base mainnet:
///   ORACLE=0x.. FEE_RECIPIENT=0x.. FEE_BPS=100 SETTLE_TIMEOUT=86400 \
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $BASE_RPC --private-key $DEPLOYER_KEY --broadcast --verify
///
/// `TOKEN` defaults to the canonical Circle USDC for the connected chain
/// (Base mainnet / Base Sepolia); override for anything else. `FEE_RECIPIENT`
/// defaults to ORACLE, `FEE_BPS` to 100 (1%), `SETTLE_TIMEOUT` to 24h.
contract Deploy {
    VmScript constant vm = VmScript(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // Canonical Circle USDC (6 decimals).
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // chainid 8453
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e; // chainid 84532

    function run() external returns (ChessEscrow escrow) {
        address defaultToken = block.chainid == 84532 ? BASE_SEPOLIA_USDC : BASE_USDC;
        address token = vm.envOr("TOKEN", defaultToken);
        address oracle = vm.envAddress("ORACLE");
        address feeRecipient = vm.envOr("FEE_RECIPIENT", oracle);
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(100))); // 1%
        uint64 settleTimeout = uint64(vm.envOr("SETTLE_TIMEOUT", uint256(86400))); // 24h

        vm.startBroadcast();
        escrow = new ChessEscrow(token, oracle, feeRecipient, feeBps, settleTimeout);
        vm.stopBroadcast();
    }
}
