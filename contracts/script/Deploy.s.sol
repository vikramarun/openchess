// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChessEscrow} from "../src/ChessEscrow.sol";

/// Minimal forge-script cheatcode surface (avoids a forge-std dependency so the
/// repo stays offline-buildable).
interface VmScript {
    function envAddress(string calldata) external view returns (address);
    function envUint(string calldata) external view returns (uint256);
    function envOr(string calldata, address) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Production deploy:
///   ORACLE=0x.. FEE_RECIPIENT=0x.. FEE_BPS=100 SETTLE_TIMEOUT=86400 \
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $BASE_RPC --private-key $DEPLOYER_KEY --broadcast --verify
///
/// `TOKEN` defaults to canonical Base mainnet USDC; override for testnet.
contract Deploy {
    VmScript constant vm = VmScript(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // Canonical Circle USDC on Base mainnet.
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external returns (ChessEscrow escrow) {
        address token = vm.envOr("TOKEN", BASE_USDC);
        address oracle = vm.envAddress("ORACLE");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint16 feeBps = uint16(vm.envUint("FEE_BPS"));
        uint64 settleTimeout = uint64(vm.envUint("SETTLE_TIMEOUT"));

        vm.startBroadcast();
        escrow = new ChessEscrow(token, oracle, feeRecipient, feeBps, settleTimeout);
        vm.stopBroadcast();
    }
}
