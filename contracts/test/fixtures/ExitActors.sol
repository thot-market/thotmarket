// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
// Synthetic assumption probes. Never compiled by public-testnet deployment tooling.
contract ExitProbeToken {
    uint256 public totalSupply;
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    mapping(address=>uint8) public mode;
    address public immutable controller;
    constructor(){controller=msg.sender;totalSupply=1_000_000_000 ether;balanceOf[msg.sender]=totalSupply;}
    function setMode(address recipient,uint8 next) external {require(msg.sender==controller);mode[recipient]=next;}
    function approve(address spender,uint256 amount) external returns(bool){allowance[msg.sender][spender]=amount;return true;}
    function transfer(address to,uint256 amount) external returns(bool){return move(msg.sender,to,amount);}
    function transferFrom(address from,address to,uint256 amount) external returns(bool){if(allowance[from][msg.sender]!=type(uint256).max)allowance[from][msg.sender]-=amount;return move(from,to,amount);}
    function move(address from,address to,uint256 amount) private returns(bool){
        require(mode[to]!=1,"RECIPIENT_BLOCKED");if(mode[to]==2)return false;
        balanceOf[from]-=amount;balanceOf[to]+=amount;
        if(mode[to]==3)assembly{return(0,0)}
        return true;
    }
}
contract ExitBeneficiary {
    address public immutable owner;
    constructor(){owner=msg.sender;}
    function execute(address target,bytes calldata data) external returns(bytes memory result){
        require(msg.sender==owner);bool ok;(ok,result)=target.call(data);if(!ok)assembly{revert(add(result,32),mload(result))}
    }
    fallback() external {revert("NO_FALLBACK");}
}
