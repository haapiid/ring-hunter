// Read-only contract risk analysis. Each finding gets an evidence level:
// STATIC (bytecode), ONCHAIN_STATE (current state), TX_EVIDENCE (transactions/logs), NOT_CHECKED.
import { id as keccakId, getAddress } from 'ethers';
import { OWNABLE } from '../adapters/evm/abis.js';

const ZERO = '0x0000000000000000000000000000000000000000';

// EIP-1967 slots (keccak256('eip1967.proxy.*') - 1).
export const EIP1967 = Object.freeze({
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
});

/**
 * Risky function groups. severity = contribution to the contractPrivileges component (0..100, capped).
 * ownerGated = usually owner-restricted; if the owner is already 0x0 the weight is reduced (cannot be confirmed from bytecode).
 */
export const RISK_SIGNATURES = Object.freeze([
  { id: 'MINT', title: 'Mint function', severity: 30, ownerGated: true, sigs: ['mint(address,uint256)', 'mint(uint256)', 'mintTo(address,uint256)', 'mint(address)'] },
  { id: 'PAUSE', title: 'Transfers can be paused', severity: 20, ownerGated: true, sigs: ['pause()', 'unpause()', 'setPaused(bool)'] },
  {
    id: 'BLACKLIST',
    title: 'Blacklist / address blocking',
    severity: 25,
    ownerGated: true,
    sigs: ['blacklist(address)', 'addToBlacklist(address)', 'setBlacklist(address,bool)', 'addBlacklist(address)', 'blacklistAddress(address,bool)', 'setBots(address[],bool)', 'setBot(address,bool)', 'blockBots(address[])', 'isBlacklisted(address)'],
  },
  { id: 'WHITELIST', title: 'Special whitelist', severity: 10, ownerGated: true, sigs: ['setWhitelist(address,bool)', 'addToWhitelist(address)', 'excludeFromFee(address)', 'setExcludedFromFees(address,bool)'] },
  {
    id: 'FEE_SETTER',
    title: 'Fee/tax can be changed',
    severity: 20,
    ownerGated: true,
    sigs: ['setFee(uint256)', 'setFees(uint256,uint256)', 'setTaxFee(uint256)', 'setBuyFee(uint256)', 'setSellFee(uint256)', 'setTax(uint256)', 'updateFees(uint256,uint256)', 'setBuyTax(uint256)', 'setSellTax(uint256)', 'updateBuyFees(uint256,uint256,uint256)', 'updateSellFees(uint256,uint256,uint256)'],
  },
  { id: 'LIMITS', title: 'Max transaction / max wallet', severity: 10, ownerGated: true, sigs: ['setMaxTxAmount(uint256)', 'setMaxWallet(uint256)', 'setMaxWalletSize(uint256)', 'removeLimits()', 'setMaxTxPercent(uint256)'] },
  { id: 'TRADING_TOGGLE', title: 'Trading can be enabled/disabled', severity: 15, ownerGated: true, sigs: ['enableTrading()', 'openTrading()', 'setTradingEnabled(bool)', 'setTrading(bool)', 'startTrading()'] },
  { id: 'RESCUE', title: 'Withdraw/rescue function', severity: 10, ownerGated: true, sigs: ['withdraw()', 'rescueTokens(address,uint256)', 'withdrawToken(address,uint256)', 'emergencyWithdraw()', 'rescueETH()', 'clearStuckBalance()'] },
  { id: 'UPGRADE_FN', title: 'Upgrade function (UUPS)', severity: 25, ownerGated: true, sigs: ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)'] },
  { id: 'ACCESS_CONTROL', title: 'AccessControl-based roles', severity: 15, ownerGated: false, sigs: ['grantRole(bytes32,address)'] },
  { id: 'OWNERSHIP', title: 'Ownership can be transferred', severity: 0, ownerGated: false, sigs: ['transferOwnership(address)', 'renounceOwnership()'] },
]);

const selectorOf = (sig) => keccakId(sig).slice(2, 10);

/** Find selectors that appear as PUSH4 in the bytecode (pure function). */
export function scanSelectors(code) {
  const hexCode = (code || '').toLowerCase().replace(/^0x/, '');
  const found = [];
  for (const group of RISK_SIGNATURES) {
    const matched = group.sigs.filter((s) => hexCode.includes('63' + selectorOf(s)));
    if (matched.length) found.push({ ...group, matched });
  }
  return found;
}

/** EIP-1167 minimal proxy: 363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3 */
export function detectMinimalProxy(code) {
  const m = (code || '').toLowerCase().match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
  return m ? getAddress('0x' + m[1]) : null;
}

const slotToAddr = (v) => (v && v !== '0x' && BigInt(v) !== 0n ? getAddress('0x' + v.slice(-40)) : null);

async function readAddressCall(rpc, to, fn) {
  try {
    const raw = await rpc.call(to, OWNABLE.encodeFunctionData(fn));
    if (!raw || raw === '0x') return { status: 'NOT_AVAILABLE' };
    return { status: 'OK', value: getAddress(OWNABLE.decodeFunctionResult(fn, raw)[0]) };
  } catch {
    return { status: 'NOT_AVAILABLE' };
  }
}

/**
 * @param {{rpc:any, address:string, code:string, launch:object|null, tradeStats?:{buys:number,sells:number}}} p
 */
