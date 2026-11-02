import { Buffer } from 'buffer';
import {
  type CreateActionInput,
  type CreateActionOutput,
  P2PKH,
  Transaction,
} from '@bsv/sdk';
import { BRC100_BASKETS } from '@/constants/baskets';
import {
  type ArcBroadcastResponse,
  NetworkConfigService,
  networkConfigService,
} from '@/services/network/NetworkConfig';
import {
  Brc100WalletEngine,
  brc100WalletEngine,
  buildBsv21Tags,
  parseAndValidateBsv21Tags,
} from './Brc100WalletEngine';
import { KeyVaultService, keyVaultService } from './KeyVaultService';

export interface TransactionSendResult {
  txid: string;
  rawTxHex: string;
  feeRateSatsPerKb: number;
  broadcast: ArcBroadcastResponse;
}

/**
 * Encodes a byte buffer as a Bitcoin Script minimal pushdata hex string.
 */
function encodePushDataHex(data: Buffer): string {
  const len = data.length;
  const dataHex = data.toString('hex');
  if (len < 0x4c) {
    return len.toString(16).padStart(2, '0') + dataHex;
  }
  if (len <= 0xff) {
    return '4c' + len.toString(16).padStart(2, '0') + dataHex;
  }
  if (len <= 0xffff) {
    const lo = (len & 0xff).toString(16).padStart(2, '0');
    const hi = ((len >> 8) & 0xff).toString(16).padStart(2, '0');
    return '4d' + lo + hi + dataHex;
  }
  throw new Error('Inscription payload exceeds 65535 bytes');
}

/**
 * Constructs a P2PKH + 1Sat Ordinal `application/bsv-20` (BSV-21) `transfer` locking script.
 */
export function buildBsv21TransferLockingScriptHex(
  recipientAddress: string,
  tokenId: string,
  amount: bigint
): string {
  const p2pkhHex = new P2PKH().lock(recipientAddress).toHex();
  const canonicalTokenId = tokenId.replace(/^token_id_/, '');
  const payloadJson = JSON.stringify({
    p: 'bsv-20',
    op: 'transfer',
    id: canonicalTokenId,
    amt: amount.toString(),
  });

  const mimeBytes = Buffer.from('application/bsv-20', 'utf8');
  const payloadBytes = Buffer.from(payloadJson, 'utf8');

  // OP_FALSE (00) OP_IF (63) "ord" (036f7264) OP_1 (51) <mime> OP_0 (00) <payload> OP_ENDIF (68)
  const ordEnvelopeHex =
    '0063036f726451' +
    encodePushDataHex(mimeBytes) +
    '00' +
    encodePushDataHex(payloadBytes) +
    '68';

  return p2pkhHex + ordEnvelopeHex;
}

export class TransactionBuilder {
  private readonly walletEngine: Brc100WalletEngine;
  private readonly keyVault: KeyVaultService;
  private readonly networkConfig: NetworkConfigService;

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
   * 1. `sendBsv(recipientAddress, satoshis)`:
   * Calls `createAction` using `default` basket inputs, calculates fees via ARC fee rate,
   * signs, and broadcasts via ARC.
   */
  public async sendBsv(
    recipientAddress: string,
    satoshis: number
  ): Promise<TransactionSendResult> {
    if (!recipientAddress.trim()) {
      throw new Error('Recipient BSV address is required.');
    }
    if (!Number.isInteger(satoshis) || satoshis < 1) {
      throw new Error('Satoshis amount must be a positive integer (>= 1).');
    }

    const feeQuote = await this.networkConfig.fetchArcFeeQuote();
    const recipientLockingScript = new P2PKH().lock(recipientAddress.trim()).toHex();

    const actionResult = await this.walletEngine.createAction({
      description: `Send ${satoshis} sats to ${recipientAddress.slice(0, 10)}...`,
      outputs: [
        {
          lockingScript: recipientLockingScript,
          satoshis,
          outputDescription: 'Standard BSV P2PKH payment output',
        },
      ],
      labels: ['send-bsv', BRC100_BASKETS.DEFAULT],
      feeRateSatsPerKb: feeQuote.satoshisPerKilobyte,
      options: {
        signAndProcess: true,
        randomizeOutputs: false,
      },
    });

    if (!actionResult.tx || !actionResult.txid) {
      throw new Error('Failed to sign BSV transaction in createAction.');
    }

    const rawTxHex = Transaction.fromBinary(actionResult.tx).toHex();
    const broadcast = await this.networkConfig.broadcastTransaction(rawTxHex);

    return {
      txid: actionResult.txid,
      rawTxHex,
      feeRateSatsPerKb: feeQuote.satoshisPerKilobyte,
      broadcast,
    };
  }

