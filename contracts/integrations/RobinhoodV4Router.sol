// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Narrow ABI declarations for Uniswap v4 IPoolManager / IV4Quoter.
// Source: github.com/Uniswap/v4-core (PoolKey, PoolOperation, BalanceDelta)
// and github.com/Uniswap/v4-periphery (IV4Quoter). Addresses are pinned by the fixture.
struct V4Key { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct V4Liquidity { int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; }
struct V4Swap { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface IV4Manager {
    function initialize(V4Key memory, uint160) external returns (int24);
    function unlock(bytes calldata) external returns (bytes memory);
    function modifyLiquidity(V4Key memory, V4Liquidity memory, bytes calldata) external returns (int256, int256);
    function swap(V4Key memory, V4Swap memory, bytes calldata) external returns (int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address, address, uint256) external;
}
interface IV4Quote {
    struct Params { V4Key poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }
    function quoteExactInputSingle(Params memory) external returns (uint256, uint256);
}
interface IV4Token { function transferFrom(address,address,uint256) external returns (bool); }

/// @notice Local fork acceptance adapter, not an audited production router.
/// One immutable ERC20 pair, no hooks, one seeded full-range position.
/// Exposes the market's exact-input interface over the deployed v4 core/quoter.
contract RobinhoodV4Router {
    IV4Manager public immutable manager;
    IV4Quote public immutable quoter;
    address public immutable payment;
    address public immutable thot;
    address public immutable operator;
    bool public seeded;
    bool private entered;
    uint160 private constant MIN_PRICE = 4295128739;
    uint160 private constant MAX_PRICE = 1461446703485210103287273052203988822378723970342;

    constructor(address m,address q,address p,address w) {
        require(m.code.length>0 && q.code.length>0 && p.code.length>0 && w.code.length>0 && p!=w,"BAD_CONFIG");
        manager=IV4Manager(m); quoter=IV4Quote(q); payment=p; thot=w; operator=msg.sender;
    }
    modifier guarded() { require(!entered,"REENTRANT"); entered=true; _; entered=false; }
    function key() public view returns(V4Key memory) {
        return V4Key(payment<thot?payment:thot,payment<thot?thot:payment,3000,60,address(0));
    }
    function poolId() external view returns(bytes32) { return keccak256(abi.encode(key())); }
    function seed(uint160 price,uint128 liquidity) external guarded {
        require(msg.sender==operator && !seeded && liquidity>0,"SEED_DENIED"); seeded=true;
        manager.initialize(key(),price);
        manager.unlock(abi.encode(true,msg.sender,address(0),uint256(liquidity),uint256(0)));
    }
    // Deliberately non-view: Uniswap's quoter simulates and reverts a swap.
    // The backend invokes this using eth_call, so no transaction or state change is needed.
    function getAmountsOut(uint256 amount,address[] calldata path) external guarded returns(uint256[] memory amounts) {
        require(seeded && amount>0 && amount<=uint256(uint128(type(int128).max)),"BAD_AMOUNT");
        checkPath(path);
        (uint256 out,)=quoter.quoteExactInputSingle(IV4Quote.Params(key(),payment<thot,uint128(amount),""));
        amounts=new uint256[](2); amounts[0]=amount; amounts[1]=out;
    }
    function swapExactTokensForTokens(uint256 amount,uint256 minimum,address[] calldata path,address to,uint256 deadline)
        external guarded returns(uint256[] memory amounts)
    {
        require(seeded && block.timestamp<=deadline && to!=address(0),"BAD_SWAP");
        require(amount>0 && amount<=uint256(uint128(type(int128).max)) && minimum>0,"BAD_AMOUNT");
        checkPath(path);
        uint256 out=abi.decode(manager.unlock(abi.encode(false,msg.sender,to,amount,minimum)),(uint256));
        amounts=new uint256[](2); amounts[0]=amount; amounts[1]=out;
    }
    function checkPath(address[] calldata path) private view {
        require(path.length==2 && path[0]==payment && path[1]==thot,"BAD_PATH");
    }
    function pay(address currency,address payer,uint256 amount) private {
        manager.sync(currency);
        require(IV4Token(currency).transferFrom(payer,address(manager),amount),"TRANSFER_FAILED");
        require(manager.settle()==amount,"INEXACT_PAYMENT");
    }
    function unlockCallback(bytes calldata data) external returns(bytes memory) {
        require(msg.sender==address(manager) && entered,"CALLBACK_DENIED");
        (bool seedMode,address payer,address to,uint256 amount,uint256 minimum)=abi.decode(data,(bool,address,address,uint256,uint256));
        V4Key memory k=key();
        if(seedMode) {
            (int256 delta,)=manager.modifyLiquidity(k,V4Liquidity(-887220,887220,int256(amount),bytes32(0)),"");
            int256 d0=int128(delta>>128); int256 d1=int128(delta);
            require(d0<0 && d1<0,"BAD_LIQUIDITY");
            pay(k.currency0,payer,uint256(-d0)); pay(k.currency1,payer,uint256(-d1));
            return "";
        }
        bool zeroForOne=payment<thot;
        int256 delta=manager.swap(k,V4Swap(zeroForOne,-int256(amount),zeroForOne?MIN_PRICE+1:MAX_PRICE-1),"");
        int256 input=zeroForOne?int128(delta>>128):int128(delta);
        int256 output=zeroForOne?int128(delta):int128(delta>>128);
        require(input==-int256(amount) && output>0 && uint256(output)>=minimum,"SLIPPAGE_OR_PARTIAL_INPUT");
        pay(payment,payer,amount); manager.take(thot,to,uint256(output));
        return abi.encode(uint256(output));
    }
}
