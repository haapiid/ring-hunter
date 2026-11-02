// Read-only ERC-20 token metadata reading. Each field has a status so data that
// fails to read is not filled with assumptions.
import { decodeBytes32String, getAddress } from 'ethers';
import { ERC20, ERC20_BYTES32 } from './abis.js';

async function tryCall(rpc, to, iface, fn, args = []) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await rpc.call(to, data);
    if (!raw || raw === '0x') return { ok: false, error: 'empty response' };
    return { ok: true, value: iface.decodeFunctionResult(fn, raw)[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readString(rpc, address, fn) {
  const r = await tryCall(rpc, address, ERC20, fn);
  if (r.ok) return { value: String(r.value).slice(0, 80), status: 'ok' };
  const b = await tryCall(rpc, address, ERC20_BYTES32, fn);
  if (b.ok) {
    try {
      return { value: decodeBytes32String(b.value).slice(0, 80), status: 'ok' };
    } catch {
      /* fall through to the failed status */
    }
  }
  return { value: null, status: 'unavailable', error: r.error };
}

/**
 * @returns {Promise<{address:string, isContract:boolean, codeSize:number, code:string, name, symbol, decimals, totalSupply, isErc20Like:boolean, warnings:string[]}>}
 */
export async function readTokenInfo(rpc, address) {
  const code = await rpc.getCode(address);
  const codeSize = code && code !== '0x' ? (code.length - 2) / 2 : 0;
  const base = { address: getAddress(address), isContract: codeSize > 0, codeSize, code: codeSize > 0 ? code : '0x', warnings: [] };
  if (!base.isContract) return { ...base, name: null, symbol: null, decimals: null, totalSupply: null, isErc20Like: false };

  const [name, symbol, dec, supply] = await Promise.all([
    readString(rpc, address, 'name'),
    readString(rpc, address, 'symbol'),
    tryCall(rpc, address, ERC20, 'decimals'),
    tryCall(rpc, address, ERC20, 'totalSupply'),
  ]);
  const decimals = dec.ok ? Number(dec.value) : null;
  const totalSupply = supply.ok ? BigInt(supply.value) : null;
  const warnings = [];
  if (decimals == null) warnings.push('decimals() could not be read');
  if (totalSupply == null) warnings.push('totalSupply() could not be read');
  if (decimals != null && decimals > 36) warnings.push(`unusual decimals (${decimals})`);
  return {
    ...base,
    name: name.value,
    symbol: symbol.value,
    decimals,
    totalSupply,
    isErc20Like: decimals != null && totalSupply != null,
    warnings,
  };
}

/** Token balance at the latest block (the RPC is not an archive node, so historical balances are not fetched here). */
export async function readBalance(rpc, token, holder) {
  const r = await tryCall(rpc, token, ERC20, 'balanceOf', [holder]);
  return r.ok ? BigInt(r.value) : null;
}
