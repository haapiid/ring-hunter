// SYNTHETIC FIXTURE (synthetic: true) — a fake Pons token scenario for integration tests.
// No real addresses/transactions. Scenario:
//  - Deployer D launches token T via the Pons Factory (synthetic TokenLaunched event) with curve CV.
//  - Funder F (a regular wallet) funds B1 & B2 with similar amounts, shortly before they buy.
//  - Exchange EX (very high nonce) funds B3 & B4 → must be EXCLUDED as a cluster source.
//  - B1, B2 buy in nearby blocks; B1 then sends tokens to D (consolidation).
//  - B5 has no links at all.
import { A, H, createMockChain, createMockExplorer, nativeTx } from '../helpers/mockChain.js';
import { PONS, UNISWAP_V4 } from '../../src/config/networks.js';

export const synthetic = true;

export const ADDR = {
  T: A(0xa0001),
  CV: A(0xa0002),
  D: A(0xd0001),
  F: A(0xf0001),
  EX: A(0xe0001),
  B1: A(0xb0001),
  B2: A(0xb0002),
  B3: A(0xb0003),
  B4: A(0xb0004),
  B5: A(0xb0005),
  ROUTER: A(0xc0001),
};

export const E18 = 10n ** 18n;
export const SUPPLY = 1_000_000_000n * E18;
const LAUNCH_BLOCK = 900_000;

export function buildPonsScenario({ chainId = 4663, withOwnerMint = false } = {}) {
  const chain = createMockChain({ chainId, latestBlock: 1_000_000 });
  const { T, CV, D, F, EX, B1, B2, B3, B4, B5, ROUTER } = ADDR;
  const { PONS_FACTORY, PONS_CURVE } = chain.ifaces;

  chain.setCode(PONS.factory);
  chain.setCode(CV);
  chain.setCode(ROUTER);
  chain.setCode(UNISWAP_V4.poolManager);
  chain.setNonce(EX, 250_000); // exchange hot wallet pattern

  // Synthetic token bytecode: contains the mint(address,uint256) selector (40c10f19) if withOwnerMint.
  const code = withOwnerMint ? '0x6080604052' + '6340c10f19' + '00' : '0x608060405260';
  chain.setCode(T, code);
  if (withOwnerMint) chain.owner(T, D);

  const launchTx = H(0x1001);
  chain.addLog({ address: PONS.factory, iface: PONS_FACTORY, event: 'TokenLaunched', args: [T, CV, D, A(0), 0n, 4n * E18], blockNumber: LAUNCH_BLOCK, txHash: launchTx, from: D, logIndex: 1 });
  chain.transfer(T, A(0), CV, SUPPLY, LAUNCH_BLOCK, { txHash: launchTx, from: D, logIndex: 0 });

  // Curve trades: token transfer from the curve to the buyer + CurveBuy event (buyer = router).
  let li = 10;
  const buy = (who, amount, block, n) => {
    const tx = H(0x2000 + n);
    chain.transfer(T, CV, who, amount, block, { txHash: tx, from: who, to: ROUTER, logIndex: li++ });
    chain.addLog({ address: CV, iface: PONS_CURVE, event: 'CurveBuy', args: [ROUTER, who, E18 / 100n, amount, 0n, 0n], blockNumber: block, txHash: tx, from: who, to: ROUTER, logIndex: li++ });
  };
  buy(D, 50_000_000n * E18, LAUNCH_BLOCK, 0); // dev buy at launch
  buy(B1, 30_000_000n * E18, LAUNCH_BLOCK + 1, 1);
  buy(B2, 30_000_000n * E18, LAUNCH_BLOCK + 2, 2);
  buy(B3, 10_000_000n * E18, LAUNCH_BLOCK + 50, 3);
  buy(B4, 10_000_000n * E18, LAUNCH_BLOCK + 400, 4);
  buy(B5, 5_000_000n * E18, LAUNCH_BLOCK + 900, 5);

  // B1 sends part of its tokens to the deployer (consolidation).
  chain.transfer(T, B1, D, 10_000_000n * E18, LAUNCH_BLOCK + 1000, { txHash: H(0x3001), from: B1, logIndex: li++ });

  const bal = {
    [CV]: SUPPLY - 135_000_000n * E18,
    [D]: 60_000_000n * E18,
    [B1]: 20_000_000n * E18,
    [B2]: 30_000_000n * E18,
    [B3]: 10_000_000n * E18,
    [B4]: 10_000_000n * E18,
    [B5]: 5_000_000n * E18,
  };
  chain.erc20(T, { name: 'Synthetic Ring Token', symbol: 'SRING', totalSupply: SUPPLY, balanceOf: bal });

  const explorer = createMockExplorer({
    [B1]: [nativeTx(1, F, B1, 0.5, LAUNCH_BLOCK - 100)],
    [B2]: [nativeTx(2, F, B2, 0.52, LAUNCH_BLOCK - 90)],
    [B3]: [nativeTx(3, EX, B3, 1.0, LAUNCH_BLOCK - 2000)],
    [B4]: [nativeTx(4, EX, B4, 1.0, LAUNCH_BLOCK - 3000)],
    [B5]: [],
    [D]: [],
  });
  return { chain, explorer, ADDR, LAUNCH_BLOCK };
}
