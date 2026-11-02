import * as SQLite from 'expo-sqlite';
import {
  type AbortActionArgs,
  type AbortActionResult,
  type AcquireCertificateArgs,
  type AcquireCertificateResult,
  type AuthenticatedResult,
  type CreateActionArgs,
  type CreateActionInput,
  type CreateActionOutput,
  type CreateActionResult,
  type CreateHmacArgs,
  type CreateHmacResult,
  type CreateSignatureArgs,
  type CreateSignatureResult,
  type DiscoverByAttributesArgs,
  type DiscoverByIdentityKeyArgs,
  type DiscoverCertificatesResult,
  type GetHeaderArgs,
  type GetHeaderResult,
  type GetHeightResult,
  type GetNetworkResult,
  type GetPublicKeyArgs,
  type GetPublicKeyResult,
  type GetVersionResult,
  type InternalizeActionArgs,
  type InternalizeActionResult,
  type ListActionsArgs,
  type ListActionsResult,
  type ListCertificatesArgs,
  type ListCertificatesResult,
  type ListOutputsArgs,
  type ListOutputsResult,
  LockingScript,
  type OriginatorDomainNameStringUnder250Bytes,
  P2PKH,
  ProtoWallet,
  type ProveCertificateArgs,
  type ProveCertificateResult,
  type RelinquishCertificateArgs,
  type RelinquishCertificateResult,
  type RelinquishOutputArgs,
  type RelinquishOutputResult,
  type RevealCounterpartyKeyLinkageArgs,
  type RevealCounterpartyKeyLinkageResult,
  type RevealSpecificKeyLinkageArgs,
  type RevealSpecificKeyLinkageResult,
  type SignActionArgs,
  type SignActionResult,
  Transaction,
  UnlockingScript,
  type VerifyHmacArgs,
  type VerifyHmacResult,
  type VerifySignatureArgs,
  type VerifySignatureResult,
  type WalletDecryptArgs,
  type WalletDecryptResult,
  type WalletEncryptArgs,
  type WalletEncryptResult,
  type WalletInterface,
  type WalletNetwork,
  type WalletOutput,
} from '@bsv/sdk';
import {
  sdk as ToolboxSdk,
  WalletPermissionsManager,
} from '@bsv/wallet-toolbox-mobile';
import { BRC100_BASKETS, type BasketName } from '@/constants/baskets';
import { KeyVaultService, keyVaultService } from './KeyVaultService';

const SQLITE_DB_NAME = 'brc100_nfc_wallet.db';
const DEFAULT_FEE_RATE_SATS_PER_KB = 50; // 0.05 sat/byte standard BSV relay rate

export const ALLOWED_BASKETS: ReadonlySet<string> = new Set([
  BRC100_BASKETS.DEFAULT,
  BRC100_BASKETS.BSV21,
  BRC100_BASKETS.ONESAT,
]);

export interface Bsv21TagMetadata {
  tokenIdTag: `token_id_${string}`;
  tokenId: string;
  symbol: string;
  decimals: number;
  amount: string;
}

export interface OneSatOrdinalTagMetadata {
  originTag: `origin_${string}`;
  origin: string;
  contentType: string;
  name: string;
}

export interface ExplicitCarrierSpendFlags {
  allowBsv21Spend?: boolean;
  allow1SatSpend?: boolean;
}

export interface Brc100ExtendedCreateActionArgs extends CreateActionArgs {
  /**
   * Explicit authorization required when spending carrier outputs from
   * 'bsv21' (BRC-163) or '1sat' (BRC-147) baskets.
   * Automatic fee selection NEVER spends from these baskets under any circumstances.
   */
  carrierSpendFlags?: ExplicitCarrierSpendFlags;
  /**
   * Optional fee rate in satoshis per kilobyte (1000 bytes) fetched from ARC `/v1/policy`.
   */
  feeRateSatsPerKb?: number;
}

export interface Bsv21TokenBalanceSummary {
  tokenId: string;
  symbol: string;
  decimals: number;
  rawAmount: string;
  formattedAmount: string;
  utxoCount: number;
  outpoints: string[];
}

export interface OneSatNftItem {
  outpoint: string;
  txid: string;
  vout: number;
  origin: string;
  contentType: string;
  name: string;
  satoshis: number;
  lockingScript: string;
  contentPreview?: string;
  tags: string[];
}

export interface StoredUtxoRow {
  outpoint: string;
  txid: string;
  vout: number;
  satoshis: number;
  locking_script: string;
  basket: BasketName;
  spendable: number;
  custom_instructions: string | null;
  output_description: string;
  tags_json: string;
  labels_json: string;
  token_id: string | null;
  symbol: string | null;
  decimals: number | null;
  amount: string | null;
  origin: string | null;
  content_type: string | null;
  name: string | null;
  pending_reference: string | null;
  spent_by_txid: string | null;
  created_at: number;
}

interface StoredActionRow {
  reference: string;
  txid: string;
  status: string;
  description: string;
  version: number;
  lock_time: number;
  satoshis: number;
  labels_json: string;
  inputs_json: string;
  outputs_json: string;
  raw_tx_hex: string;
  created_at: number;
}

/**
 * Thrown whenever coin selection or action construction attempts to spend
 * a protected 'bsv21' or '1sat' carrier UTXO for standard fees or without
 * an explicit token/NFT spend flag.
 */
export class BasketIsolationError extends ToolboxSdk.WalletError {
  constructor(message: string) {
    super('WERR_BASKET_ISOLATION_VIOLATION', message);
  }
}

/**
 * Helper to construct canonical BSV-21 ('bsv21' basket) BRC-163 tags.
 * Includes both verbose (`token_id_<txid_vout>`, `symbol`, `decimals`, `amount`)
 * and compact BRC-163 (`id`, `amt`, `sym`, `dec`) tags.
 */
export function buildBsv21Tags(params: {
  txidVout: string;
  symbol: string;
  decimals: number;
  amount: string;
}): string[] {
  const normalizedOutpoint = params.txidVout
    .replace(/^token_id_/, '')
    .replace('.', '_');
  return [
    `token_id_${normalizedOutpoint}`,
    `id:${normalizedOutpoint}`,
    `symbol:${params.symbol}`,
    `sym:${params.symbol}`,
    `decimals:${params.decimals}`,
    `dec:${params.decimals}`,
    `amount:${params.amount}`,
    `amt:${params.amount}`,
  ];
}

