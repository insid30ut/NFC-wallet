/**
 * Unified Payment URI Parser and Encoder for BRC-100 BSV Wallet.
 *
 * Supports:
 *  a) Raw BSV addresses (Mainnet/Testnet P2PKH) or Paymails (alias@domain.tld)
 *  b) BIP-21 BSV URIs: bitcoin:<address>?sv&amount=<bsvAmount>&label=<note>
 *  c) BSV-21 Token Request URIs: bitcoin:<address>?sv&asset=bsv21&tokenId=<txid_vout>&tokenAmount=<amount>
 *  d) 1Sat NFT Transfer Request URIs: bitcoin:<address>?sv&asset=1sat&outpoint=<txid.vout>
 *  e) BRC-100 JSON Action Request payloads (for dApp-to-wallet signing requests)
 */

export type PaymentRequestKind =
  | 'address'
  | 'paymail'
  | 'bip21'
  | 'bsv21'
  | '1sat'
  | 'brc100-action';

export type PaymentUriErrorCode =
  | 'EMPTY_INPUT'
  | 'MALFORMED_URI'
  | 'UNSUPPORTED_ASSET'
  | 'INVALID_RECIPIENT'
  | 'INVALID_AMOUNT'
  | 'MISSING_TOKEN_PARAMS'
  | 'INVALID_TOKEN_ID'
  | 'INVALID_TOKEN_AMOUNT'
  | 'MISSING_NFT_OUTPOINT'
  | 'INVALID_NFT_OUTPOINT'
  | 'INVALID_BRC100_JSON';

export class PaymentUriCodecError extends Error {
  public readonly code: PaymentUriErrorCode;

  constructor(code: PaymentUriErrorCode, message: string) {
    super(message);
    this.name = 'PaymentUriCodecError';
    this.code = code;
  }
}

export interface Brc100ActionOutputSpec {
  lockingScript: string;
  satoshis: number;
  outputDescription?: string;
  basket?: 'default' | 'bsv21' | '1sat';
  tags?: string[];
  customInstructions?: string;
}

export interface Brc100ActionRequestPayload {
  protocol: 'brc-100';
  method: 'createAction';
  originator?: string;
  description: string;
  outputs: Brc100ActionOutputSpec[];
  labels?: string[];
}

export interface DecodedAddressRequest {
  kind: 'address';
  asset: 'bsv';
  recipient: string;
  raw: string;
}

export interface DecodedPaymailRequest {
  kind: 'paymail';
  asset: 'bsv';
  recipient: string;
  raw: string;
}

export interface DecodedBip21Request {
  kind: 'bip21';
  asset: 'bsv';
  recipient: string;
  amountBsv?: number;
  satoshis?: number;
  label?: string;
  message?: string;
  hasSvFlag: boolean;
  raw: string;
}

export interface DecodedBsv21Request {
  kind: 'bsv21';
  asset: 'bsv21';
  recipient: string;
  tokenId: string;
  tokenAmount: string;
  tokenAmountBigInt?: bigint;
  symbol?: string;
  decimals?: number;
  label?: string;
  hasSvFlag: boolean;
  raw: string;
}

export interface Decoded1SatNftRequest {
  kind: '1sat';
  asset: '1sat';
  recipient: string;
  outpoint: string;
  outpointUnderscore: string;
  name?: string;
  label?: string;
  hasSvFlag: boolean;
  raw: string;
}

export interface DecodedBrc100ActionRequest {
  kind: 'brc100-action';
  asset: 'brc100';
  recipient: string;
  action: Brc100ActionRequestPayload;
  totalSatoshis: number;
  raw: string;
}

export type DecodedPaymentRequest =
  | DecodedAddressRequest
  | DecodedPaymailRequest
  | DecodedBip21Request
  | DecodedBsv21Request
  | Decoded1SatNftRequest
  | DecodedBrc100ActionRequest;

