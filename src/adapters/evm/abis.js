// ABIs used by the scanner. The topic0 of every event below has been matched against real logs
// (Pons & Uniswap V4 on Robinhood Chain 2026-10-27; V2/V3 on all supported chains 2026-11-02). Do not add events without similar verification.
import { Interface } from 'ethers';

export const ERC20 = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

// Some old tokens return name/symbol as bytes32.
export const ERC20_BYTES32 = new Interface(['function name() view returns (bytes32)', 'function symbol() view returns (bytes32)']);

export const OWNABLE = new Interface([
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function paused() view returns (bool)',
]);

export const PONS_FACTORY = new Interface([
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
]);

export const PONS_CURVE = new Interface([
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
]);

export const V4_POOL_MANAGER = new Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);

// Uniswap V2 / V3. topic0 matched against real logs on Robinhood Chain (2026-11-02) — on pools whose factory()
// is the verified factory.
export const V2_FACTORY = new Interface(['event PairCreated(address indexed token0, address indexed token1, address pair, uint256)']);
export const V2_PAIR = new Interface([
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
]);
export const V3_FACTORY = new Interface(['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)']);
export const V3_POOL = new Interface([
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);

export const TOPICS = Object.freeze({
  Transfer: ERC20.getEvent('Transfer').topicHash,
  TokenLaunched: PONS_FACTORY.getEvent('TokenLaunched').topicHash,
  CurveBuy: PONS_CURVE.getEvent('CurveBuy').topicHash,
  CurveSell: PONS_CURVE.getEvent('CurveSell').topicHash,
  Initialize: V4_POOL_MANAGER.getEvent('Initialize').topicHash,
  Swap: V4_POOL_MANAGER.getEvent('Swap').topicHash,
  PairCreated: V2_FACTORY.getEvent('PairCreated').topicHash,
  V2Swap: V2_PAIR.getEvent('Swap').topicHash,
  PoolCreated: V3_FACTORY.getEvent('PoolCreated').topicHash,
  V3Swap: V3_POOL.getEvent('Swap').topicHash,
  OwnershipTransferred: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0',
});

/** Encode an address into a 32-byte topic. */
export const addrTopic = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** Decode an address from a 32-byte topic. */
export const topicAddr = (t) => '0x' + t.slice(-40);
