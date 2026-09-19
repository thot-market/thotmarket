// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed genesis THOT token. There is no owner, proxy, or later mint path.
contract ThotToken {
    string public constant name = "THOT token";
    string public constant symbol = "THOT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address genesisRecipient, uint256 genesisSupply) {
        require(genesisRecipient != address(0) && genesisSupply > 0, "INVALID_GENESIS");
        totalSupply = genesisSupply;
        balanceOf[genesisRecipient] = genesisSupply;
        emit Transfer(address(0), genesisRecipient, genesisSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        require(spender != address(0), "ZERO_SPENDER");
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transfer(from, to, value);
        return true;
    }

    function burn(uint256 value) external { _burn(msg.sender, value); }

    function burnFrom(address from, uint256 value) external {
        _spendAllowance(from, msg.sender, value);
        _burn(from, value);
    }

    function _spendAllowance(address from, address spender, uint256 value) private {
        uint256 available = allowance[from][spender];
        if (available != type(uint256).max) {
            require(available >= value, "INSUFFICIENT_ALLOWANCE");
            allowance[from][spender] = available - value;
            emit Approval(from, spender, available - value);
        }
    }

    function _transfer(address from, address to, uint256 value) private {
        require(from != address(0) && to != address(0), "ZERO_ADDRESS");
        require(balanceOf[from] >= value, "INSUFFICIENT_BALANCE");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _burn(address from, uint256 value) private {
        require(from != address(0), "ZERO_ADDRESS");
        require(balanceOf[from] >= value, "INSUFFICIENT_BALANCE");
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }
}