export type EncodePaymentRequestInput =
  | {
      kind: 'address';
      recipient: string;
    }
  | {
      kind: 'paymail';
      recipient: string;
    }
  | {
      kind: 'bip21';
      recipient: string;
      amountBsv?: number;
      satoshis?: number;
      label?: string;
      message?: string;
    }
  | {
      kind: 'bsv21';
      recipient: string;
      tokenId: string;
      tokenAmount: string | bigint | number;
      symbol?: string;
      decimals?: number;
      label?: string;
    }
  | {
      kind: '1sat';
      recipient: string;
      outpoint: string;
      name?: string;
      label?: string;
    }
  | {
      kind: 'brc100-action';
      action: Brc100ActionRequestPayload;
    };

const SATS_PER_BSV = 100_000_000;
const MAX_BSV_SUPPLY = 21_000_000;

/**
 * Base58 P2PKH address pattern for BSV Mainnet ('1') and Testnet ('m' or 'n').
 */
const BSV_ADDRESS_REGEX =
  /^[1mn][123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{24,34}$/;

/**
 * Standard Paymail handle pattern: alias@domain.tld
 */
const PAYMAIL_REGEX = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;

/**
 * Outpoint / Token ID pattern: 64-hex txid followed by '_' or '.' and non-negative integer vout.
 */
const OUTPOINT_REGEX = /^([0-9a-fA-F]{64})([_.])(0|[1-9][0-9]*)$/;

/**
 * Hex lockingScript validation pattern.
 */
const HEX_REGEX = /^(?:[0-9a-fA-F]{2})+$/;

export function isValidBsvAddress(value: string): boolean {
  return BSV_ADDRESS_REGEX.test(value.trim());
}

export function isValidPaymail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length > 254) {
    return false;
  }
  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return false;
  }
  const [local, domain] = parts;
  if (!local || !domain || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return false;
  }
  if (domain.startsWith('-') || domain.endsWith('-') || domain.includes('..')) {
    return false;
  }
  const domainLabels = domain.split('.');
  const tld = domainLabels[domainLabels.length - 1];
  if (!tld || tld.length < 2 || !/^[a-zA-Z]{2,}$/.test(tld)) {
    return false;
  }
  return PAYMAIL_REGEX.test(trimmed);
}

export function isValidRecipient(value: string): boolean {
  return isValidBsvAddress(value) || isValidPaymail(value);
}

/**
 * Normalize an outpoint or tokenId separator to either '_' (BSV-21 standard) or '.' (1Sat standard).
 */
export function normalizeOutpointSeparator(
  rawOutpoint: string,
  separator: '_' | '.'
): string | null {
  const match = OUTPOINT_REGEX.exec(rawOutpoint.trim());
  if (!match) {
    return null;
  }
  const [, txid, , vout] = match;
  return `${txid.toLowerCase()}${separator}${vout}`;
}

/**
 * Convert a BSV decimal number into integer satoshis, validating precision and bounds.
 */
export function bsvDecimalToSatoshis(amountStrOrNum: string | number): {
  amountBsv: number;
  satoshis: number;
} {
  const str =
    typeof amountStrOrNum === 'number' ? String(amountStrOrNum) : amountStrOrNum.trim();

  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(str)) {
    throw new PaymentUriCodecError(
      'INVALID_AMOUNT',
      `Invalid BSV amount "${String(amountStrOrNum)}". Must be a positive number with up to 8 decimals.`
    );
  }

  const parsed = Number(str);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_BSV_SUPPLY) {
    throw new PaymentUriCodecError(
      'INVALID_AMOUNT',
      `BSV amount "${str}" is out of valid range (0 < amount <= ${MAX_BSV_SUPPLY}).`
    );
  }

  const satoshis = Math.round(parsed * SATS_PER_BSV);
  if (satoshis <= 0) {
    throw new PaymentUriCodecError(
      'INVALID_AMOUNT',
      `BSV amount "${str}" must be at least 1 satoshi (0.00000001 BSV).`
    );
  }

  return {
    amountBsv: satoshis / SATS_PER_BSV,
    satoshis,
  };
}

