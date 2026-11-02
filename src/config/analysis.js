// Configurable analysis parameters. These numbers are HEURISTICS, not proof of ownership.
// Change them carefully and update the test fixtures and README when you do.

export const SCORING_WEIGHTS = Object.freeze({
  fundingCorrelation: 25,
  clusterSupply: 20,
  earlyCoordination: 15,
  contractPrivileges: 20,
  liquidity: 10,
  holderConcentration: 10,
});

export const RISK_BANDS = Object.freeze([
  { min: 70, level: 'HIGH_OBSERVED_RISK', label: 'HIGH OBSERVED RISK' },
  { min: 40, level: 'MODERATE_RISK', label: 'MODERATE RISK' },
  { min: 0, level: 'LOWER_OBSERVED_RISK', label: 'LOWER OBSERVED RISK' },
]);

export const SCORING_POLICY = Object.freeze({
  // Below this coverage (0..1) the report shows INSUFFICIENT DATA next to the score.
  minCoverageForLevel: 0.5,
  // Components with status 'partial' count at half weight toward coverage.
  partialCoverageFactor: 0.5,
});

export const CLUSTER_THRESHOLDS = Object.freeze({
  // Time window in which funding counts as "close together" (seconds).
  fundingWindowSeconds: 6 * 3600,
  // Amounts count as similar if the relative difference is ≤ this value.
  similarAmountTolerance: 0.1,
  // A wallet counts as "fresh" if its first observed funding is ≤ X seconds before the buy.
  freshWalletSeconds: 24 * 3600,
  // Buys count as coordinated if ≥ N distinct buyers fall within this block span.
  coordinatedBlockSpan: 2,
  coordinatedMinBuyers: 3,
  // Funders with a nonce above this are suspected public services (exchange/hot wallet) → not used for grouping.
  serviceNonceThreshold: 5000,
  // A contract funder that funds more than N observed wallets → suspected distribution/service.
  contractFanoutThreshold: 20,
});

export const SCAN_LIMITS = Object.freeze({
  // Max wallets whose funding history is looked up via the explorer.
  maxFundingLookups: 30,
  // Max transactions per wallet fetched from the explorer.
  explorerTxPerWallet: 200,
  // Top holders whose balances are cross-checked via balanceOf.
  balanceCrossCheckTop: 15,
  // Cap on the number of Transfers processed for holder reconstruction.
  maxTransferLogs: 200_000,
  // Time budget (seconds) for finding the deployment when no explorer/archive data is available.
  originSearchSeconds: 60,
});