  /**
   * 2. `sendBsv21Token(tokenId, recipientAddress, tokenAmount)`:
   * Selects token UTXOs from `listOutputs({ basket: 'bsv21', tags: [...] })`,
   * constructs the BSV-21 `transfer` inscription output for the recipient (and token change
   * output back to self if partial), funds the BSV network fee strictly from the `default`
   * basket, signs, and broadcasts via ARC.
   */
  public async sendBsv21Token(
    tokenId: string,
    recipientAddress: string,
    tokenAmount: bigint
  ): Promise<TransactionSendResult> {
    if (!recipientAddress.trim()) {
      throw new Error('Recipient BSV address is required.');
    }
    if (tokenAmount <= 0n) {
      throw new Error('Token transfer amount must be greater than zero.');
    }

    const normalizedTokenId = tokenId.replace(/^token_id_/, '').replace('.', '_');
    const tokenTagFilter = `token_id_${normalizedTokenId}`;

    const listResult = await this.walletEngine.listOutputs({
      basket: BRC100_BASKETS.BSV21,
      tags: [tokenTagFilter, `id:${normalizedTokenId}`],
      tagQueryMode: 'any',
      includeTags: true,
      include: 'locking scripts',
      limit: 500,
    });

    if (listResult.outputs.length === 0) {
      throw new Error(`No unspent BSV-21 token outputs found for token ${normalizedTokenId}.`);
    }

    const selectedTokenInputs: CreateActionInput[] = [];
    let accumulatedTokenAmount = 0n;
    let tokenSymbol = 'BSV21';
    let tokenDecimals = 0;

    for (const out of listResult.outputs) {
      const parsedMeta = parseAndValidateBsv21Tags(out.tags ?? []);
      tokenSymbol = parsedMeta.symbol;
      tokenDecimals = parsedMeta.decimals;

      const utxoTokenAmount = BigInt(parsedMeta.amount);
      selectedTokenInputs.push({
        outpoint: out.outpoint,
        inputDescription: `[allow-bsv21-spend] Spend ${parsedMeta.symbol} carrier output`,
      });
      accumulatedTokenAmount += utxoTokenAmount;

      if (accumulatedTokenAmount >= tokenAmount) {
        break;
      }
    }

    if (accumulatedTokenAmount < tokenAmount) {
      throw new Error(
        `Insufficient ${tokenSymbol} balance: requested ${tokenAmount.toString()}, available ${accumulatedTokenAmount.toString()}.`
      );
    }

    const outputs: CreateActionOutput[] = [
      {
        lockingScript: buildBsv21TransferLockingScriptHex(
          recipientAddress.trim(),
          normalizedTokenId,
          tokenAmount
        ),
        satoshis: 1,
        outputDescription: `BSV-21 transfer of ${tokenAmount.toString()} ${tokenSymbol}`,
      },
    ];

    // If partial spend, create a 1-satoshi BSV-21 change output back to self in 'bsv21' basket
    const remainingTokenChange = accumulatedTokenAmount - tokenAmount;
    if (remainingTokenChange > 0n) {
      const selfAddress =
        this.keyVault.getUnlockedMetadata()?.address ??
        this.keyVault.getRootPrivateKey().toPublicKey().toAddress();

      outputs.push({
        lockingScript: buildBsv21TransferLockingScriptHex(
          selfAddress,
          normalizedTokenId,
          remainingTokenChange
        ),
        satoshis: 1,
        outputDescription: `BSV-21 token change (${tokenSymbol})`,
        basket: BRC100_BASKETS.BSV21,
        tags: buildBsv21Tags({
          txidVout: normalizedTokenId,
          symbol: tokenSymbol,
          decimals: tokenDecimals,
          amount: remainingTokenChange.toString(),
        }),
      });
    }

    const feeQuote = await this.networkConfig.fetchArcFeeQuote();

    // `createAction` automatically funds the BSV network fee strictly from `basket = 'default'`
    const actionResult = await this.walletEngine.createAction({
      description: `Transfer ${tokenSymbol} (BSV-21)`,
      inputs: selectedTokenInputs,
      outputs,
      labels: ['send-bsv21', BRC100_BASKETS.BSV21],
      carrierSpendFlags: {
        allowBsv21Spend: true,
      },
      feeRateSatsPerKb: feeQuote.satoshisPerKilobyte,
      options: {
        signAndProcess: true,
        randomizeOutputs: false,
      },
    });

    if (!actionResult.tx || !actionResult.txid) {
      throw new Error('Failed to sign BSV-21 transfer transaction.');
    }

    const rawTxHex = Transaction.fromBinary(actionResult.tx).toHex();
    const broadcast = await this.networkConfig.broadcastTransaction(rawTxHex);

    return {
      txid: actionResult.txid,
      rawTxHex,
      feeRateSatsPerKb: feeQuote.satoshisPerKilobyte,
      broadcast,
    };
  }