/**
 * Helper to construct canonical 1Sat Ordinal ('1sat' basket) BRC-147 tags.
 */
export function build1SatTags(params: {
  txidVout: string;
  contentType: string;
  name: string;
}): string[] {
  const normalizedOrigin = params.txidVout
    .replace(/^origin_/, '')
    .replace('.', '_');
  return [
    `origin_${normalizedOrigin}`,
    `origin:${normalizedOrigin}`,
    `content_type:${params.contentType}`,
    `name:${params.name}`,
  ];
}

/**
 * Validates and extracts BSV-21 metadata (`token_id_<txid_vout>` / `id`, `symbol` / `sym`,
 * `decimals` / `dec`, `amount` / `amt`) from output tags when storing in the `bsv21` basket.
 */
export function parseAndValidateBsv21Tags(tags: string[] = []): Bsv21TagMetadata {
  const extractValue = (prefixes: string[]): string | undefined => {
    for (const prefix of prefixes) {
      for (const tag of tags) {
        if (tag.startsWith(`${prefix}:`)) {
          return tag.slice(prefix.length + 1);
        }
        if (tag.startsWith(`${prefix}=`)) {
          return tag.slice(prefix.length + 1);
        }
        if (tag.startsWith(`${prefix}_`)) {
          return tag.slice(prefix.length + 1);
        }
      }
    }
    return undefined;
  };

  const rawTokenId = extractValue(['token_id', 'id']);
  const symbol = extractValue(['symbol', 'sym']);
  const decimalsStr = extractValue(['decimals', 'dec']);
  const amount = extractValue(['amount', 'amt']);

  if (!rawTokenId || !symbol || decimalsStr === undefined || !amount) {
    throw new BasketIsolationError(
      "Outputs in basket 'bsv21' must be tagged with token_id_<txid_vout> (or id), symbol (or sym), decimals (or dec), and amount (or amt)."
    );
  }

  const normalizedTokenId = rawTokenId.replace('.', '_');
  const tokenIdTag: `token_id_${string}` = `token_id_${normalizedTokenId}`;

  const decimals = Number(decimalsStr);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new BasketIsolationError(
      `Invalid decimals tag '${decimalsStr}' for 'bsv21' basket output.`
    );
  }

  return {
    tokenIdTag,
    tokenId: normalizedTokenId,
    symbol,
    decimals,
    amount,
  };
}

/**
 * Validates and extracts 1Sat Ordinal NFT metadata (`origin_<txid_vout>`, `content_type`, `name`)
 * from output tags when storing in the `1sat` basket.
 */
export function parseAndValidate1SatTags(
  tags: string[] = []
): OneSatOrdinalTagMetadata {
  const extractValue = (prefixes: string[]): string | undefined => {
    for (const prefix of prefixes) {
      for (const tag of tags) {
        if (tag.startsWith(`${prefix}:`)) {
          return tag.slice(prefix.length + 1);
        }
        if (tag.startsWith(`${prefix}=`)) {
          return tag.slice(prefix.length + 1);
        }
        if (tag.startsWith(`${prefix}_`)) {
          return tag.slice(prefix.length + 1);
        }
      }
    }
    return undefined;
  };

  const rawOrigin = extractValue(['origin']);
  const contentType = extractValue(['content_type', 'type']);
  const name = extractValue(['name']);

  if (!rawOrigin || !contentType || !name) {
    throw new BasketIsolationError(
      "Outputs in basket '1sat' must be tagged with origin_<txid_vout>, content_type, and name."
    );
  }

  const normalizedOrigin = rawOrigin.replace('.', '_');
  const originTag: `origin_${string}` = `origin_${normalizedOrigin}`;

  return {
    originTag,
    origin: normalizedOrigin,
    contentType,
    name,
  };
}

/**
 * Strict Coin Selection Guard:
 * Ensures automatic fee funding ONLY selects UTXOs from `basket: 'default'`.
 * Throws a `BasketIsolationError` if any `bsv21` or `1sat` output is present in the candidate pool
 * or if an explicit input attempts to spend a `bsv21` or `1sat` output without the explicit flag.
 */
export function selectDefaultBasketFeeUtxos(
  candidates: StoredUtxoRow[],
  requiredSatoshis: number
): { selected: StoredUtxoRow[]; totalSelectedSatoshis: number } {
  for (const candidate of candidates) {
    if (candidate.basket !== BRC100_BASKETS.DEFAULT) {
      throw new BasketIsolationError(
        `CRITICAL: Non-default basket output (${candidate.outpoint} in '${candidate.basket}') was passed into automatic fee coin selection. Automatic fee funding may ONLY spend from basket 'default'.`
      );
    }
  }

  if (requiredSatoshis <= 0) {
    return { selected: [], totalSelectedSatoshis: 0 };
  }

  const selected: StoredUtxoRow[] = [];
  let totalSelectedSatoshis = 0;

  for (const utxo of candidates) {
    if (utxo.spendable !== 1 || utxo.spent_by_txid || utxo.pending_reference) {
      continue;
    }
    selected.push(utxo);
    totalSelectedSatoshis += utxo.satoshis;
    if (totalSelectedSatoshis >= requiredSatoshis) {
      break;
    }
  }

  if (totalSelectedSatoshis < requiredSatoshis) {
    throw new Error(
      `Insufficient funds in 'default' BSV basket: required ${requiredSatoshis} satoshis, available ${totalSelectedSatoshis} satoshis.`
    );
  }

  return { selected, totalSelectedSatoshis };
}

/**
 * BRC-100 Wallet Engine backed by `expo-sqlite` and `@bsv/wallet-toolbox-mobile`.
 */
export class Brc100WalletEngine implements WalletInterface {
  private dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
  private readonly keyVault: KeyVaultService;
  private network: WalletNetwork;
  private readonly dbName: string;
  private permissionsManager: WalletPermissionsManager | null = null;

