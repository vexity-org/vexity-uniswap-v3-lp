// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {UniswapV3LPHelper} from "../src/UniswapV3LPHelper.sol";

/// @title DeployLPHelper
/// @notice Foundry script to deploy UniswapV3LPHelper on any supported chain.
/// @dev Signing is handled externally via forge flags. Supported methods:
///
///   Foundry keystore (recommended):
///     forge script script/DeployLPHelper.s.sol:DeployLPHelper \
///       --rpc-url <RPC_URL> --account <wallet-name> --broadcast -vvvv
///
///   Raw private key:
///     forge script script/DeployLPHelper.s.sol:DeployLPHelper \
///       --rpc-url <RPC_URL> --private-key $PRIVATE_KEY --broadcast -vvvv
///
///   Hardware wallet:
///     forge script script/DeployLPHelper.s.sol:DeployLPHelper \
///       --rpc-url <RPC_URL> --ledger --broadcast -vvvv
contract DeployLPHelper is Script {
    function run() external {
        vm.startBroadcast();

        UniswapV3LPHelper helper = new UniswapV3LPHelper();

        vm.stopBroadcast();

        console.log("UniswapV3LPHelper deployed at:", address(helper));
        console.log("Chain ID:", block.chainid);
    }
}
