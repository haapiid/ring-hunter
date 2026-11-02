// Address label registry: verified protocol contracts + optional local labels from the user.
// Labels are used to REDUCE false positives (e.g. not treating exchange-funded recipients as insiders).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { getAddress } from 'ethers';
import { networkLabels } from './networks.js';
import { ConfigError } from '../utils/errors.js';
import { CONFIG_DIR } from './paths.js';

export const LABEL_KINDS = ['PROTOCOL', 'ROUTER', 'DEX', 'BURN', 'EXCHANGE', 'BRIDGE', 'SERVICE', 'OTHER'];

// Kinds treated as "public infrastructure/services": must never be used as a basis for insider grouping.
export const PUBLIC_INFRA_KINDS = new Set(['PROTOCOL', 'ROUTER', 'DEX', 'BURN', 'EXCHANGE', 'BRIDGE', 'SERVICE']);

const LocalLabelsSchema = z.object({
  _catatan: z.string().optional(),
  labels: z.array(
    z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      label: z.string().min(1).max(80),
      kind: z.enum(LABEL_KINDS),
      source: z.string().min(1).max(200),
    }),
  ),
});

/**
 * Optional labels.local.json file in the config directory (next to .env). The user is responsible for verifying its contents
 * (e.g. known exchange hot wallets or bridges). Format: see README.
 */
export function loadLocalLabels(dir = CONFIG_DIR) {
  const file = resolve(dir, 'labels.local.json');
  if (!existsSync(file)) return [];
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`labels.local.json is not valid JSON: ${e.message}`);
  }
  const parsed = LocalLabelsSchema.safeParse(json);
  if (!parsed.success) throw new ConfigError(`labels.local.json does not match the expected format: ${parsed.error.issues[0]?.message}`);
  return parsed.data.labels.map((l) => ({ ...l, address: getAddress(l.address.toLowerCase()), userProvided: true }));
}

/** Robinhood Chain infrastructure labels plus the user's local labels. */
export function createLabelRegistry(extra = []) {
  const map = new Map();
  for (const item of [...networkLabels(), ...extra]) {
    map.set(item.address.toLowerCase(), item);
  }
  return {
    get: (addr) => (addr ? map.get(addr.toLowerCase()) ?? null : null),
    isPublicInfra: (addr) => {
      const l = addr ? map.get(addr.toLowerCase()) : null;
      return !!l && PUBLIC_INFRA_KINDS.has(l.kind);
    },
    add: (item) => map.set(item.address.toLowerCase(), item),
    size: () => map.size,
  };
}
