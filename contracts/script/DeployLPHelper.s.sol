// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {UniswapV3LPHelper} from "../src/UniswapV3LPHelper.sol";

/// @title DeployLPHelper
/// @notice Foundry script to deploy UniswapV3LPHelper on any supported chain.
/// @dev Usage:
///   forge script script/DeployLPHelper.s.sol:DeployLPHelper \
///     --rpc-url <RPC_URL> --broadcast --verify \
///     -vvvv
///
///   Required env vars:
///     PRIVATE_KEY  - deployer private key (or use --ledger / --trezor)
///
///   Optional env vars:
///     ETHERSCAN_API_KEY - for contract verification
contract DeployLPHelper is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        UniswapV3LPHelper helper = new UniswapV3LPHelper();

        vm.stopBroadcast();

        console.log("UniswapV3LPHelper deployed at:", address(helper));
        console.log("Chain ID:", block.chainid);
        console.log("Deployer:", vm.addr(deployerKey));
    }
}
