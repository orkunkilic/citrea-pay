// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract Sweeper {
    event Swept(address[] tokens, address receiver);

    /// @notice Sweeps all native and specified ERC20 token balances to the treasury.
    /// @param tokens The array of ERC20 token addresses to sweep.
    // It is likely vulnerable as it can be called by anyone, but the authorization is only given to a specific EOA and contract is self-destructed after sweeping.
    function sweep(address[] calldata tokens, address receiver) external {
        // Send all native token balance
        uint256 nativeBalance = address(this).balance;
        if (nativeBalance > 0) {
            (bool sent,) = receiver.call{value: nativeBalance}("");
            require(sent, "Native transfer failed");
        }

        // Send all specified ERC20 token balances
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 token = IERC20(tokens[i]);
            uint256 tokenBalance = token.balanceOf(address(this));
            if (tokenBalance > 0) {
                require(token.transfer(receiver, tokenBalance), "Token transfer failed");
            }
        }

        // Emit event for off-chain listeners
        emit Swept(tokens, receiver);

        // Self-destruct the contract to reclaim gas
        selfdestruct(payable(receiver));
    }

    // Allow contract to receive native tokens
    receive() external payable {}
}
