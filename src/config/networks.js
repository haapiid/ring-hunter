// Network and contract definitions that HAVE BEEN verified.
// Rule: an address may only be added if (1) there is an official/trusted source, (2) bytecode exists on-chain,
// and (3) for events, topic0 matches real logs. Record the source and verification date.

export const ROBINHOOD_MAINNET = Object.freeze({
  key: 'robinhood-mainnet',
  name: 'Robinhood Chain',
  chainId: 4663,
  nativeSymbol: 'ETH',
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  explorerApiBase: 'https://api.blockscout.com/v2/api',
  verification: {
    chainId: 'eth_chainId = 0x1237 from rpc.mainnet.chain.robinhood.com; matches Alchemy/Chainstack/GetBlock (2026-10-27)',
    explorer: 'docs.blockscout.com/robinhood-api: Blockscout is the official explorer; the PRO API needs a key (checked: rejected without a key)',
    rpcLimits: 'Tested 2026-10-27: getLogs max 10,000,000 blocks & 10,000 logs; not an archive node; debug_/trace_ unavailable',
  },
  // Testnet (46630) is deliberately unsupported: different network, Pons addresses differ/unknown.
});

/**
 * Protocol contracts verified on chain 4663.
 * kind is used for labeling & excluding infrastructure addresses from insider detection.
 */
export const VERIFIED_CONTRACTS = Object.freeze([
  {
    address: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    label: 'Pons v2 Factory',
    kind: 'PROTOCOL',
    source: 'docs.ponsfamily.com/v2 (Deployed addresses)',
    verifiedAt: '2026-10-27',
    evidence: 'bytecode present; TokenLaunched topic0 matches real logs',
  },
  {
    address: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
    label: 'Pons v2 Meme Hook (Uniswap V4)',
    kind: 'PROTOCOL',
    source: 'docs.ponsfamily.com/v2',
    verifiedAt: '2026-10-27',
    evidence: 'bytecode present; used as hooks in PoolManager Initialize events',
  },
  {
    address: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
    label: 'Pons v2 Fee Escrow',
    kind: 'PROTOCOL',
    source: 'docs.ponsfamily.com/v2',
    verifiedAt: '2026-10-27',
    evidence: 'address from the official documentation',
  },
  {
    address: '0x42df2a798f82289E177311362e8f5ccC45c1219c',
    label: 'Pons v2 Buyback Vault',
    kind: 'PROTOCOL',
    source: 'docs.ponsfamily.com/v2',
    verifiedAt: '2026-10-27',
    evidence: 'address from the official documentation',
  },
  {
    address: '0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952',
    label: 'Pons v2 Launch Locker',
    kind: 'PROTOCOL',
    source: 'docs.ponsfamily.com/v2',
    verifiedAt: '2026-10-27',
    evidence: 'address from the official documentation',
  },
  {
    address: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
    label: 'Pons v2 Launch & Buy Router',
    kind: 'ROUTER',
    source: 'docs.ponsfamily.com/v2',
    verifiedAt: '2026-10-27',
    evidence: 'tx.to of a real TokenLaunched transaction',
  },
  {
    address: '0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42',
    label: 'Pons v2 Launch Deployer',
    kind: 'PROTOCOL',
    source: 'docs.ponsfamily.com/v2',
    verifiedAt: '2026-10-27',
    evidence: 'address from the official documentation',
  },
  {
    address: '0xC7819B64A1dAECD7eC19856d026cb14EfBd89046',
    label: 'Pons v2 Graduation Executor',
    kind: 'PROTOCOL',
    source: 'docs.ponsfamily.com/v2',
    verifiedAt: '2026-10-27',
    evidence: 'address from the official documentation',
  },
  {
    address: '0xf5695117b99B6f6401e67d4195BD653628176C6C',
    label: 'Pons v2 Graduation Guard',
    kind: 'PROTOCOL',
    source: 'docs.ponsfamily.com/v2',
    verifiedAt: '2026-10-27',
    evidence: 'address from the official documentation',
  },
  {
    address: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    label: 'Uniswap V4 PoolManager',
    kind: 'DEX',
    source: 'On-chain verification + the uniswap-v4-robinhood Substreams package',
    verifiedAt: '2026-10-27',
    evidence:
      'bytecode present; Initialize & Swap topic0 (canonical V4 ABI) match; Pons-hooked pools found. The canonical address 0x000000000004444c… has NO bytecode on chain 4663',
  },
  {
    address: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
    label: 'Uniswap V3 Factory',
    kind: 'DEX',
    source: 'docs.uniswap.org v3 deployments (Uniswap/docs v3-robinhood-chain-deployments.mdx)',
    verifiedAt: '2026-11-02',
    evidence: 'bytecode present; PoolCreated topic0 matches real logs; Swap topic0 seen on pools whose factory() is this address',
  },
  {
    address: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
    label: 'Uniswap V2 Factory',
    kind: 'DEX',
    source: 'docs.uniswap.org v2 deployments (Uniswap/docs v2/deployments.mdx)',
    verifiedAt: '2026-11-02',
    evidence: 'bytecode present; PairCreated topic0 matches real logs; Swap topic0 seen on pairs whose factory() is this address',
  },
]);