  /**
   * 3. `send1SatNft(outpoint, recipientAddress)`:
   * Transfers the exact 1-satoshi NFT UTXO from the `1sat` basket at input index 0
   * to output index 0 (preserving ordinal satpoint alignment) while funding the
   * transaction fee from a `default` basket input at index 1.
   */
  public async send1SatNft(
    outpoint: string,
    recipientAddress: string
  ): Promise<TransactionSendResult> {
    if (!recipientAddress.trim()) {
      throw new Error('Recipient BSV address is required.');
    }

    const nftList = await this.walletEngine.listOutputs({
      basket: BRC100_BASKETS.ONESAT,
      includeTags: true,
      include: 'locking scripts',
      limit: 500,
    });

    const nftOutput = nftList.outputs.find((o) => o.outpoint === outpoint);
    if (!nftOutput) {
      throw new Error(
        `1Sat Ordinal NFT UTXO (${outpoint}) not found in '1sat' basket.`
      );
    }

    // Select a fee-funding UTXO from the 'default' basket to place at input index 1
    const defaultList = await this.walletEngine.listOutputs({
      basket: BRC100_BASKETS.DEFAULT,
      include: 'locking scripts',
      limit: 100,
    });

    const feeFundingUtxo = defaultList.outputs.find((u) => u.satoshis >= 20);
    if (!feeFundingUtxo) {
      throw new Error(
        "Insufficient funds in 'default' BSV basket to pay network fee for 1Sat NFT transfer."
      );
    }

    const feeQuote = await this.networkConfig.fetchArcFeeQuote();
    const recipientP2pkhScript = new P2PKH()
      .lock(recipientAddress.trim())
      .toHex();

    // Input index 0: 1Sat NFT UTXO from '1sat' basket
    // Input index 1: Fee funding UTXO from 'default' basket
    // Output index 0: 1-satoshi NFT output to recipient (preserving satpoint alignment)
    const actionResult = await this.walletEngine.createAction({
      description: `Transfer 1Sat Ordinal NFT (${outpoint.slice(0, 12)}...)`,
      inputs: [
        {
          outpoint: nftOutput.outpoint,
          inputDescription:
            '[allow-1sat-spend] 1Sat Ordinal NFT input at index 0',
        },
        {
          outpoint: feeFundingUtxo.outpoint,
          inputDescription: 'Default basket fee funding input at index 1',
        },
      ],
      outputs: [
        {
          lockingScript: recipientP2pkhScript,
          satoshis: 1,
          outputDescription: '1Sat Ordinal NFT recipient output at index 0',
        },
      ],
      labels: ['send-1sat', BRC100_BASKETS.ONESAT],
      carrierSpendFlags: {
        allow1SatSpend: true,
      },
      feeRateSatsPerKb: feeQuote.satoshisPerKilobyte,
      options: {
        signAndProcess: true,
        randomizeOutputs: false,
      },
    });

    if (!actionResult.tx || !actionResult.txid) {
      throw new Error('Failed to sign 1Sat Ordinal NFT transfer transaction.');
    }

    const rawTxHex = Transaction.fromBinary(actionResult.tx).toHex();
    const broadcast = await this.networkConfig.broadcastTransaction(rawTxHex);

    return {
      txid: actionResult.txid,
      rawTxHex,
      feeRateSatsPerKb: feeQuote.satoshisPerKilobyte,
      broadcast,
    };
  }
}

export const transactionBuilder = new TransactionBuilder();
