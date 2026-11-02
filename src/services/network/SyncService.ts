import {
  type InternalizeOutput,
  LockingScript,
  P2PKH,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk';
import { BRC100_BASKETS } from '@/constants/baskets';
import {
  Brc100WalletEngine,
  brc100WalletEngine,
  build1SatTags,
  buildBsv21Tags,
} from '@/services/wallet/Brc100WalletEngine';
import { KeyVaultService, keyVaultService } from '@/services/wallet/KeyVaultService';
import {
  NetworkConfigService,
  networkConfigService,
} from './NetworkConfig';

export interface WhatsOnChainUtxoItem {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

export interface GorillaPoolTxoItem {
  txid: string;
  vout: number;
  outpoint: string;
  satoshis: number;
  script?: string;
  origin?: {
    outpoint?: string;
    data?: {
      insc?: {
        file?: {
          type?: string;
          size?: number;
        };
        json?: Record<string, unknown>;
        text?: string;
      };
      map?: Record<string, string>;
      bsv20?: {
        id?: string;
        sym?: string;
        amt?: string;
        dec?: number;
        op?: string;
      };
    };
  };
  data?: {
    insc?: {
      file?: {
        type?: string;
        size?: number;
      };
      json?: Record<string, unknown>;
      text?: string;
    };
    map?: Record<string, string>;
    bsv20?: {
      id?: string;
      sym?: string;
      amt?: string;
      dec?: number;
      op?: string;
    };
  };
}

export interface ClassifiedIncomingOutput {
  txid: string;
  vout: number;
  satoshis: number;
  lockingScriptHex: string;
  classification: 'default' | 'bsv21' | '1sat';
  bsv21?: {
    id: string;
    amt: string;
    sym: string;
    dec: number;
  };
  oneSat?: {
    origin: string;
    contentType: string;
    name: string;
    contentPreview?: string;
  };
}

export interface SyncResult {
  syncedAt: number;
  address: string;
  newDefaultCount: number;
  newBsv21Count: number;
  new1SatCount: number;
  totalInternalized: number;
}

/**
 * Inspects a locking script hex for a 1Sat Ordinal envelope (`0063036f7264` = `OP_FALSE OP_IF "ord"`)
 * and extracts the MIME content-type and UTF-8 payload if present.
 */
export function parseOrdinalInscriptionFromScriptHex(scriptHex: string): {
  contentType: string;
  payloadText: string;
} | null {
  const lower = scriptHex.toLowerCase();
  const marker = '0063036f7264'; // OP_0 OP_IF "ord"
  const idx = lower.indexOf(marker);
  if (idx === -1) {
    return null;
  }

  try {
    // Parse pushdatas after marker: OP_1 (51 or 0101) <len> <mime> OP_0 (00) <len> <body...>
    let cursor = idx + marker.length;
    if (lower.slice(cursor, cursor + 2) === '51') {
      cursor += 2;
    } else if (lower.slice(cursor, cursor + 4) === '0101') {
      cursor += 4;
    } else {
      return null;
    }

    const mimeLen = parseInt(lower.slice(cursor, cursor + 2), 16);
    if (!Number.isFinite(mimeLen) || mimeLen <= 0) {
      return null;
    }
    cursor += 2;
    const mimeHex = lower.slice(cursor, cursor + mimeLen * 2);
    const contentType = Buffer.from(mimeHex, 'hex').toString('utf8');
    cursor += mimeLen * 2;

    if (lower.slice(cursor, cursor + 2) !== '00') {
      return { contentType, payloadText: '' };
    }
    cursor += 2;

    const firstLenByte = parseInt(lower.slice(cursor, cursor + 2), 16);
    cursor += 2;
    let payloadByteLen = firstLenByte;
    if (firstLenByte === 0x4c) {
      payloadByteLen = parseInt(lower.slice(cursor, cursor + 2), 16);
      cursor += 2;
    } else if (firstLenByte === 0x4d) {
      const lo = parseInt(lower.slice(cursor, cursor + 2), 16);
      const hi = parseInt(lower.slice(cursor + 2, cursor + 4), 16);
      payloadByteLen = lo + (hi << 8);
      cursor += 4;
    }

    const payloadHex = lower.slice(cursor, cursor + payloadByteLen * 2);
    const payloadText = Buffer.from(payloadHex, 'hex').toString('utf8');
    return { contentType, payloadText };
  } catch {
    return null;
  }
}

/**
 * Classifies a 1Sat Ordinal / GorillaPool TXO item into `default`, `bsv21` (BRC-163), or `1sat` (BRC-147).
 */
export function classifyTxoItem(
  item: GorillaPoolTxoItem,
  fallbackLockingScriptHex: string
): ClassifiedIncomingOutput {
  const outpoint = item.outpoint || `${item.txid}.${item.vout}`;
  const normalizedOutpoint = outpoint.replace('.', '_');
  const lockingScriptHex = item.script
    ? Buffer.from(item.script, 'base64').toString('hex')
    : fallbackLockingScriptHex;

  const bsv20Data = item.data?.bsv20 ?? item.origin?.data?.bsv20;
  const inscFile = item.data?.insc?.file ?? item.origin?.data?.insc?.file;
  const inscJson = item.data?.insc?.json ?? item.origin?.data?.insc?.json;
  const inscText = item.data?.insc?.text ?? item.origin?.data?.insc?.text;
  const mapMeta = item.data?.map ?? item.origin?.data?.map;

  const parsedScriptEnvelope =
    parseOrdinalInscriptionFromScriptHex(lockingScriptHex);

  const mimeType = (
    inscFile?.type ??
    parsedScriptEnvelope?.contentType ??
    ''
  )
    .toLowerCase()
    .split(';')[0]
    .trim();

  // 1. Check for BSV-21 (`application/bsv-20` or `data.bsv20`) on 1-satoshi output
  if (bsv20Data || mimeType === 'application/bsv-20') {
    let parsedJson: Record<string, unknown> = inscJson ?? {};
    if (
      Object.keys(parsedJson).length === 0 &&
      parsedScriptEnvelope?.payloadText
    ) {
      try {
        parsedJson = JSON.parse(parsedScriptEnvelope.payloadText) as Record<
          string,
          unknown
        >;
      } catch {
        parsedJson = {};
      }
    }

    const id = String(
      bsv20Data?.id ?? parsedJson.id ?? normalizedOutpoint
    ).replace('.', '_');
    const amt = String(bsv20Data?.amt ?? parsedJson.amt ?? '0');
    const sym = String(
      bsv20Data?.sym ?? parsedJson.sym ?? mapMeta?.symbol ?? 'BSV21'
    );
    const decRaw = Number(
      bsv20Data?.dec ?? parsedJson.dec ?? mapMeta?.decimals ?? 0
    );
    const dec = Number.isInteger(decRaw) && decRaw >= 0 ? decRaw : 0;

    return {
      txid: item.txid,
      vout: item.vout,
      satoshis: item.satoshis || 1,
      lockingScriptHex,
      classification: BRC100_BASKETS.BSV21,
      bsv21: {
        id,
        amt,
        sym,
        dec,
      },
    };
  }

  // 2. Check for 1Sat Ordinal NFT (`image/*`, `text/*`, `model/*`, `application/svg+xml`, etc.)
  const isOrdinalMime =
    mimeType.startsWith('image/') ||
    mimeType.startsWith('text/') ||
    mimeType.startsWith('model/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/') ||
    mimeType === 'application/svg+xml' ||
    mimeType === 'application/json';

  if (isOrdinalMime || (item.satoshis === 1 && item.origin?.outpoint)) {
    const origin = (item.origin?.outpoint ?? normalizedOutpoint).replace(
      '.',
      '_'
    );
    const contentType = mimeType || 'image/png';
    const name =
      mapMeta?.name ??
      mapMeta?.subTypeData ??
      `1Sat #${origin.slice(0, 8)}`;
    const contentPreview =
      inscText ?? parsedScriptEnvelope?.payloadText ?? undefined;

    return {
      txid: item.txid,
      vout: item.vout,
      satoshis: 1,
      lockingScriptHex,
      classification: BRC100_BASKETS.ONESAT,
      oneSat: {
        origin,
        contentType,
        name,
        contentPreview,
      },
    };
  }

  // 3. Standard P2PKH satoshi output (>1 satoshi with no ordinal inscription) -> 'default' basket
  return {
    txid: item.txid,
    vout: item.vout,
    satoshis: item.satoshis,
    lockingScriptHex,
    classification: BRC100_BASKETS.DEFAULT,
  };
}

/**
 * Network Sync & Ingestion Service:
 * - Polls or refreshes UTXOs for the wallet's receiving addresses.
 * - Routes incoming outputs via `Brc100WalletEngine.internalizeAction`:
 *   - `default` basket: standard P2PKH outputs (>1 satoshi with no ordinal inscription)
 *   - `bsv21` basket: `application/bsv-20` (BSV-21) 1-satoshi outputs with BRC-163 tags (`id`, `amt`, `sym`, `dec`)
 *   - `1sat` basket: 1Sat Ordinal NFT (`image/*`, `text/*`, `model/*`, etc.) 1-satoshi outputs with BRC-147 tags
 */
export class SyncAndIngestionService {
  private readonly walletEngine: Brc100WalletEngine;
  private readonly keyVault: KeyVaultService;
  private readonly networkConfig: NetworkConfigService;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;

  constructor(
    walletEngine: Brc100WalletEngine = brc100WalletEngine,
    keyVault: KeyVaultService = keyVaultService,
    networkConfig: NetworkConfigService = networkConfigService
  ) {
    this.walletEngine = walletEngine;
    this.keyVault = keyVault;
    this.networkConfig = networkConfig;
  }

  /**
   * Starts periodic background polling for incoming UTXOs.
   */
  public startPolling(intervalMs = 30000): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.syncWallet().catch(() => {
        // Ignore transient background network errors
      });
    }, intervalMs);
  }

  /**
   * Stops background polling.
   */
  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Internalizes a classified incoming output into `Brc100WalletEngine` via `internalizeAction`.
   * If a full raw transaction is provided, uses it directly; otherwise constructs a deterministic
   * carrier transaction matching the output index and invokes `internalizeAction`.
   */
  public async internalizeClassifiedOutput(
    item: ClassifiedIncomingOutput,
    rawTxHex?: string
  ): Promise<void> {
    let tx: Transaction;
    if (rawTxHex) {
      tx = Transaction.fromHex(rawTxHex);
    } else {
      tx = new Transaction(1, [], [], 0);
      tx.addInput({
        sourceTXID: item.txid.padEnd(64, '0').slice(0, 64),
        sourceOutputIndex: 0,
        unlockingScript: new UnlockingScript(),
        sequence: 0xffffffff,
      });
      for (let i = 0; i <= item.vout; i++) {
        tx.addOutput({
          lockingScript: LockingScript.fromHex(item.lockingScriptHex),
          satoshis: i === item.vout ? item.satoshis : 1,
        });
      }
    }

    const internalizeOutputs: InternalizeOutput[] = [];

    if (item.classification === BRC100_BASKETS.DEFAULT) {
      internalizeOutputs.push({
        outputIndex: item.vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: Buffer.from('bsv-default').toString('base64'),
          derivationSuffix: Buffer.from(`${item.vout}`).toString('base64'),
          senderIdentityKey:
            this.keyVault.getUnlockedMetadata()?.identityPublicKey ??
            '02'.padEnd(66, '0'),
        },
      });

      await this.walletEngine.internalizeAction({
        tx: tx.toBinary(),
        outputs: internalizeOutputs,
        description: 'Incoming standard BSV payment',
        labels: ['sync', 'default'],
      });
      return;
    }

    if (item.classification === BRC100_BASKETS.BSV21 && item.bsv21) {
      const tags = buildBsv21Tags({
        txidVout: item.bsv21.id,
        symbol: item.bsv21.sym,
        decimals: item.bsv21.dec,
        amount: item.bsv21.amt,
      });

      internalizeOutputs.push({
        outputIndex: item.vout,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: BRC100_BASKETS.BSV21,
          customInstructions: JSON.stringify({
            p: 'bsv-20',
            id: item.bsv21.id,
            sym: item.bsv21.sym,
            amt: item.bsv21.amt,
            dec: item.bsv21.dec,
            sourceOutpoint: `${item.txid}.${item.vout}`,
          }),
          tags,
        },
      });

      await this.walletEngine.internalizeAction({
        tx: tx.toBinary(),
        outputs: internalizeOutputs,
        description: `BSV-21 Token (${item.bsv21.sym})`,
        labels: ['sync', 'bsv21'],
      });
      return;
    }

    if (item.classification === BRC100_BASKETS.ONESAT && item.oneSat) {
      const tags = build1SatTags({
        txidVout: item.oneSat.origin,
        contentType: item.oneSat.contentType,
        name: item.oneSat.name,
      });

      internalizeOutputs.push({
        outputIndex: item.vout,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: BRC100_BASKETS.ONESAT,
          customInstructions: JSON.stringify({
            origin: item.oneSat.origin,
            contentType: item.oneSat.contentType,
            name: item.oneSat.name,
            contentPreview: item.oneSat.contentPreview,
            sourceOutpoint: `${item.txid}.${item.vout}`,
          }),
          tags,
        },
      });

      await this.walletEngine.internalizeAction({
        tx: tx.toBinary(),
        outputs: internalizeOutputs,
        description: `1Sat Ordinal (${item.oneSat.name})`,
        labels: ['sync', '1sat'],
      });
    }
  }

  /**
   * Polls WhatsOnChain (standard UTXOs) and GorillaPool 1Sat Indexer (BSV-21 & 1Sat NFTs)
   * for the wallet's receiving address and internalizes any newly discovered outputs.
   */
  public async syncWallet(explicitAddress?: string): Promise<SyncResult> {
    const address =
      explicitAddress ?? this.keyVault.getUnlockedMetadata()?.address;

    if (!address) {
      return {
        syncedAt: Date.now(),
        address: '',
        newDefaultCount: 0,
        newBsv21Count: 0,
        new1SatCount: 0,
        totalInternalized: 0,
      };
    }

    if (this.isSyncing) {
      return {
        syncedAt: Date.now(),
        address,
        newDefaultCount: 0,
        newBsv21Count: 0,
        new1SatCount: 0,
        totalInternalized: 0,
      };
    }

    this.isSyncing = true;
    let newDefaultCount = 0;
    let newBsv21Count = 0;
    let new1SatCount = 0;

    try {
      const fallbackLockingScriptHex = new P2PKH().lock(address).toHex();
      const [defaultList, bsv21List, oneSatList] = await Promise.all([
        this.walletEngine.listOutputs({
          basket: BRC100_BASKETS.DEFAULT,
          limit: 1000,
        }),
        this.walletEngine.listOutputs({
          basket: BRC100_BASKETS.BSV21,
          limit: 1000,
        }),
        this.walletEngine.listOutputs({
          basket: BRC100_BASKETS.ONESAT,
          limit: 1000,
        }),
      ]);

      const knownOutpoints = new Set<string>([
        ...defaultList.outputs.map((o) => o.outpoint),
        ...bsv21List.outputs.map((o) => o.outpoint),
        ...oneSatList.outputs.map((o) => o.outpoint),
      ]);

      // 1. Fetch 1Sat / BSV-21 outputs from GorillaPool Ordinals Indexer
      const gorillaUrl =
        this.networkConfig.getGorillaPoolAddressUnspentUrl(address);
      const gorillaOutpoints = new Set<string>();

      try {
        const gpRes = await fetch(gorillaUrl, {
          headers: { Accept: 'application/json' },
        });
        if (gpRes.ok) {
          const gpItems = (await gpRes.json()) as GorillaPoolTxoItem[];
          if (Array.isArray(gpItems)) {
            for (const item of gpItems) {
              const outpoint = item.outpoint || `${item.txid}.${item.vout}`;
              gorillaOutpoints.add(outpoint);
              if (knownOutpoints.has(outpoint)) {
                continue;
              }

              const classified = classifyTxoItem(
                item,
                fallbackLockingScriptHex
              );
              const rawTxHex = await this.tryFetchRawTxHex(item.txid);
              await this.internalizeClassifiedOutput(classified, rawTxHex);
              knownOutpoints.add(outpoint);

              if (classified.classification === BRC100_BASKETS.BSV21) {
                newBsv21Count += 1;
              } else if (classified.classification === BRC100_BASKETS.ONESAT) {
                new1SatCount += 1;
              } else {
                newDefaultCount += 1;
              }
            }
          }
        }
      } catch {
        // GorillaPool indexer unreachable or offline; continue with WhatsOnChain
      }

      // 2. Fetch standard P2PKH UTXOs from WhatsOnChain
      const wocUrl = this.networkConfig.getWhatsOnChainUtxosUrl(address);
      try {
        const wocRes = await fetch(wocUrl, {
          headers: { Accept: 'application/json' },
        });
        if (wocRes.ok) {
          const wocItems = (await wocRes.json()) as WhatsOnChainUtxoItem[];
          if (Array.isArray(wocItems)) {
            for (const u of wocItems) {
              const outpoint = `${u.tx_hash}.${u.tx_pos}`;
              if (
                knownOutpoints.has(outpoint) ||
                gorillaOutpoints.has(outpoint)
              ) {
                continue;
              }

              // Standard P2PKH satoshi outputs (>1 satoshi with no ordinal inscription)
              if (u.value > 1) {
                const rawTxHex = await this.tryFetchRawTxHex(u.tx_hash);
                await this.internalizeClassifiedOutput(
                  {
                    txid: u.tx_hash,
                    vout: u.tx_pos,
                    satoshis: u.value,
                    lockingScriptHex: fallbackLockingScriptHex,
                    classification: BRC100_BASKETS.DEFAULT,
                  },
                  rawTxHex
                );
                knownOutpoints.add(outpoint);
                newDefaultCount += 1;
              }
            }
          }
        }
      } catch {
        // WhatsOnChain unreachable or offline
      }

      return {
        syncedAt: Date.now(),
        address,
        newDefaultCount,
        newBsv21Count,
        new1SatCount,
        totalInternalized: newDefaultCount + newBsv21Count + new1SatCount,
      };
    } finally {
      this.isSyncing = false;
    }
  }

  private async tryFetchRawTxHex(txid: string): Promise<string | undefined> {
    try {
      const url = this.networkConfig.getWhatsOnChainRawTxUrl(txid);
      const res = await fetch(url);
      if (!res.ok) {
        return undefined;
      }
      const hex = (await res.text()).trim();
      return hex.length > 0 ? hex : undefined;
    } catch {
      return undefined;
    }
  }
}

export const syncService = new SyncAndIngestionService();
