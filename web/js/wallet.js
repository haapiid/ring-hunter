// Connect wallet. Methods used:
//   eth_requestAccounts / eth_accounts (address), eth_chainId, eth_getBalance (balance),
//   wallet_switchEthereumChain / wallet_addEthereumChain (on user click, to switch to Robinhood Chain).
// The ONLY signature is the optional account sign-in (signIn below): a plain-text Sign-In with Ethereum
// (EIP-4361) message, checked to be bound to this site's domain, the connected address, and chain 4663.
// No transactions, no typed-data signatures, no token approvals, no seed phrase requests.
// Wallet discovery via EIP-6963 (multiple wallets at once) with a window.ethereum fallback.

export const ROBINHOOD_CHAIN = {
  chainId: '0x1237', // 4663 — same as src/config/networks.js
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
};
const ALLOWED = new Set(['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'eth_getBalance', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']);

const providers = new Map(); // uuid → { info, provider }
const state = { entry: null, address: null, chainId: null, balance: null };

window.addEventListener('eip6963:announceProvider', (e) => {
  const { info, provider } = e.detail || {};
  if (info?.uuid && provider) providers.set(info.uuid, { info, provider });
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

function list() {
  const out = [...providers.values()];
  if (!out.length && window.ethereum) out.push({ info: { uuid: 'injected', name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: null }, provider: window.ethereum });
  return out;
}

/** Every request goes through here — methods outside the read allowlist are rejected. */
function call(method, params) {
  if (!ALLOWED.has(method)) throw new Error(`Method ${method} is not allowed (this page is read-only)`);
  return state.entry.provider.request(params ? { method, params } : { method });
}

const emit = () => window.dispatchEvent(new CustomEvent('walletchange', { detail: { ...state, connected: !!state.address } }));

async function refresh() {
  if (!state.entry) return;
  const [accounts, chainId] = await Promise.all([call('eth_accounts'), call('eth_chainId')]);
  state.address = accounts?.[0] ?? null;
  state.chainId = chainId ? parseInt(chainId, 16) : null;
  state.balance = null;
  if (state.address && state.chainId === 4663) {
    try {
      const wei = BigInt(await call('eth_getBalance', [state.address, 'latest']));
      state.balance = Number(wei / 10n ** 12n) / 1e6;
    } catch {}
  }
  emit();
}

export async function connect(entry) {
  state.entry = entry;
  await call('eth_requestAccounts');
  const p = entry.provider;
  p.removeListener?.('accountsChanged', refresh);
  p.removeListener?.('chainChanged', refresh);
  p.on?.('accountsChanged', refresh);
  p.on?.('chainChanged', refresh);
  await refresh();
}

/** Forget the connection on this page (permissions are still managed in your wallet). */
export function disconnect() {
  state.entry?.provider.removeListener?.('accountsChanged', refresh);
  state.entry?.provider.removeListener?.('chainChanged', refresh);
  Object.assign(state, { entry: null, address: null, chainId: null, balance: null });
  emit();
}

export async function switchToRobinhood() {
  try {
    await call('wallet_switchEthereumChain', [{ chainId: ROBINHOOD_CHAIN.chainId }]);
  } catch (e) {
    // 4902 = network unknown to the wallet → offer to add it.
    if (e?.code === 4902 || e?.data?.originalError?.code === 4902) await call('wallet_addEthereumChain', [ROBINHOOD_CHAIN]);
    else throw e;
  }
  await refresh();
}

/**
 * Sign the account sign-in message (account page only). Refuses anything that is not a SIWE message for this
 * site's domain and the connected address — so this function can never be used to sign other content.
 */
export async function signIn(message) {
  const addr = state.address;
  if (!state.entry || !addr) throw new Error('Connect a wallet first.');
  const lines = String(message).split('\n');
  const ok =
    lines[0] === `${location.host} wants you to sign in with your Ethereum account:` &&
    lines[1]?.toLowerCase() === addr.toLowerCase() &&
    lines.includes(`URI: ${location.origin}`) &&
    lines.includes('Chain ID: 4663') &&
    lines.some((l) => l.startsWith('Nonce: '));
  if (!ok) throw new Error('Refused: the sign-in message is not for this site or this wallet.');
  const hex = '0x' + [...new TextEncoder().encode(message)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return state.entry.provider.request({ method: 'personal_sign', params: [hex, addr] });
}

export const wallet = { list, connect, disconnect, switchToRobinhood, signIn, get state() { return { ...state, connected: !!state.address }; } };