/**
 * Format integer satoshis into a clean BSV decimal string without trailing zeros.
 */
export function satoshisToBsvString(satoshis: number): string {
  if (!Number.isInteger(satoshis) || satoshis <= 0) {
    throw new PaymentUriCodecError(
      'INVALID_AMOUNT',
      `Satoshis must be a positive integer, received: ${satoshis}`
    );
  }
  const whole = Math.floor(satoshis / SATS_PER_BSV);
  const fraction = satoshis % SATS_PER_BSV;
  if (fraction === 0) {
    return String(whole);
  }
  const fractionStr = String(fraction).padStart(8, '0').replace(/0+$/, '');
  return `${whole}.${fractionStr}`;
}

/**
 * Safely decode a URI query component.
 */
function safeDecodeUriComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'));
  } catch {
    throw new PaymentUriCodecError(
      'MALFORMED_URI',
      `Malformed percent-encoding in URI component: "${raw}"`
    );
  }
}

/**
 * Parse a query string into a key-value map and track valueless flags (such as `?sv`).
 */
function parseQueryString(query: string): {
  params: Record<string, string>;
  flags: Set<string>;
} {
  const params: Record<string, string> = {};
  const flags = new Set<string>();

  if (!query.trim()) {
    return { params, flags };
  }

  const pairs = query.split('&');
  for (const pair of pairs) {
    if (pair.length === 0) {
      throw new PaymentUriCodecError('MALFORMED_URI', 'Empty query parameter segment in URI.');
    }
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      const flagName = safeDecodeUriComponent(pair).trim().toLowerCase();
      if (!flagName) {
        throw new PaymentUriCodecError('MALFORMED_URI', 'Empty query flag in URI.');
      }
      flags.add(flagName);
    } else {
      const rawKey = pair.slice(0, eqIndex);
      const rawValue = pair.slice(eqIndex + 1);
      const key = safeDecodeUriComponent(rawKey).trim();
      if (!key) {
        throw new PaymentUriCodecError('MALFORMED_URI', 'Query parameter is missing a key name.');
      }
      const value = safeDecodeUriComponent(rawValue);
      params[key] = value;
      if (key.toLowerCase() === 'sv' && (value === '' || value === '1' || value === 'true')) {
        flags.add('sv');
      }
    }
  }

  return { params, flags };
}

/**
 * Parse and validate a BRC-100 JSON Action Request payload.
 */
