// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IBurnableToken is IERC20 {
    function burn(uint256 value) external;
}

library SafeToken {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _call(token, abi.encodeCall(token.transfer, (to, value)));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        _call(token, abi.encodeCall(token.transferFrom, (from, to, value)));
    }

    function _call(IERC20 token, bytes memory data) private {
        require(address(token).code.length > 0, "TOKEN_NOT_CONTRACT");
        (bool ok, bytes memory result) = address(token).call(data);
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "TOKEN_TRANSFER_FAILED");
    }
}
