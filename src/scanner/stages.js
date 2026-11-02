// Scan stage list. The CLI progress bar advances one step each time a stage actually finishes.
export const SCAN_STAGES = Object.freeze([
  { id: 'connect', label: 'Connecting to RPC' },
  { id: 'network', label: 'Verifying network' },
  { id: 'token', label: 'Checking token contract' },
  { id: 'origin', label: 'Detecting creator & token origin' },
  { id: 'pools', label: 'Finding liquidity pools' },
  { id: 'early', label: 'Fetching early transactions' },
  { id: 'holders', label: 'Analyzing holder distribution' },
  { id: 'funding', label: 'Building funding graph' },
  { id: 'clusters', label: 'Detecting wallet clusters' },
  { id: 'contract', label: 'Analyzing contract risk' },
  { id: 'score', label: 'Computing risk score' },
]);