function parseBrc100JsonRequest(rawJson: string): DecodedBrc100ActionRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new PaymentUriCodecError(
      'INVALID_BRC100_JSON',
      `Malformed JSON in BRC-100 Action Request: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PaymentUriCodecError(
      'INVALID_BRC100_JSON',
      'BRC-100 Action Request must be a JSON object.'
    );
  }

  const root = parsed as Record<string, unknown>;

  // Support nested `{ protocol: 'brc-100', method: 'createAction', params/args: { ... } }`
  // or direct `{ protocol: 'brc-100', method: 'createAction', description, outputs }`.
  const nestedArgs =
    root.args && typeof root.args === 'object' && !Array.isArray(root.args)
      ? (root.args as Record<string, unknown>)
      : root.params && typeof root.params === 'object' && !Array.isArray(root.params)
        ? (root.params as Record<string, unknown>)
        : root;

  const method =
    typeof root.method === 'string'
      ? root.method
      : typeof root.action === 'string'
        ? root.action
        : 'createAction';

  if (method !== 'createAction') {
    throw new PaymentUriCodecError(
      'INVALID_BRC100_JSON',
      `Unsupported BRC-100 method "${String(method)}". Only "createAction" is supported via QR/URI.`
    );
  }

  const description =
    typeof nestedArgs.description === 'string' ? nestedArgs.description.trim() : '';
  if (!description || description.length < 5 || description.length > 50) {
    throw new PaymentUriCodecError(
      'INVALID_BRC100_JSON',
      'BRC-100 createAction requires a description between 5 and 50 characters.'
    );
  }

  if (!Array.isArray(nestedArgs.outputs) || nestedArgs.outputs.length === 0) {
    throw new PaymentUriCodecError(
      'INVALID_BRC100_JSON',
      'BRC-100 createAction requires a non-empty outputs array.'
    );
  }

  let totalSatoshis = 0;
  const outputs: Brc100ActionOutputSpec[] = nestedArgs.outputs.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new PaymentUriCodecError(
        'INVALID_BRC100_JSON',
        `Output at index ${idx} must be an object.`
      );
    }
    const out = item as Record<string, unknown>;
    const lockingScript =
      typeof out.lockingScript === 'string' ? out.lockingScript.trim() : '';
    if (!lockingScript || !HEX_REGEX.test(lockingScript)) {
      throw new PaymentUriCodecError(
        'INVALID_BRC100_JSON',
        `Output at index ${idx} has an invalid hex lockingScript.`
      );
    }

    const satoshis = typeof out.satoshis === 'number' ? out.satoshis : Number(out.satoshis);
    if (!Number.isInteger(satoshis) || satoshis < 0) {
      throw new PaymentUriCodecError(
        'INVALID_BRC100_JSON',
        `Output at index ${idx} has an invalid satoshis integer.`
      );
    }
    totalSatoshis += satoshis;

    const basket =
      out.basket === 'default' || out.basket === 'bsv21' || out.basket === '1sat'
        ? out.basket
        : undefined;

    const tags = Array.isArray(out.tags)
      ? out.tags.filter((t): t is string => typeof t === 'string')
      : undefined;

    return {
      lockingScript,
      satoshis,
      outputDescription:
        typeof out.outputDescription === 'string' ? out.outputDescription : undefined,
      basket,
      tags,
      customInstructions:
        typeof out.customInstructions === 'string' ? out.customInstructions : undefined,
    };
  });

  const originator =
    typeof root.originator === 'string' && root.originator.trim()
      ? root.originator.trim()
      : typeof nestedArgs.originator === 'string' && nestedArgs.originator.trim()
        ? nestedArgs.originator.trim()
        : undefined;

  const labels = Array.isArray(nestedArgs.labels)
    ? nestedArgs.labels.filter((l): l is string => typeof l === 'string')
    : undefined;

  return {
    kind: 'brc100-action',
    asset: 'brc100',
    recipient: originator ?? `BRC-100 dApp (${outputs.length} output${outputs.length === 1 ? '' : 's'})`,
    action: {
      protocol: 'brc-100',
      method: 'createAction',
      originator,
      description,
      outputs,
      labels,
    },
    totalSatoshis,
    raw: rawJson.trim(),
  };
}

/**
 * Decode any supported payment QR / URI / NFC string into a strongly typed DecodedPaymentRequest.
 */
export function decodePaymentRequest(rawString: string): DecodedPaymentRequest {
  if (typeof rawString !== 'string' || !rawString.trim()) {
    throw new PaymentUriCodecError('EMPTY_INPUT', 'Payment request string cannot be empty.');
  }

  const trimmed = rawString.trim();

  // 1. Check for BRC-100 JSON Action Request payload
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseBrc100JsonRequest(trimmed);
  }

  // 2. Check for `paymail:` prefix
  if (/^paymail:/i.test(trimmed)) {
    const handle = trimmed.replace(/^paymail:(?:\/\/)?/i, '').trim();
    if (!isValidPaymail(handle)) {
      throw new PaymentUriCodecError(
        'INVALID_RECIPIENT',
        `Invalid Paymail handle "${handle}".`
      );
    }
    return {
      kind: 'paymail',
      asset: 'bsv',
      recipient: handle.toLowerCase(),
      raw: trimmed,
    };
  }

  // 3. Check for `bitcoin:` scheme URI (BIP-21 BSV, BSV-21 Token, or 1Sat NFT)
  if (/^bitcoin:/i.test(trimmed)) {
    // Reject double question marks or whitespace inside the URI body
    const withoutScheme = trimmed.slice('bitcoin:'.length).replace(/^\/\//, '');
    if (!withoutScheme) {
      throw new PaymentUriCodecError('MALFORMED_URI', 'Bitcoin URI is missing recipient address.');
    }

    const firstQuestionMark = withoutScheme.indexOf('?');
    if (
      firstQuestionMark !== -1 &&
      withoutScheme.indexOf('?', firstQuestionMark + 1) !== -1
    ) {
      throw new PaymentUriCodecError(
        'MALFORMED_URI',
        'Malformed URI: multiple "?" query delimiters found.'
      );
    }

    const rawRecipient =
      firstQuestionMark === -1
        ? withoutScheme
        : withoutScheme.slice(0, firstQuestionMark);
    const queryString =
      firstQuestionMark === -1 ? '' : withoutScheme.slice(firstQuestionMark + 1);

    const recipient = safeDecodeUriComponent(rawRecipient).trim();
    if (!recipient || !isValidRecipient(recipient)) {
      throw new PaymentUriCodecError(
        'INVALID_RECIPIENT',
        `Invalid BSV address or Paymail in URI: "${recipient}"`
      );
    }

    const normalizedRecipient = isValidPaymail(recipient)
      ? recipient.toLowerCase()
      : recipient;

    const { params, flags } = parseQueryString(queryString);
    const hasSvFlag = flags.has('sv');
    const assetParam = params.asset ? params.asset.trim().toLowerCase() : 'bsv';
    const label = params.label?.trim() || undefined;
    const message = params.message?.trim() || undefined;

    if (assetParam === 'bsv21') {
      const rawTokenId = params.tokenId?.trim() ?? '';
      const rawTokenAmount = params.tokenAmount?.trim() ?? '';

      if (!rawTokenId || !rawTokenAmount) {
        throw new PaymentUriCodecError(
          'MISSING_TOKEN_PARAMS',
          'BSV-21 token request URI requires both "tokenId" and "tokenAmount" query parameters.'
        );
      }

      const normalizedTokenId = normalizeOutpointSeparator(rawTokenId, '_');
      if (!normalizedTokenId) {
        throw new PaymentUriCodecError(
          'INVALID_TOKEN_ID',
          `Invalid BSV-21 tokenId "${rawTokenId}". Expected format "<64-hex-txid>_<vout>".`
        );
      }

      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(rawTokenAmount) || Number(rawTokenAmount) <= 0) {
        throw new PaymentUriCodecError(
          'INVALID_TOKEN_AMOUNT',
          `Invalid BSV-21 tokenAmount "${rawTokenAmount}". Expected a positive number.`
        );
      }

      let tokenAmountBigInt: bigint | undefined;
      if (/^[1-9][0-9]*$/.test(rawTokenAmount)) {
        tokenAmountBigInt = BigInt(rawTokenAmount);
      }

      let decimals: number | undefined;
      if (params.decimals !== undefined && params.decimals.trim() !== '') {
        const parsedDec = Number(params.decimals.trim());
        if (!Number.isInteger(parsedDec) || parsedDec < 0 || parsedDec > 18) {
          throw new PaymentUriCodecError(
            'MALFORMED_URI',
            `Invalid BSV-21 decimals parameter "${params.decimals}".`
          );
        }
        decimals = parsedDec;
      }

      return {
        kind: 'bsv21',
        asset: 'bsv21',
        recipient: normalizedRecipient,
        tokenId: normalizedTokenId,
        tokenAmount: rawTokenAmount,
        tokenAmountBigInt,
        symbol: params.symbol?.trim() || undefined,
        decimals,
        label,
        hasSvFlag,
        raw: trimmed,
      };
    }

    if (assetParam === '1sat') {
      const rawOutpoint = params.outpoint?.trim() ?? '';
      if (!rawOutpoint) {
        throw new PaymentUriCodecError(
          'MISSING_NFT_OUTPOINT',
          '1Sat NFT transfer request URI requires the "outpoint" query parameter.'
        );
      }

      const normalizedDotOutpoint = normalizeOutpointSeparator(rawOutpoint, '.');
      const normalizedUnderscoreOutpoint = normalizeOutpointSeparator(rawOutpoint, '_');
      if (!normalizedDotOutpoint || !normalizedUnderscoreOutpoint) {
        throw new PaymentUriCodecError(
          'INVALID_NFT_OUTPOINT',
          `Invalid 1Sat NFT outpoint "${rawOutpoint}". Expected format "<64-hex-txid>.<vout>".`
        );
      }

      return {
        kind: '1sat',
        asset: '1sat',
        recipient: normalizedRecipient,
        outpoint: normalizedDotOutpoint,
        outpointUnderscore: normalizedUnderscoreOutpoint,
        name: params.name?.trim() || undefined,
        label,
        hasSvFlag,
        raw: trimmed,
      };
    }

    if (assetParam !== 'bsv') {
      throw new PaymentUriCodecError(
        'UNSUPPORTED_ASSET',
        `Unsupported asset type "${assetParam}" in payment URI.`
      );
    }

    let amountBsv: number | undefined;
    let satoshis: number | undefined;
    if (params.amount !== undefined) {
      if (params.amount.trim() === '') {
        throw new PaymentUriCodecError(
          'INVALID_AMOUNT',
          'BIP-21 "amount" parameter cannot be empty.'
        );
      }
      const converted = bsvDecimalToSatoshis(params.amount);
      amountBsv = converted.amountBsv;
      satoshis = converted.satoshis;
    }

    return {
      kind: 'bip21',
      asset: 'bsv',
      recipient: normalizedRecipient,
      amountBsv,
      satoshis,
      label,
      message,
      hasSvFlag,
      raw: trimmed,
    };
  }

  // 4. Reject unknown URI schemes (e.g., ethereum:, solana:, http:)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw new PaymentUriCodecError(
      'MALFORMED_URI',
      `Unsupported URI scheme in "${trimmed.slice(0, 32)}". Expected "bitcoin:" or raw BSV address/Paymail.`
    );
  }

  // 5. Raw Paymail address
  if (trimmed.includes('@')) {
    if (!isValidPaymail(trimmed)) {
      throw new PaymentUriCodecError(
        'INVALID_RECIPIENT',
        `Invalid Paymail address "${trimmed}".`
      );
    }
    return {
      kind: 'paymail',
      asset: 'bsv',
      recipient: trimmed.toLowerCase(),
      raw: trimmed,
    };
  }

  // 6. Raw BSV Address
  if (isValidBsvAddress(trimmed)) {
    return {
      kind: 'address',
      asset: 'bsv',
      recipient: trimmed,
      raw: trimmed,
    };
  }

  throw new PaymentUriCodecError(
    'INVALID_RECIPIENT',
    `Unrecognized BSV address, Paymail, or Payment URI: "${trimmed.slice(0, 64)}"`
  );
}

/**
 * Encode a structured payment request into a standard URI, address, or JSON payload string.
 */
export function encodePaymentRequest(input: EncodePaymentRequestInput): string {
  switch (input.kind) {
    case 'address': {
      const recipient = input.recipient.trim();
      if (!isValidBsvAddress(recipient)) {
        throw new PaymentUriCodecError(
          'INVALID_RECIPIENT',
          `Invalid BSV address "${recipient}".`
        );
      }
      return recipient;
    }

    case 'paymail': {
      const recipient = input.recipient.trim().toLowerCase();
      if (!isValidPaymail(recipient)) {
        throw new PaymentUriCodecError(
          'INVALID_RECIPIENT',
          `Invalid Paymail "${recipient}".`
        );
      }
      return recipient;
    }

    case 'bip21': {
      const recipient = input.recipient.trim();
      if (!isValidRecipient(recipient)) {
        throw new PaymentUriCodecError(
          'INVALID_RECIPIENT',
          `Invalid recipient "${recipient}" for BIP-21 URI.`
        );
      }
      const normalizedRecipient = isValidPaymail(recipient)
        ? recipient.toLowerCase()
        : recipient;

      const queryParts: string[] = ['sv'];

      if (input.satoshis !== undefined) {
        const bsvStr = satoshisToBsvString(input.satoshis);
        queryParts.push(`amount=${bsvStr}`);
      } else if (input.amountBsv !== undefined) {
        const { satoshis } = bsvDecimalToSatoshis(input.amountBsv);
        const bsvStr = satoshisToBsvString(satoshis);
        queryParts.push(`amount=${bsvStr}`);
      }

      if (input.label && input.label.trim()) {
        queryParts.push(`label=${encodeURIComponent(input.label.trim())}`);
      }
      if (input.message && input.message.trim()) {
        queryParts.push(`message=${encodeURIComponent(input.message.trim())}`);
      }

      return `bitcoin:${normalizedRecipient}?${queryParts.join('&')}`;
    }

    case 'bsv21': {
      const recipient = input.recipient.trim();
      if (!isValidRecipient(recipient)) {
        throw new PaymentUriCodecError(
          'INVALID_RECIPIENT',
          `Invalid recipient "${recipient}" for BSV-21 token request.`
        );
      }
      const normalizedRecipient = isValidPaymail(recipient)
        ? recipient.toLowerCase()
        : recipient;

      const normalizedTokenId = normalizeOutpointSeparator(input.tokenId, '_');
      if (!normalizedTokenId) {
        throw new PaymentUriCodecError(
          'INVALID_TOKEN_ID',
          `Invalid BSV-21 tokenId "${input.tokenId}". Expected "<64-hex-txid>_<vout>".`
        );
      }

      const rawAmount = String(input.tokenAmount).trim();
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(rawAmount) || Number(rawAmount) <= 0) {
        throw new PaymentUriCodecError(
          'INVALID_TOKEN_AMOUNT',
          `Invalid BSV-21 tokenAmount "${rawAmount}".`
        );
      }

      const queryParts: string[] = [
        'sv',
        'asset=bsv21',
        `tokenId=${normalizedTokenId}`,
        `tokenAmount=${rawAmount}`,
      ];

      if (input.symbol && input.symbol.trim()) {
        queryParts.push(`symbol=${encodeURIComponent(input.symbol.trim())}`);
      }
      if (input.decimals !== undefined) {
        queryParts.push(`decimals=${input.decimals}`);
      }
      if (input.label && input.label.trim()) {
        queryParts.push(`label=${encodeURIComponent(input.label.trim())}`);
      }

      return `bitcoin:${normalizedRecipient}?${queryParts.join('&')}`;
    }

    case '1sat': {
      const recipient = input.recipient.trim();
      if (!isValidRecipient(recipient)) {
        throw new PaymentUriCodecError(
          'INVALID_RECIPIENT',
          `Invalid recipient "${recipient}" for 1Sat NFT transfer request.`
        );
      }
      const normalizedRecipient = isValidPaymail(recipient)
        ? recipient.toLowerCase()
        : recipient;

      const normalizedOutpoint = normalizeOutpointSeparator(input.outpoint, '.');
      if (!normalizedOutpoint) {
        throw new PaymentUriCodecError(
          'INVALID_NFT_OUTPOINT',
          `Invalid 1Sat NFT outpoint "${input.outpoint}". Expected "<64-hex-txid>.<vout>".`
        );
      }

      const queryParts: string[] = [
        'sv',
        'asset=1sat',
        `outpoint=${normalizedOutpoint}`,
      ];

      if (input.name && input.name.trim()) {
        queryParts.push(`name=${encodeURIComponent(input.name.trim())}`);
      }
      if (input.label && input.label.trim()) {
        queryParts.push(`label=${encodeURIComponent(input.label.trim())}`);
      }

      return `bitcoin:${normalizedRecipient}?${queryParts.join('&')}`;
    }

    case 'brc100-action': {
      const serialized = JSON.stringify(input.action);
      // Validate round-trip before returning
      parseBrc100JsonRequest(serialized);
      return serialized;
    }
  }
}
