import {
  decodePaymentRequest,
  encodePaymentRequest,
  PaymentUriCodecError,
  bsvDecimalToSatoshis,
  satoshisToBsvString,
} from '../PaymentUriCodec.ts';

const SAMPLE_ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const SAMPLE_TESTNET_ADDRESS = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';
const SAMPLE_TXID =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface TestCase {
  name: string;
  fn: () => void;
}

const tests: TestCase[] = [];

function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message ? `${message}: ` : ''}Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }
}

function assertThrowsCode(
  fn: () => unknown,
  expectedCode: string,
  context?: string
): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  if (!caught) {
    throw new Error(
      `${context ? `${context}: ` : ''}Expected PaymentUriCodecError(${expectedCode}), but function did not throw.`
    );
  }
  if (!(caught instanceof PaymentUriCodecError)) {
    throw new Error(
      `${context ? `${context}: ` : ''}Expected PaymentUriCodecError, but caught: ${String(caught)}`
    );
  }
  if (caught.code !== expectedCode) {
    throw new Error(
      `${context ? `${context}: ` : ''}Expected error code "${expectedCode}", received "${caught.code}" (${caught.message})`
    );
  }
}

// 1. Raw BSV Addresses & Paymails
test('decodes raw Mainnet BSV P2PKH address', () => {
  const res = decodePaymentRequest(`  ${SAMPLE_ADDRESS}  `);
  assertEqual(res.kind, 'address');
  assertEqual(res.asset, 'bsv');
  assertEqual(res.recipient, SAMPLE_ADDRESS);
});

test('decodes raw Testnet BSV P2PKH address', () => {
  const res = decodePaymentRequest(SAMPLE_TESTNET_ADDRESS);
  assertEqual(res.kind, 'address');
  assertEqual(res.recipient, SAMPLE_TESTNET_ADDRESS);
});

test('decodes raw Paymail and normalizes to lowercase', () => {
  const res = decodePaymentRequest('Satoshi.Nakamoto@HandCash.io');
  assertEqual(res.kind, 'paymail');
  assertEqual(res.asset, 'bsv');
  assertEqual(res.recipient, 'satoshi.nakamoto@handcash.io');
});

test('decodes paymail: scheme URI', () => {
  const res = decodePaymentRequest('paymail:alice@relayx.io');
  assertEqual(res.kind, 'paymail');
  assertEqual(res.recipient, 'alice@relayx.io');
});

// 2. BIP-21 BSV URIs
test('decodes BIP-21 BSV URI with sv flag, amount, and URL-encoded label', () => {
  const uri = `bitcoin:${SAMPLE_ADDRESS}?sv&amount=0.025&label=Morning%20Coffee`;
  const res = decodePaymentRequest(uri);
  if (res.kind !== 'bip21') {
    throw new Error(`Expected kind 'bip21', got '${res.kind}'`);
  }
  assertEqual(res.recipient, SAMPLE_ADDRESS);
  assertEqual(res.hasSvFlag, true);
  assertEqual(res.amountBsv, 0.025);
  assertEqual(res.satoshis, 2_500_000);
  assertEqual(res.label, 'Morning Coffee');
});

test('encodes and round-trips BIP-21 BSV URI', () => {
  const encoded = encodePaymentRequest({
    kind: 'bip21',
    recipient: SAMPLE_ADDRESS,
    satoshis: 150_000,
    label: 'Lunch Split & Tip',
  });
  assertEqual(
    encoded,
    `bitcoin:${SAMPLE_ADDRESS}?sv&amount=0.0015&label=Lunch%20Split%20%26%20Tip`
  );
  const decoded = decodePaymentRequest(encoded);
  if (decoded.kind !== 'bip21') {
    throw new Error(`Expected kind 'bip21', got '${decoded.kind}'`);
  }
  assertEqual(decoded.satoshis, 150_000);
  assertEqual(decoded.amountBsv, 0.0015);
  assertEqual(decoded.label, 'Lunch Split & Tip');
});