  constructor(
    keyVault: KeyVaultService = keyVaultService,
    network: WalletNetwork = 'mainnet',
    dbName: string = SQLITE_DB_NAME
  ) {
    this.keyVault = keyVault;
    this.network = network;
    this.dbName = dbName;
  }

  public setNetwork(network: WalletNetwork): void {
    this.network = network;
  }

  /**
   * Returns a `@bsv/wallet-toolbox-mobile` `WalletPermissionsManager` wrapping this BRC-100 engine.
   */
  public getPermissionsManager(
    adminOriginator = 'nfcwallet.local'
  ): WalletPermissionsManager {
    if (!this.permissionsManager) {
      this.permissionsManager = new WalletPermissionsManager(
        this,
        adminOriginator,
        {
          seekSpendingPermissions: true,
          seekBasketInsertionPermissions: true,
          seekBasketListingPermissions: false,
          encryptWalletMetadata: false,
        }
      );
    }
    return this.permissionsManager;
  }

  /**
   * Opens and initializes the SQLite database schema enforcing the three explicit baskets:
   * - `default`
   * - `bsv21`
   * - `1sat`
   */
  public async getDatabase(): Promise<SQLite.SQLiteDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = this.initDatabase();
    }
    return this.dbPromise;
  }

  private async initDatabase(): Promise<SQLite.SQLiteDatabase> {
    const db = await SQLite.openDatabaseAsync(this.dbName);

    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS brc100_baskets (
        name TEXT PRIMARY KEY CHECK (name IN ('default', 'bsv21', '1sat')),
        standard TEXT NOT NULL,
        description TEXT NOT NULL,
        spendable_for_fees INTEGER NOT NULL CHECK (spendable_for_fees IN (0, 1))
      );

      INSERT OR IGNORE INTO brc100_baskets (name, standard, description, spendable_for_fees)
      VALUES
        ('default', 'BRC-100', 'Standard BSV satoshis used for payments and transaction fees', 1),
        ('bsv21', 'BRC-163', 'BSV-21 fungible token 1-satoshi carrier outputs', 0),
        ('1sat', 'BRC-147', '1Sat Ordinal NFT 1-satoshi inscription outputs', 0);

      CREATE TABLE IF NOT EXISTS utxo_outputs (
        outpoint TEXT PRIMARY KEY,
        txid TEXT NOT NULL,
        vout INTEGER NOT NULL,
        satoshis INTEGER NOT NULL CHECK (satoshis >= 1),
        locking_script TEXT NOT NULL,
        basket TEXT NOT NULL CHECK (basket IN ('default', 'bsv21', '1sat')),
        spendable INTEGER NOT NULL DEFAULT 1 CHECK (spendable IN (0, 1)),
        custom_instructions TEXT,
        output_description TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        labels_json TEXT NOT NULL DEFAULT '[]',
        token_id TEXT,
        symbol TEXT,
        decimals INTEGER,
        amount TEXT,
        origin TEXT,
        content_type TEXT,
        name TEXT,
        pending_reference TEXT,
        spent_by_txid TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (basket) REFERENCES brc100_baskets(name),
        CHECK (
          (basket = 'default') OR
          (basket = 'bsv21' AND token_id IS NOT NULL AND symbol IS NOT NULL AND decimals IS NOT NULL AND amount IS NOT NULL) OR
          (basket = '1sat' AND origin IS NOT NULL AND content_type IS NOT NULL AND name IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_utxo_outputs_basket_spendable
        ON utxo_outputs (basket, spendable, spent_by_txid, pending_reference);

      CREATE TABLE IF NOT EXISTS brc100_actions (
        reference TEXT PRIMARY KEY,
        txid TEXT NOT NULL,
        status TEXT NOT NULL,
        description TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        lock_time INTEGER NOT NULL DEFAULT 0,
        satoshis INTEGER NOT NULL DEFAULT 0,
        labels_json TEXT NOT NULL DEFAULT '[]',
        inputs_json TEXT NOT NULL DEFAULT '[]',
        outputs_json TEXT NOT NULL DEFAULT '[]',
        raw_tx_hex TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    return db;
  }

  private getProtoWallet(): ProtoWallet {
    const keyDeriver = this.keyVault.getKeyDeriver();
    return new ProtoWallet(keyDeriver);
  }

  private assertValidBasketName(basket: string): asserts basket is BasketName {
    if (!ALLOWED_BASKETS.has(basket)) {
      throw new BasketIsolationError(
        `Unsupported basket '${basket}'. Only 'default', 'bsv21', and '1sat' baskets are permitted.`
      );
    }
  }

  /**
   * Validates explicit inputs against basket isolation rules before constructing a transaction.
   */
  private validateExplicitInputBasketIsolation(
    row: StoredUtxoRow,
    input: CreateActionInput,
    carrierSpendFlags?: ExplicitCarrierSpendFlags
  ): void {
    let customFlags: ExplicitCarrierSpendFlags = {};
    if (row.custom_instructions) {
      try {
        const parsed = JSON.parse(row.custom_instructions) as Record<
          string,
          unknown
        >;
        if (parsed.allowBsv21Spend === true) {
          customFlags.allowBsv21Spend = true;
        }
        if (parsed.allow1SatSpend === true) {
          customFlags.allow1SatSpend = true;
        }
      } catch {
        // Ignore non-JSON custom instructions
      }
    }

    const descriptionLower = (input.inputDescription ?? '').toLowerCase();
    const hasExplicitTokenDesc = descriptionLower.includes('[allow-bsv21-spend]');
    const hasExplicitOrdinalDesc = descriptionLower.includes('[allow-1sat-spend]');

    if (row.basket === BRC100_BASKETS.BSV21) {
      const allowed =
        carrierSpendFlags?.allowBsv21Spend === true ||
        customFlags.allowBsv21Spend === true ||
        hasExplicitTokenDesc;
      if (!allowed) {
        throw new BasketIsolationError(
          `Blocked attempt to spend BSV-21 token output (${row.outpoint}) from basket 'bsv21' without an explicit token spend flag.`
        );
      }
    }

    if (row.basket === BRC100_BASKETS.ONESAT) {
      const allowed =
        carrierSpendFlags?.allow1SatSpend === true ||
        customFlags.allow1SatSpend === true ||
        hasExplicitOrdinalDesc;
      if (!allowed) {
        throw new BasketIsolationError(
          `Blocked attempt to spend 1Sat Ordinal NFT output (${row.outpoint}) from basket '1sat' without an explicit NFT spend flag.`
        );
      }
    }
  }

  /**
   * Inserts or updates a UTXO in SQLite while enforcing basket constraints and tag schemas.
   */
  private async insertOutputRow(params: {
    outpoint: string;
    txid: string;
    vout: number;
    satoshis: number;
    lockingScript: string;
    basket: string;
    spendable?: boolean;
    customInstructions?: string;
    outputDescription: string;
    tags?: string[];
    labels?: string[];
    pendingReference?: string | null;
  }): Promise<void> {
    this.assertValidBasketName(params.basket);
    const db = await this.getDatabase();
    const tags = params.tags ?? [];
    const labels = params.labels ?? [];

    let tokenId: string | null = null;
    let symbol: string | null = null;
    let decimals: number | null = null;
    let amount: string | null = null;

    let origin: string | null = null;
    let contentType: string | null = null;
    let name: string | null = null;

    if (params.basket === BRC100_BASKETS.BSV21) {
      const parsed = parseAndValidateBsv21Tags(tags);
      tokenId = parsed.tokenIdTag;
      symbol = parsed.symbol;
      decimals = parsed.decimals;
      amount = parsed.amount;
    } else if (params.basket === BRC100_BASKETS.ONESAT) {
      const parsed = parseAndValidate1SatTags(tags);
      origin = parsed.originTag;
      contentType = parsed.contentType;
      name = parsed.name;
    }

    await db.runAsync(
      `INSERT OR REPLACE INTO utxo_outputs (
        outpoint, txid, vout, satoshis, locking_script, basket, spendable,
        custom_instructions, output_description, tags_json, labels_json,
        token_id, symbol, decimals, amount,
        origin, content_type, name,
        pending_reference, spent_by_txid, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [
        params.outpoint,
        params.txid,
        params.vout,
        params.satoshis,
        params.lockingScript,
        params.basket,
        params.spendable === false ? 0 : 1,
        params.customInstructions ?? null,
        params.outputDescription,
        JSON.stringify(tags),
        JSON.stringify(labels),
        tokenId,
        symbol,
        decimals,
        amount,
        origin,
        contentType,
        name,
        params.pendingReference ?? null,
        Date.now(),
      ]
    );
  }

  /**
   * BRC-100 `getPublicKey`: Delegates to `@bsv/sdk` `ProtoWallet` backed by the hardware `KeyDeriver`.
   */
  public async getPublicKey(
    args: GetPublicKeyArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetPublicKeyResult> {
    const proto = this.getProtoWallet();
    return proto.getPublicKey(args);
  }

  /**
   * BRC-100 `createSignature`: Delegates to `@bsv/sdk` `ProtoWallet` backed by the hardware `KeyDeriver`.
   */
  public async createSignature(
    args: CreateSignatureArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateSignatureResult> {
    const proto = this.getProtoWallet();
    return proto.createSignature(args);
  }

  /**
   * BRC-100 `createAction`:
   * Builds and optionally signs a BSV transaction while enforcing strict basket isolation:
   * - Explicit inputs from `bsv21` or `1sat` require explicit carrier spend flags.
   * - Automatic fee funding ONLY queries and selects UTXOs from `basket = 'default'`.
   */
  public async createAction(
    args: Brc100ExtendedCreateActionArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateActionResult> {
    const db = await this.getDatabase();
    const rootPrivKey = this.keyVault.getRootPrivateKey();
    const walletAddress = rootPrivKey.toPublicKey().toAddress();

    const requestedInputs = args.inputs ?? [];
    const requestedOutputs = args.outputs ?? [];

    // Validate all output baskets upfront
    for (const out of requestedOutputs) {
      if (out.basket !== undefined) {
        this.assertValidBasketName(out.basket);
        if (out.basket === BRC100_BASKETS.BSV21) {
          parseAndValidateBsv21Tags(out.tags ?? []);
        } else if (out.basket === BRC100_BASKETS.ONESAT) {
          parseAndValidate1SatTags(out.tags ?? []);
        }
      }
    }

    // 1. Resolve & guard explicit caller inputs
    const resolvedExplicitInputs: {
      input: CreateActionInput;
      row: StoredUtxoRow;
    }[] = [];
    let explicitInputSatoshis = 0;

    for (const input of requestedInputs) {
      const row = await db.getFirstAsync<StoredUtxoRow>(
        `SELECT * FROM utxo_outputs WHERE outpoint = ?`,
        [input.outpoint]
      );
      if (!row) {
        throw new Error(`Input UTXO not found in wallet storage: ${input.outpoint}`);
      }
      if (row.spent_by_txid || row.pending_reference) {
        throw new Error(`Input UTXO is already spent or reserved: ${input.outpoint}`);
      }

      // Enforce strict basket isolation guard on explicit inputs
      this.validateExplicitInputBasketIsolation(
        row,
        input,
        args.carrierSpendFlags
      );

      resolvedExplicitInputs.push({ input, row });
      explicitInputSatoshis += row.satoshis;
    }

    const totalOutputSatoshis = requestedOutputs.reduce(
      (sum, out) => sum + out.satoshis,
      0
    );

    // Estimate transaction byte size and network fee
    const feeRate = args.feeRateSatsPerKb ?? DEFAULT_FEE_RATE_SATS_PER_KB;
    const estimatedInputCount = Math.max(1, resolvedExplicitInputs.length + 1);
    const estimatedOutputCount = requestedOutputs.length + 1;
    const estimatedTxBytes =
      10 + estimatedInputCount * 148 + estimatedOutputCount * 34;
    const estimatedFeeSatoshis = Math.max(
      1,
      Math.ceil((estimatedTxBytes * feeRate) / 1000)
    );

    const shortfallSatoshis = Math.max(
      0,
      totalOutputSatoshis + estimatedFeeSatoshis - explicitInputSatoshis
    );

    // 2. Automatic Fee Funding ONLY from basket = 'default'
    let feeSelectedUtxos: StoredUtxoRow[] = [];
    let feeSelectedSatoshis = 0;

    if (shortfallSatoshis > 0) {
      const explicitOutpoints = new Set(requestedInputs.map((i) => i.outpoint));
      const defaultCandidates = await db.getAllAsync<StoredUtxoRow>(
        `SELECT * FROM utxo_outputs
         WHERE basket = 'default'
           AND spendable = 1
           AND spent_by_txid IS NULL
           AND pending_reference IS NULL
         ORDER BY satoshis DESC, created_at ASC`
      );

      const filteredCandidates = defaultCandidates.filter(
        (u) => !explicitOutpoints.has(u.outpoint)
      );

      const selection = selectDefaultBasketFeeUtxos(
        filteredCandidates,
        shortfallSatoshis
      );
      feeSelectedUtxos = selection.selected;
      feeSelectedSatoshis = selection.totalSelectedSatoshis;
    }

    // 3. Build @bsv/sdk Transaction
    const tx = new Transaction(args.version ?? 1, [], [], args.lockTime ?? 0);
    const needsDeferredSignAction =
      args.options?.signAndProcess === false ||
      requestedInputs.some(
        (inp) => !inp.unlockingScript && inp.unlockingScriptLength !== undefined
      );

    for (const { input, row } of resolvedExplicitInputs) {
      if (input.unlockingScript) {
        tx.addInput({
          sourceTXID: row.txid,
          sourceOutputIndex: row.vout,
          unlockingScript: UnlockingScript.fromHex(input.unlockingScript),
          sequence: input.sequenceNumber ?? 0xffffffff,
        });
      } else {
        tx.addInput({
          sourceTXID: row.txid,
          sourceOutputIndex: row.vout,
          unlockingScriptTemplate: new P2PKH().unlock(
            rootPrivKey,
            'all',
            false,
            row.satoshis,
            LockingScript.fromHex(row.locking_script)
          ),
          sequence: input.sequenceNumber ?? 0xffffffff,
        });
      }
    }

    for (const feeUtxo of feeSelectedUtxos) {
      tx.addInput({
        sourceTXID: feeUtxo.txid,
        sourceOutputIndex: feeUtxo.vout,
        unlockingScriptTemplate: new P2PKH().unlock(
          rootPrivKey,
          'all',
          false,
          feeUtxo.satoshis,
          LockingScript.fromHex(feeUtxo.locking_script)
        ),
        sequence: 0xffffffff,
      });
    }

    const trackedOutputs: (CreateActionOutput & { vout: number })[] = [];

    requestedOutputs.forEach((out, idx) => {
      tx.addOutput({
        lockingScript: LockingScript.fromHex(out.lockingScript),
        satoshis: out.satoshis,
      });
      trackedOutputs.push({ ...out, vout: idx });
    });

    // Add change output back to 'default' basket if excess > dust (1 sat)
    const totalInputsSatoshis = explicitInputSatoshis + feeSelectedSatoshis;
    const changeSatoshis =
      totalInputsSatoshis - totalOutputSatoshis - estimatedFeeSatoshis;

    if (changeSatoshis > 0) {
      const changeLockingScript = new P2PKH().lock(walletAddress);
      const changeVout = tx.outputs.length;
      tx.addOutput({
        lockingScript: changeLockingScript,
        satoshis: changeSatoshis,
      });
      trackedOutputs.push({
        vout: changeVout,
        lockingScript: changeLockingScript.toHex(),
        satoshis: changeSatoshis,
        outputDescription: 'Default basket BSV change output',
        basket: BRC100_BASKETS.DEFAULT,
        tags: ['change'],
      });
    }

    const referenceBytes = Buffer.from(
      `ref_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      'utf8'
    );
    const reference = referenceBytes.toString('base64');

    const allConsumedOutpoints = [
      ...resolvedExplicitInputs.map((i) => i.row.outpoint),
      ...feeSelectedUtxos.map((u) => u.outpoint),
    ];

    if (needsDeferredSignAction) {
      const unsignedTxHex = tx.toHex();
      const provisionalTxid = tx.id('hex');

      for (const outpoint of allConsumedOutpoints) {
        await db.runAsync(
          `UPDATE utxo_outputs SET pending_reference = ? WHERE outpoint = ?`,
          [reference, outpoint]
        );
      }

      await db.runAsync(
        `INSERT INTO brc100_actions (
          reference, txid, status, description, version, lock_time, satoshis,
          labels_json, inputs_json, outputs_json, raw_tx_hex, created_at
        ) VALUES (?, ?, 'unsigned', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reference,
          provisionalTxid,
          args.description,
          tx.version,
          tx.lockTime,
          totalOutputSatoshis,
          JSON.stringify(args.labels ?? []),
          JSON.stringify(allConsumedOutpoints),
          JSON.stringify(trackedOutputs),
          unsignedTxHex,
          Date.now(),
        ]
      );

      return {
        signableTransaction: {
          reference,
          tx: tx.toBinary(),
        },
      };
    }

    await tx.sign();
    const finalTxid = tx.id('hex');
    const signedRawHex = tx.toHex();

    // Mark spent inputs
    for (const outpoint of allConsumedOutpoints) {
      await db.runAsync(
        `UPDATE utxo_outputs
         SET spendable = 0, spent_by_txid = ?, pending_reference = NULL
         WHERE outpoint = ?`,
        [finalTxid, outpoint]
      );
    }

    // Track outputs assigned to baskets
    const noSendChangeOutpoints: string[] = [];
    for (const tracked of trackedOutputs) {
      if (tracked.basket) {
        const outpoint = `${finalTxid}.${tracked.vout}`;
        await this.insertOutputRow({
          outpoint,
          txid: finalTxid,
          vout: tracked.vout,
          satoshis: tracked.satoshis,
          lockingScript: tracked.lockingScript,
          basket: tracked.basket,
          spendable: true,
          customInstructions: tracked.customInstructions,
          outputDescription: tracked.outputDescription,
          tags: tracked.tags,
          labels: args.labels,
        });
        if (args.options?.noSend && tracked.basket === BRC100_BASKETS.DEFAULT) {
          noSendChangeOutpoints.push(outpoint);
        }
      }
    }

    const status = args.options?.noSend ? 'nosend' : 'completed';
    await db.runAsync(
      `INSERT INTO brc100_actions (
        reference, txid, status, description, version, lock_time, satoshis,
        labels_json, inputs_json, outputs_json, raw_tx_hex, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reference,
        finalTxid,
        status,
        args.description,
        tx.version,
        tx.lockTime,
        totalOutputSatoshis,
        JSON.stringify(args.labels ?? []),
        JSON.stringify(allConsumedOutpoints),
        JSON.stringify(trackedOutputs),
        signedRawHex,
        Date.now(),
      ]
    );

    return {
      txid: finalTxid,
      tx: args.options?.returnTXIDOnly ? undefined : tx.toBinary(),
      noSendChange:
        noSendChangeOutpoints.length > 0 ? noSendChangeOutpoints : undefined,
    };
  }

  /**
   * BRC-100 `signAction`:
   * Completes signing for a previously created `unsigned` action by reference.
   */
  public async signAction(
    args: SignActionArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<SignActionResult> {
    const db = await this.getDatabase();
    const actionRow = await db.getFirstAsync<StoredActionRow>(
      `SELECT * FROM brc100_actions WHERE reference = ?`,
      [args.reference]
    );

    if (!actionRow) {
      throw new Error(`No pending action found for reference: ${args.reference}`);
    }
    if (actionRow.status !== 'unsigned') {
      throw new Error(
        `Action ${args.reference} cannot be signed (current status: ${actionRow.status}).`
      );
    }

    const tx = Transaction.fromHex(actionRow.raw_tx_hex);
    for (const [inputIndexStr, spend] of Object.entries(args.spends)) {
      const idx = Number(inputIndexStr);
      if (tx.inputs[idx]) {
        tx.inputs[idx].unlockingScript = UnlockingScript.fromHex(
          spend.unlockingScript
        );
        if (spend.sequenceNumber !== undefined) {
          tx.inputs[idx].sequence = spend.sequenceNumber;
        }
      }
    }

    const finalTxid = tx.id('hex');
    const signedHex = tx.toHex();
    const consumedOutpoints = JSON.parse(actionRow.inputs_json) as string[];
    const trackedOutputs = JSON.parse(actionRow.outputs_json) as (
      CreateActionOutput & { vout: number }
    )[];
    const labels = JSON.parse(actionRow.labels_json) as string[];

    for (const outpoint of consumedOutpoints) {
      await db.runAsync(
        `UPDATE utxo_outputs
         SET spendable = 0, spent_by_txid = ?, pending_reference = NULL
         WHERE outpoint = ?`,
        [finalTxid, outpoint]
      );
    }

    for (const tracked of trackedOutputs) {
      if (tracked.basket) {
        await this.insertOutputRow({
          outpoint: `${finalTxid}.${tracked.vout}`,
          txid: finalTxid,
          vout: tracked.vout,
          satoshis: tracked.satoshis,
          lockingScript: tracked.lockingScript,
          basket: tracked.basket,
          spendable: true,
          customInstructions: tracked.customInstructions,
          outputDescription: tracked.outputDescription,
          tags: tracked.tags,
          labels,
        });
      }
    }

    const finalStatus = args.options?.noSend ? 'nosend' : 'completed';
    await db.runAsync(
      `UPDATE brc100_actions
       SET txid = ?, status = ?, raw_tx_hex = ?
       WHERE reference = ?`,
      [finalTxid, finalStatus, signedHex, args.reference]
    );

    return {
      txid: finalTxid,
      tx: args.options?.returnTXIDOnly ? undefined : tx.toBinary(),
    };
  }

  /**
   * BRC-100 `abortAction`:
   * Aborts an unsigned or nosend action and releases any reserved input UTXOs.
   */
  public async abortAction(
    args: AbortActionArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AbortActionResult> {
    const db = await this.getDatabase();
    const actionRow = await db.getFirstAsync<StoredActionRow>(
      `SELECT * FROM brc100_actions WHERE reference = ? OR txid = ?`,
      [args.reference, args.reference]
    );

    if (!actionRow) {
      throw new Error(`Action not found for reference: ${args.reference}`);
    }

    if (actionRow.status === 'completed') {
      return { aborted: false };
    }

    await db.runAsync(
      `UPDATE utxo_outputs
       SET pending_reference = NULL, spent_by_txid = NULL, spendable = 1
       WHERE pending_reference = ? OR spent_by_txid = ?`,
      [actionRow.reference, actionRow.txid]
    );

    await db.runAsync(
      `DELETE FROM utxo_outputs WHERE txid = ?`,
      [actionRow.txid]
    );

    await db.runAsync(
      `UPDATE brc100_actions SET status = 'failed' WHERE reference = ?`,
      [actionRow.reference]
    );

    return { aborted: true };
  }

  /**
   * BRC-100 `listOutputs`:
   * Queries unspent UTXOs in the specified basket (`default`, `bsv21`, or `1sat`)
   * with optional tag filtering (`all` or `any`).
   */
  public async listOutputs(
    args: ListOutputsArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListOutputsResult> {
    this.assertValidBasketName(args.basket);
    const db = await this.getDatabase();

    const rows = await db.getAllAsync<StoredUtxoRow>(
      `SELECT * FROM utxo_outputs
       WHERE basket = ?
         AND spendable = 1
         AND spent_by_txid IS NULL
         AND pending_reference IS NULL
       ORDER BY created_at ASC`,
      [args.basket]
    );

    const filterTags = args.tags ?? [];
    const tagMode = args.tagQueryMode ?? 'any';

    const matchedRows = rows.filter((row) => {
      if (filterTags.length === 0) {
        return true;
      }
      const rowTags = JSON.parse(row.tags_json) as string[];
      if (tagMode === 'all') {
        return filterTags.every((t) => rowTags.includes(t));
      }
      return filterTags.some((t) => rowTags.includes(t));
    });

    const offset = args.offset ?? 0;
    const limit = args.limit ?? 10;
    const paginatedRows =
      offset >= 0
        ? matchedRows.slice(offset, offset + limit)
        : matchedRows.slice().reverse().slice(Math.abs(offset) - 1, Math.abs(offset) - 1 + limit);

    const outputs: WalletOutput[] = paginatedRows.map((row) => {
      const out: WalletOutput = {
        outpoint: row.outpoint,
        satoshis: row.satoshis,
        spendable: row.spendable === 1,
      };
      if (args.include === 'locking scripts') {
        out.lockingScript = row.locking_script;
      }
      if (args.includeCustomInstructions && row.custom_instructions) {
        out.customInstructions = row.custom_instructions;
      }
      if (args.includeTags) {
        out.tags = JSON.parse(row.tags_json) as string[];
      }
      if (args.includeLabels) {
        out.labels = JSON.parse(row.labels_json) as string[];
      }
      return out;
    });

    return {
      totalOutputs: matchedRows.length,
      outputs,
    };
  }

  /**
   * BRC-100 `internalizeAction`:
   * Internalizes outputs from an incoming transaction into `'default'` (`wallet payment`)
   * or into an explicit basket (`basket insertion` into `'default'`, `'bsv21'`, or `'1sat'`).
   */
  public async internalizeAction(
    args: InternalizeActionArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<InternalizeActionResult> {
    let tx: Transaction;
    try {
      tx = Transaction.fromAtomicBEEF(args.tx);
    } catch {
      tx = Transaction.fromBinary(args.tx);
    }

    const txid = tx.id('hex');

    for (const internalizeOut of args.outputs) {
      const txOut = tx.outputs[internalizeOut.outputIndex];
      if (!txOut) {
        throw new Error(
          `Output index ${internalizeOut.outputIndex} does not exist on transaction ${txid}.`
        );
      }

      const outpoint = `${txid}.${internalizeOut.outputIndex}`;
      const satoshis = txOut.satoshis ?? 0;
      const lockingScriptHex = txOut.lockingScript.toHex();

      if (internalizeOut.protocol === 'wallet payment') {
        await this.insertOutputRow({
          outpoint,
          txid,
          vout: internalizeOut.outputIndex,
          satoshis,
          lockingScript: lockingScriptHex,
          basket: BRC100_BASKETS.DEFAULT,
          spendable: true,
          customInstructions: internalizeOut.paymentRemittance
            ? JSON.stringify(internalizeOut.paymentRemittance)
            : undefined,
          outputDescription: args.description,
          tags: ['payment'],
          labels: args.labels,
        });
      } else if (internalizeOut.protocol === 'basket insertion') {
        const insertion = internalizeOut.insertionRemittance;
        if (!insertion) {
          throw new Error(
            `Missing insertionRemittance for basket insertion at output ${internalizeOut.outputIndex}.`
          );
        }
        this.assertValidBasketName(insertion.basket);

        await this.insertOutputRow({
          outpoint,
          txid,
          vout: internalizeOut.outputIndex,
          satoshis,
          lockingScript: lockingScriptHex,
          basket: insertion.basket,
          spendable: true,
          customInstructions: insertion.customInstructions,
          outputDescription: args.description,
          tags: insertion.tags ?? [],
          labels: args.labels,
        });
      }
    }

    return { accepted: true };
  }

  /**
   * Returns a summary of balances and UTXO counts across all three isolated BRC-100 baskets.
   */
  public async getBasketSummaries(): Promise<
    Record<BasketName, { utxoCount: number; totalSatoshis: number }>
  > {
    const db = await this.getDatabase();
    const rows = await db.getAllAsync<{
      basket: BasketName;
      utxoCount: number;
      totalSatoshis: number | null;
    }>(
      `SELECT basket, COUNT(*) as utxoCount, SUM(satoshis) as totalSatoshis
       FROM utxo_outputs
       WHERE spendable = 1 AND spent_by_txid IS NULL AND pending_reference IS NULL
       GROUP BY basket`
    );

    const summary: Record<
      BasketName,
      { utxoCount: number; totalSatoshis: number }
    > = {
      [BRC100_BASKETS.DEFAULT]: { utxoCount: 0, totalSatoshis: 0 },
      [BRC100_BASKETS.BSV21]: { utxoCount: 0, totalSatoshis: 0 },
      [BRC100_BASKETS.ONESAT]: { utxoCount: 0, totalSatoshis: 0 },
    };

    for (const row of rows) {
      if (summary[row.basket]) {
        summary[row.basket] = {
          utxoCount: row.utxoCount,
          totalSatoshis: row.totalSatoshis ?? 0,
        };
      }
    }

    return summary;
  }

  /**
   * Formats a raw integer token amount using its decimal places.
   */
  public static formatTokenAmount(rawAmount: bigint, decimals: number): string {
    if (decimals <= 0) {
      return rawAmount.toString();
    }
    const rawStr = rawAmount.toString().padStart(decimals + 1, '0');
    const whole = rawStr.slice(0, rawStr.length - decimals);
    const fraction = rawStr
      .slice(rawStr.length - decimals)
      .replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  }

  /**
   * Aggregates unspent BSV-21 fungible token balances from `basket = 'bsv21'`.
   */
  public async getBsv21TokenBalances(): Promise<Bsv21TokenBalanceSummary[]> {
    const db = await this.getDatabase();
    const rows = await db.getAllAsync<StoredUtxoRow>(
      `SELECT * FROM utxo_outputs
       WHERE basket = 'bsv21'
         AND spendable = 1
         AND spent_by_txid IS NULL
         AND pending_reference IS NULL
       ORDER BY created_at ASC`
    );

    const grouped = new Map<
      string,
      {
        tokenId: string;
        symbol: string;
        decimals: number;
        totalRaw: bigint;
        outpoints: string[];
      }
    >();

    for (const row of rows) {
      const cleanTokenId = (row.token_id ?? '').replace(/^token_id_/, '');
      if (!cleanTokenId) {
        continue;
      }
      const symbol = row.symbol ?? 'TOKEN';
      const decimals = row.decimals ?? 0;
      let amtBig = 0n;
      try {
        amtBig = BigInt(row.amount ?? '0');
      } catch {
        amtBig = 0n;
      }

      const existing = grouped.get(cleanTokenId);
      if (existing) {
        existing.totalRaw += amtBig;
        existing.outpoints.push(row.outpoint);
      } else {
        grouped.set(cleanTokenId, {
          tokenId: cleanTokenId,
          symbol,
          decimals,
          totalRaw: amtBig,
          outpoints: [row.outpoint],
        });
      }
    }

    return Array.from(grouped.values()).map((item) => ({
      tokenId: item.tokenId,
      symbol: item.symbol,
      decimals: item.decimals,
      rawAmount: item.totalRaw.toString(),
      formattedAmount: Brc100WalletEngine.formatTokenAmount(
        item.totalRaw,
        item.decimals
      ),
      utxoCount: item.outpoints.length,
      outpoints: item.outpoints,
    }));
  }

  /**
   * Lists unspent 1Sat Ordinal NFTs from `basket = '1sat'`.
   */
  public async get1SatNftCollectibles(): Promise<OneSatNftItem[]> {
    const db = await this.getDatabase();
    const rows = await db.getAllAsync<StoredUtxoRow>(
      `SELECT * FROM utxo_outputs
       WHERE basket = '1sat'
         AND spendable = 1
         AND spent_by_txid IS NULL
         AND pending_reference IS NULL
       ORDER BY created_at DESC`
    );

    return rows.map((row) => {
      let contentPreview: string | undefined;
      if (row.custom_instructions) {
        try {
          const parsed = JSON.parse(row.custom_instructions) as {
            contentPreview?: string;
          };
          contentPreview = parsed.contentPreview;
        } catch {
          // Ignore non-JSON custom instructions
        }
      }

      const cleanOrigin = (row.origin ?? row.outpoint.replace('.', '_')).replace(
        /^origin_/,
        ''
      );

      return {
        outpoint: row.outpoint,
        txid: row.txid,
        vout: row.vout,
        origin: cleanOrigin,
        contentType: row.content_type ?? 'text/plain',
        name: row.name ?? `1Sat #${cleanOrigin.slice(0, 8)}`,
        satoshis: row.satoshis,
        lockingScript: row.locking_script,
        contentPreview,
        tags: JSON.parse(row.tags_json) as string[],
      };
    });
  }

  // Additional BRC-100 WalletInterface methods delegated to ProtoWallet / SQLite

  public async verifySignature(
    args: VerifySignatureArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<VerifySignatureResult> {
    return this.getProtoWallet().verifySignature(args);
  }

  public async encrypt(
    args: WalletEncryptArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<WalletEncryptResult> {
    return this.getProtoWallet().encrypt(args);
  }

  public async decrypt(
    args: WalletDecryptArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<WalletDecryptResult> {
    return this.getProtoWallet().decrypt(args);
  }

  public async createHmac(
    args: CreateHmacArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateHmacResult> {
    return this.getProtoWallet().createHmac(args);
  }

  public async verifyHmac(
    args: VerifyHmacArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<VerifyHmacResult> {
    return this.getProtoWallet().verifyHmac(args);
  }

  public async revealCounterpartyKeyLinkage(
    args: RevealCounterpartyKeyLinkageArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RevealCounterpartyKeyLinkageResult> {
    return this.getProtoWallet().revealCounterpartyKeyLinkage(args);
  }

  public async revealSpecificKeyLinkage(
    args: RevealSpecificKeyLinkageArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RevealSpecificKeyLinkageResult> {
    return this.getProtoWallet().revealSpecificKeyLinkage(args);
  }

  public async listActions(
    args: ListActionsArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListActionsResult> {
    const db = await this.getDatabase();
    const rows = await db.getAllAsync<StoredActionRow>(
      `SELECT * FROM brc100_actions ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [args.limit ?? 10, args.offset ?? 0]
    );

    return {
      totalActions: rows.length,
      actions: rows.map((r) => ({
        txid: r.txid,
        satoshis: r.satoshis,
        status: r.status as 'completed' | 'unsigned' | 'nosend' | 'failed',
        isOutgoing: true,
        description: r.description,
        labels: args.includeLabels
          ? (JSON.parse(r.labels_json) as string[])
          : undefined,
        version: r.version,
        lockTime: r.lock_time,
      })),
    };
  }

  public async relinquishOutput(
    args: RelinquishOutputArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RelinquishOutputResult> {
    this.assertValidBasketName(args.basket);
    const db = await this.getDatabase();
    await db.runAsync(
      `DELETE FROM utxo_outputs WHERE basket = ? AND outpoint = ?`,
      [args.basket, args.output]
    );
    return { relinquished: true };
  }

  public async acquireCertificate(
    _args: AcquireCertificateArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AcquireCertificateResult> {
    throw new Error('Certificate acquisition not configured on offline mobile storage.');
  }

  public async listCertificates(
    _args: ListCertificatesArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListCertificatesResult> {
    return { totalCertificates: 0, certificates: [] };
  }

  public async proveCertificate(
    _args: ProveCertificateArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ProveCertificateResult> {
    return { keyringForVerifier: {} };
  }

  public async relinquishCertificate(
    _args: RelinquishCertificateArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RelinquishCertificateResult> {
    return { relinquished: true };
  }

  public async discoverByIdentityKey(
    _args: DiscoverByIdentityKeyArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    return { totalCertificates: 0, certificates: [] };
  }

  public async discoverByAttributes(
    _args: DiscoverByAttributesArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    return { totalCertificates: 0, certificates: [] };
  }

  public async isAuthenticated(
    _args: object,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AuthenticatedResult> {
    if (!this.keyVault.isUnlocked()) {
      throw new Error('Wallet is currently locked.');
    }
    return { authenticated: true };
  }

  public async waitForAuthentication(
    _args: object,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AuthenticatedResult> {
    if (!this.keyVault.isUnlocked()) {
      await this.keyVault.unlockWallet();
    }
    return { authenticated: true };
  }

  public async getHeight(
    _args: object,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetHeightResult> {
    return { height: 880000 };
  }

  public async getHeaderForHeight(
    _args: GetHeaderArgs,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetHeaderResult> {
    return { header: '00'.repeat(80) };
  }

  public async getNetwork(
    _args: object,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetNetworkResult> {
    return { network: this.network };
  }

  public async getVersion(
    _args: object,
    _originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetVersionResult> {
    return { version: 'nfcwallet-1.0.0' };
  }
}

export const brc100WalletEngine = new Brc100WalletEngine();
