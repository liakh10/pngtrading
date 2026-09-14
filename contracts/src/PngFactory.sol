// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IPngMarket {
    function initialize(address creator, string calldata name, string calldata symbol, string calldata art, uint256 base, uint256 supply, uint256 target) external;
}

/// @title PNG Trading factory
/// @notice Anyone can create a collection. Each one is an EIP-1167 clone of a single PngMarket
/// implementation, so every market runs exactly the same audited-once code. No owner, no fees, no upgrades.
contract PngFactory {
    address public immutable implementation;
    address[] public markets;
    mapping(address => bool) public isMarket;

    event MarketCreated(address indexed market, address indexed creator, string name, string symbol, string art, uint256 base, uint256 supply, uint256 target);

    error CloneFailed();
    error BadName();

    constructor(address implementation_) {
        implementation = implementation_;
    }

    function create(string calldata name, string calldata symbol, string calldata art, uint256 base, uint256 supply, uint256 target) external returns (address market) {
        if (bytes(name).length < 2 || bytes(name).length > 32 || bytes(symbol).length < 2 || bytes(symbol).length > 10 || bytes(art).length > 256) revert BadName();
        market = _clone(implementation);
        IPngMarket(market).initialize(msg.sender, name, symbol, art, base, supply, target);
        markets.push(market);
        isMarket[market] = true;
        emit MarketCreated(market, msg.sender, name, symbol, art, base, supply, target);
    }

    function count() external view returns (uint256) {
        return markets.length;
    }

    function list(uint256 from, uint256 max) external view returns (address[] memory out) {
        uint256 n = markets.length;
        if (from >= n) return new address[](0);
        uint256 end = from + max > n ? n : from + max;
        out = new address[](end - from);
        for (uint256 i = from; i < end; ++i) out[i - from] = markets[i];
    }

    /// @dev EIP-1167 minimal proxy
    function _clone(address impl) private returns (address instance) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        if (instance == address(0)) revert CloneFailed();
    }
}