test('decodes BIP-21 URI without amount (address-only bitcoin: URI)', () => {
  const res = decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&label=Donation`);
  if (res.kind !== 'bip21') {
    throw new Error(`Expected kind 'bip21', got '${res.kind}'`);
  }
  assertEqual(res.recipient, SAMPLE_ADDRESS);
  assertEqual(res.amountBsv, undefined);
  assertEqual(res.satoshis, undefined);
  assertEqual(res.label, 'Donation');
});

// 3. BSV-21 Token Request URIs
test('decodes BSV-21 Token Request URI with txid_vout and tokenAmount', () => {
  const tokenId = `${SAMPLE_TXID}_0`;
  const uri = `bitcoin:${SAMPLE_ADDRESS}?sv&asset=bsv21&tokenId=${tokenId}&tokenAmount=5000&symbol=MNEE&decimals=2`;
  const res = decodePaymentRequest(uri);
  if (res.kind !== 'bsv21') {
    throw new Error(`Expected kind 'bsv21', got '${res.kind}'`);
  }
  assertEqual(res.recipient, SAMPLE_ADDRESS);
  assertEqual(res.tokenId, tokenId);
  assertEqual(res.tokenAmount, '5000');
  assertEqual(res.tokenAmountBigInt, 5000n);
  assertEqual(res.symbol, 'MNEE');
  assertEqual(res.decimals, 2);
  assertEqual(res.hasSvFlag, true);
});

test('encodes and round-trips BSV-21 Token Request URI', () => {
  const tokenIdDot = `${SAMPLE_TXID}.2`;
  const encoded = encodePaymentRequest({
    kind: 'bsv21',
    recipient: SAMPLE_ADDRESS,
    tokenId: tokenIdDot,
    tokenAmount: 100000n,
    symbol: 'BSV21',
  });
  assertEqual(
    encoded,
    `bitcoin:${SAMPLE_ADDRESS}?sv&asset=bsv21&tokenId=${SAMPLE_TXID}_2&tokenAmount=100000&symbol=BSV21`
  );
  const decoded = decodePaymentRequest(encoded);
  if (decoded.kind !== 'bsv21') {
    throw new Error(`Expected kind 'bsv21', got '${decoded.kind}'`);
  }
  assertEqual(decoded.tokenId, `${SAMPLE_TXID}_2`);
  assertEqual(decoded.tokenAmountBigInt, 100000n);
});

// 4. 1Sat NFT Transfer Request URIs
test('decodes 1Sat NFT Transfer Request URI and normalizes outpoint separator', () => {
  const outpoint = `${SAMPLE_TXID}.0`;
  const uri = `bitcoin:${SAMPLE_ADDRESS}?sv&asset=1sat&outpoint=${outpoint}&name=Genesis%20Ordinal`;
  const res = decodePaymentRequest(uri);
  if (res.kind !== '1sat') {
    throw new Error(`Expected kind '1sat', got '${res.kind}'`);
  }
  assertEqual(res.recipient, SAMPLE_ADDRESS);
  assertEqual(res.outpoint, `${SAMPLE_TXID}.0`);
  assertEqual(res.outpointUnderscore, `${SAMPLE_TXID}_0`);
  assertEqual(res.name, 'Genesis Ordinal');
});

test('encodes and round-trips 1Sat NFT Transfer Request URI', () => {
  const encoded = encodePaymentRequest({
    kind: '1sat',
    recipient: SAMPLE_ADDRESS,
    outpoint: `${SAMPLE_TXID}_4`,
    name: 'Rare Artifact #4',
  });
  assertEqual(
    encoded,
    `bitcoin:${SAMPLE_ADDRESS}?sv&asset=1sat&outpoint=${SAMPLE_TXID}.4&name=Rare%20Artifact%20%234`
  );
  const decoded = decodePaymentRequest(encoded);
  if (decoded.kind !== '1sat') {
    throw new Error(`Expected kind '1sat', got '${decoded.kind}'`);
  }
  assertEqual(decoded.outpoint, `${SAMPLE_TXID}.4`);
  assertEqual(decoded.outpointUnderscore, `${SAMPLE_TXID}_4`);
});

// 5. BRC-100 JSON Action Request Payloads
test('decodes and round-trips BRC-100 JSON Action Request payload', () => {
  const payload = {
    protocol: 'brc-100' as const,
    method: 'createAction' as const,
    originator: 'https://app.bsv.example',
    description: 'Mint 1Sat Ordinal Inscription',
    outputs: [
      {
        lockingScript: '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac',
        satoshis: 1,
        outputDescription: 'Ordinal NFT output',
        basket: '1sat' as const,
      },
      {
        lockingScript: '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac',
        satoshis: 1000,
        outputDescription: 'Platform service fee',
      },
    ],
    labels: ['ordinal-mint'],
  };

  const encoded = encodePaymentRequest({
    kind: 'brc100-action',
    action: payload,
  });

  const decoded = decodePaymentRequest(encoded);
  if (decoded.kind !== 'brc100-action') {
    throw new Error(`Expected kind 'brc100-action', got '${decoded.kind}'`);
  }
  assertEqual(decoded.recipient, 'https://app.bsv.example');
  assertEqual(decoded.totalSatoshis, 1001);
  assertEqual(decoded.action.description, 'Mint 1Sat Ordinal Inscription');
  assertEqual(decoded.action.outputs.length, 2);
});

// 6. Edge Cases, Missing Query Params & Malformed URIs
test('throws EMPTY_INPUT on empty or whitespace-only string', () => {
  assertThrowsCode(() => decodePaymentRequest(''), 'EMPTY_INPUT');
  assertThrowsCode(() => decodePaymentRequest('   \n\t  '), 'EMPTY_INPUT');
});

test('throws MISSING_TOKEN_PARAMS when BSV-21 URI is missing tokenId or tokenAmount', () => {
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&asset=bsv21&tokenId=${SAMPLE_TXID}_0`),
    'MISSING_TOKEN_PARAMS',
    'Missing tokenAmount'
  );
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&asset=bsv21&tokenAmount=100`),
    'MISSING_TOKEN_PARAMS',
    'Missing tokenId'
  );
});

test('throws INVALID_TOKEN_ID and INVALID_TOKEN_AMOUNT on bad BSV-21 params', () => {
  assertThrowsCode(
    () =>
      decodePaymentRequest(
        `bitcoin:${SAMPLE_ADDRESS}?sv&asset=bsv21&tokenId=not_a_txid_0&tokenAmount=100`
      ),
    'INVALID_TOKEN_ID'
  );
  assertThrowsCode(
    () =>
      decodePaymentRequest(
        `bitcoin:${SAMPLE_ADDRESS}?sv&asset=bsv21&tokenId=${SAMPLE_TXID}_0&tokenAmount=-50`
      ),
    'INVALID_TOKEN_AMOUNT'
  );
  assertThrowsCode(
    () =>
      decodePaymentRequest(
        `bitcoin:${SAMPLE_ADDRESS}?sv&asset=bsv21&tokenId=${SAMPLE_TXID}_0&tokenAmount=0`
      ),
    'INVALID_TOKEN_AMOUNT'
  );
});

test('throws MISSING_NFT_OUTPOINT and INVALID_NFT_OUTPOINT on bad 1Sat URIs', () => {
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&asset=1sat`),
    'MISSING_NFT_OUTPOINT'
  );
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&asset=1sat&outpoint=bad_outpoint`),
    'INVALID_NFT_OUTPOINT'
  );
});

test('throws INVALID_AMOUNT on negative, zero, empty, or over-precision BIP-21 amounts', () => {
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&amount=`),
    'INVALID_AMOUNT',
    'Empty amount'
  );
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&amount=0`),
    'INVALID_AMOUNT',
    'Zero amount'
  );
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&amount=-1.5`),
    'INVALID_AMOUNT',
    'Negative amount'
  );
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&amount=0.123456789`),
    'INVALID_AMOUNT',
    'More than 8 decimals'
  );
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&amount=25000000`),
    'INVALID_AMOUNT',
    'Exceeds 21M max supply'
  );
});