export const SPECIAL_ADDRESSES = Object.freeze([
  { address: '0x0000000000000000000000000000000000000000', label: 'Zero address', kind: 'BURN' },
  { address: '0x000000000000000000000000000000000000dEaD', label: 'Dead address', kind: 'BURN' },
]);

export const PONS = Object.freeze({
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  memeHook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
});

export const UNISWAP_V4 = Object.freeze({
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
});

// Uniswap V2/V3 on Robinhood Chain — verified 2026-11-02: (1) address from the official Uniswap deployment docs,
// (2) bytecode present on chain 4663, (3) PairCreated/PoolCreated topic0 matched against real factory logs,
// (4) Swap topic0 matched against real logs of pools whose factory() is this address.
const VERIFIED_ON = '2026-11-02';

/**
 * A DEX deployment. kind: 'v2' (pair contracts, PairCreated/Swap), 'v3' (pool contracts, PoolCreated/Swap),
 * 'v4' (singleton PoolManager, Initialize/Swap).
 */
function dex(d) {
  return Object.freeze({ verifiedAt: VERIFIED_ON, ...d });
}

export const UNISWAP_V2 = Object.freeze({ factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f' });

/** Uniswap V3 on Robinhood Chain — published by Uniswap (v3-robinhood-chain-deployments); verified on-chain 2026-11-02. */
export const UNISWAP_V3 = Object.freeze({ status: 'VERIFIED', factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' });

/** The network RING-HUNTER scans (Robinhood Chain only — user decision 2026-11-02). */
export const NETWORK = Object.freeze({
  ...ROBINHOOD_MAINNET,
  key: 'robinhood',
  rpcEnv: 'ROBINHOOD_CHAIN_RPC',
  defaultRpc: 'https://rpc.mainnet.chain.robinhood.com',
  launchpads: ['Pons v2'],
  protocols: Object.freeze({ pons: PONS, uniswapV4: UNISWAP_V4, uniswapV3: UNISWAP_V3, uniswapV2: UNISWAP_V2 }),
  dexes: Object.freeze([
    dex({ id: 'UNISWAP_V4', label: 'Uniswap V4', kind: 'v4', poolManager: UNISWAP_V4.poolManager, source: 'docs.uniswap.org/contracts/v4/deployments' }),
    dex({ id: 'UNISWAP_V3', label: 'Uniswap V3', kind: 'v3', factory: UNISWAP_V3.factory, source: 'docs.uniswap.org v3 deployments (v3-robinhood-chain-deployments)' }),
    dex({ id: 'UNISWAP_V2', label: 'Uniswap V2', kind: 'v2', factory: UNISWAP_V2.factory, source: 'docs.uniswap.org v2 deployments' }),
  ]),
  verifiedContracts: VERIFIED_CONTRACTS,
});

/** Infrastructure labels: verified contracts plus burn addresses. */
export function networkLabels() {
  return [...VERIFIED_CONTRACTS, ...SPECIAL_ADDRESSES];
}