export async function analyzeContract({ rpc, address, code, launch = null, tradeStats = null }) {
  const findings = [];
  const checks = [];
  const add = (f) => findings.push(f);

  // 1) Proxy.
  let implementation = null;
  let proxyType = null;
  const minimal = detectMinimalProxy(code);
  if (minimal) {
    implementation = minimal;
    proxyType = 'EIP-1167 (minimal proxy, not upgradeable)';
  }
  try {
    const [impl, admin, beacon] = await Promise.all([rpc.getStorageAt(address, EIP1967.implementation), rpc.getStorageAt(address, EIP1967.admin), rpc.getStorageAt(address, EIP1967.beacon)]);
    const implAddr = slotToAddr(impl);
    const beaconAddr = slotToAddr(beacon);
    if (implAddr || beaconAddr) {
      implementation = implAddr ?? implementation;
      proxyType = beaconAddr ? 'EIP-1967 beacon proxy' : 'EIP-1967 proxy';
      add({
        id: 'UPGRADEABLE_PROXY',
        title: 'Upgradeable contract (proxy)',
        level: 'ONCHAIN_STATE',
        severity: 35,
        detail: `${proxyType}; implementation ${implAddr ?? '-'}${slotToAddr(admin) ? `, admin ${slotToAddr(admin)}` : ''}${beaconAddr ? `, beacon ${beaconAddr}` : ''}. Token logic can be replaced.`,
      });
    }
    checks.push({ id: 'EIP1967_SLOTS', status: 'CHECKED' });
  } catch {
    checks.push({ id: 'EIP1967_SLOTS', status: 'NOT_CHECKED', reason: 'eth_getStorageAt failed' });
  }

  // 2) Selector scan on the token code + implementation (if proxy).
  const codes = [{ where: 'token', code }];
  if (implementation) {
    try {
      const implCode = await rpc.getCode(implementation);
      if (implCode && implCode !== '0x') codes.push({ where: 'implementation', code: implCode });
    } catch {
      checks.push({ id: 'IMPLEMENTATION_CODE', status: 'NOT_CHECKED', reason: 'failed to fetch implementation code' });
    }
  }
  const selectorHits = new Map();
  for (const c of codes) for (const hit of scanSelectors(c.code)) if (!selectorHits.has(hit.id)) selectorHits.set(hit.id, { ...hit, where: c.where });
  checks.push({ id: 'SELECTOR_SCAN', status: 'CHECKED', note: 'A selector in the bytecode = the capability exists, not necessarily callable by anyone.' });

  // 3) State: owner / paused.
  const owner = await readAddressCall(rpc, address, 'owner');
  const getOwner = owner.status === 'OK' ? owner : await readAddressCall(rpc, address, 'getOwner');
  const ownerAddr = getOwner.status === 'OK' ? getOwner.value : null;
  const ownerRenounced = ownerAddr === ZERO;
  const ownerActive = ownerAddr != null && !ownerRenounced;
  checks.push({ id: 'OWNER', status: getOwner.status === 'OK' ? 'CHECKED' : 'NOT_AVAILABLE', note: getOwner.status === 'OK' ? null : 'owner()/getOwner() unavailable (does not mean there is no admin)' });
  if (ownerActive) add({ id: 'OWNER_ACTIVE', title: 'Active owner', level: 'ONCHAIN_STATE', severity: 10, detail: `owner() = ${ownerAddr}. The owner is not automatically the creator.` });

  let paused = null;
  try {
    const raw = await rpc.call(address, OWNABLE.encodeFunctionData('paused'));
    if (raw && raw !== '0x') paused = OWNABLE.decodeFunctionResult('paused', raw)[0];
  } catch {
    /* unavailable */
  }
  if (paused === true) add({ id: 'CURRENTLY_PAUSED', title: 'Transfers are currently paused', level: 'ONCHAIN_STATE', severity: 40, detail: 'paused() = true right now.' });

  for (const hit of selectorHits.values()) {
    if (hit.severity === 0) continue;
    // Owner renounced & no AccessControl → owner-gated functions are probably not callable.
    const reduce = hit.ownerGated && ownerRenounced && !selectorHits.has('ACCESS_CONTROL');
    add({
      id: hit.id,
      title: hit.title,
      level: 'STATIC',
      severity: reduce ? Math.round(hit.severity / 2) : hit.severity,
      detail: `Selector found in ${hit.where}: ${hit.matched.join(', ')}.${reduce ? ' Owner = 0x0, so it is probably not callable, but this cannot be confirmed from bytecode.' : ''}`,
    });
  }

  // 4) Honeypot indication from trade patterns (not proof).
  if (tradeStats && tradeStats.buys >= 10 && tradeStats.sells === 0) {
    add({ id: 'NO_SELLS_OBSERVED', title: 'No sells observed', level: 'TX_EVIDENCE', severity: 25, detail: `${tradeStats.buys} buys and 0 sells in the early transaction sample. This is an indication, not proof of a honeypot.` });
  }
  checks.push({ id: 'HONEYPOT_SIMULATION', status: 'NOT_CHECKED', reason: 'A sell simulation requires a fork/account and is not performed (read-only).' });

  const positives = [];
  if (launch?.protocol === 'PONS_V2') positives.push('Token is registered as a launch in the Pons v2 Factory (not a direct custom deployment).');
  if (ownerRenounced) positives.push('owner() = 0x0 (renounced). This does not guarantee safety — other privileges may still exist.');
  if (!selectorHits.size && !findings.some((f) => f.id === 'UPGRADEABLE_PROXY')) positives.push('No common privilege selectors found in the bytecode (heuristic check).');
  if (tradeStats && tradeStats.sells > 0) positives.push(`${tradeStats.sells} sells observed in the early transaction sample.`);

  const score = Math.min(100, findings.reduce((s, f) => s + f.severity, 0));
  return {
    owner: ownerAddr,
    ownerStatus: ownerAddr == null ? 'UNKNOWN' : ownerRenounced ? 'RENOUNCED' : 'ACTIVE',
    paused,
    proxy: proxyType ? { type: proxyType, implementation } : null,
    findings: findings.sort((a, b) => b.severity - a.severity),
    positives,
    checks,
    score,
  };
}