test('throws MALFORMED_URI on multiple question marks, bad percent encoding, or unsupported schemes', () => {
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv?amount=1`),
    'MALFORMED_URI',
    'Multiple question marks'
  );
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&label=%E0%A4%A`),
    'MALFORMED_URI',
    'Bad percent encoding'
  );
  assertThrowsCode(
    () => decodePaymentRequest('ethereum:0x71C7656EC7ab88b098defB751B7401B5f6d8976F'),
    'MALFORMED_URI',
    'Unsupported scheme'
  );
  assertThrowsCode(
    () => decodePaymentRequest(`bitcoin:${SAMPLE_ADDRESS}?sv&asset=erc20`),
    'UNSUPPORTED_ASSET',
    'Unsupported asset param'
  );
});

test('throws INVALID_BRC100_JSON on malformed JSON or invalid BRC-100 createAction fields', () => {
  assertThrowsCode(() => decodePaymentRequest('{bad json'), 'INVALID_BRC100_JSON');
  assertThrowsCode(
    () =>
      decodePaymentRequest(
        JSON.stringify({
          protocol: 'brc-100',
          method: 'createAction',
          description: 'shrt', // < 5 chars
          outputs: [{ lockingScript: '76a9140088ac', satoshis: 100 }],
        })
      ),
    'INVALID_BRC100_JSON',
    'Description too short'
  );
  assertThrowsCode(
    () =>
      decodePaymentRequest(
        JSON.stringify({
          protocol: 'brc-100',
          method: 'createAction',
          description: 'Valid description string',
          outputs: [], // empty outputs
        })
      ),
    'INVALID_BRC100_JSON',
    'Empty outputs array'
  );
});

test('converts satoshis <-> BSV decimal strings accurately without floating point drift', () => {
  const { satoshis, amountBsv } = bsvDecimalToSatoshis('0.29');
  assertEqual(satoshis, 29_000_000);
  assertEqual(amountBsv, 0.29);
  assertEqual(satoshisToBsvString(1), '0.00000001');
  assertEqual(satoshisToBsvString(100_000_000), '1');
  assertEqual(satoshisToBsvString(123_450_000), '1.2345');
});

export function runPaymentUriCodecTests(): { passed: number; total: number } {
  let passed = 0;
  for (const t of tests) {
    t.fn();
    passed += 1;
  }
  return { passed, total: tests.length };
}

const result = runPaymentUriCodecTests();
console.log(`PaymentUriCodec unit tests passed: ${result.passed}/${result.total}`);
