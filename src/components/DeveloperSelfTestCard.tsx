import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import {
  LockingScript,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk';
import { Ndef } from 'react-native-nfc-manager';
import { BRC100_BASKETS } from '@/constants/baskets';
import {
  BasketIsolationError,
  Brc100WalletEngine,
  build1SatTags,
  buildBsv21Tags,
} from '@/services/wallet/Brc100WalletEngine';
import { KeyVaultService } from '@/services/wallet/KeyVaultService';
import {
  decodePaymentRequest,
  encodePaymentRequest,
} from '@/services/scanner/PaymentUriCodec';
import { decodeNdefRecordPayload } from '@/services/nfc/NfcService';
import { brc100AppBridge } from '@/services/brc100/AppBridge';

export interface SelfTestStepResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

export function DeveloperSelfTestCard(): React.JSX.Element {
  const [running, setRunning] = useState<boolean>(false);
  const [results, setResults] = useState<SelfTestStepResult[]>([]);
  const [bridgeTestOutput, setBridgeTestOutput] = useState<string | null>(null);

  const runAllSelfTests = async (): Promise<void> => {
    setRunning(true);
    setResults([]);
    const collected: SelfTestStepResult[] = [];

    const ephemeralVault = new KeyVaultService();
    let testAddress = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
    let mockTxid =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    // -------------------------------------------------------------------------
    // TEST 1: Key Generation & Biometric Hardware Storage Readiness
    // -------------------------------------------------------------------------
    const t1Start = Date.now();
    try {
      const randomKey = PrivateKey.fromRandom();
      const pubKeyHex = randomKey.toPublicKey().toString();
      if (!pubKeyHex || pubKeyHex.length < 66) {
        throw new Error('PrivateKey.fromRandom() returned invalid public key.');
      }

      const mnemonic = ephemeralVault.generateMnemonic();
      const isValid = ephemeralVault.validateMnemonic(mnemonic);
      if (!isValid) {
        throw new Error('Generated 12-word BIP-39 mnemonic failed validation.');
      }

      const meta = ephemeralVault.unlockEphemeralInMemory(mnemonic);
      testAddress = meta.address;

      const [secureStoreOk, bioHardwareOk] = await Promise.all([
        SecureStore.isAvailableAsync().catch(() => false),
        LocalAuthentication.hasHardwareAsync().catch(() => false),
      ]);

      collected.push({
        id: 'key-vault',
        title: '1. Key Generation & Biometric Storage',
        passed: true,
        detail: `Derived BIP-44 address ${meta.address.slice(0, 12)}... • SecureStore: ${secureStoreOk ? 'Ready' : 'Sim'} • Biometrics: ${bioHardwareOk ? 'Present' : 'Sim'}`,
        durationMs: Date.now() - t1Start,
      });
    } catch (err) {
      collected.push({
        id: 'key-vault',
        title: '1. Key Generation & Biometric Storage',
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t1Start,
      });
    }

    // -------------------------------------------------------------------------
    // TEST 2: BRC-100 createAction with Mock default, bsv21, and 1sat UTXOs
    // -------------------------------------------------------------------------
    const t2Start = Date.now();
    try {
      const dryRunEngine = new Brc100WalletEngine(
        ephemeralVault,
        'mainnet',
        'brc100_selftest_dryrun.db'
      );
      const db = await dryRunEngine.getDatabase();
      await db.execAsync(
        `DELETE FROM utxo_outputs; DELETE FROM brc100_actions;`
      );

      const lockHex = new P2PKH().lock(testAddress).toHex();
      const fundingTx = new Transaction(1, [], [], 0);
      fundingTx.addInput({
        sourceTXID: '00'.repeat(32),
        sourceOutputIndex: 0,
        unlockingScript: UnlockingScript.fromHex('51'),
        sequence: 0xffffffff,
      });
      // vout 0: 50,000 sats for 'default' basket
      fundingTx.addOutput({
        lockingScript: LockingScript.fromHex(lockHex),
        satoshis: 50_000,
      });
      // vout 1: 1 sat for 'bsv21' token carrier basket
      fundingTx.addOutput({
        lockingScript: LockingScript.fromHex(lockHex),
        satoshis: 1,
      });
      // vout 2: 1 sat for '1sat' ordinal NFT basket
      fundingTx.addOutput({
        lockingScript: LockingScript.fromHex(lockHex),
        satoshis: 1,
      });

      mockTxid = fundingTx.id('hex');

      await dryRunEngine.internalizeAction({
        tx: fundingTx.toBinary(),
        description: 'Seed mock default, bsv21, and 1sat UTXOs',
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
          },
          {
            outputIndex: 1,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: BRC100_BASKETS.BSV21,
              tags: buildBsv21Tags({
                txidVout: `${mockTxid}_1`,
                symbol: 'TEST21',
                decimals: 2,
                amount: '50000',
              }),
            },
          },
          {
            outputIndex: 2,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: BRC100_BASKETS.ONESAT,
              tags: build1SatTags({
                txidVout: `${mockTxid}_2`,
                contentType: 'image/png',
                name: 'SelfTest Ordinal #1',
              }),
            },
          },
        ],
      });

      // Verify standard createAction funds strictly from 'default' basket
      const createRes = await dryRunEngine.createAction({
        description: 'Dry-run BSV payment from default basket',
        outputs: [
          {
            lockingScript: lockHex,
            satoshis: 10_000,
            outputDescription: 'Self-test recipient output',
          },
        ],
        options: {
          signAndProcess: true,
          noSend: true,
        },
      });

      if (!createRes.txid) {
        throw new Error('createAction did not produce a signed txid.');
      }

      // Verify bsv21 and 1sat outputs were NOT touched by automatic fee selection
      const summaries = await dryRunEngine.getBasketSummaries();
      if (summaries.bsv21.utxoCount !== 1 || summaries['1sat'].utxoCount !== 1) {
        throw new Error(
          'Basket isolation violated: bsv21 or 1sat UTXO was consumed during standard createAction.'
        );
      }

      // Verify strict guard throws BasketIsolationError when spending bsv21 without flag
      let blockedBsv21 = false;
      try {
        await dryRunEngine.createAction({
          description: 'Attempt unauthorized bsv21 spend',
          inputs: [
            {
              outpoint: `${mockTxid}.1`,
              inputDescription: 'Unauthorized bsv21 input',
            },
          ],
          outputs: [
            {
              lockingScript: lockHex,
              satoshis: 1,
              outputDescription: 'Test output',
            },
          ],
        });
      } catch (err) {
        if (err instanceof BasketIsolationError) {
          blockedBsv21 = true;
        }
      }

      // Verify strict guard throws BasketIsolationError when spending 1sat without flag
      let blocked1Sat = false;
      try {
        await dryRunEngine.createAction({
          description: 'Attempt unauthorized 1sat spend',
          inputs: [
            {
              outpoint: `${mockTxid}.2`,
              inputDescription: 'Unauthorized 1sat input',
            },
          ],
          outputs: [
            {
              lockingScript: lockHex,
              satoshis: 1,
              outputDescription: 'Test output',
            },
          ],
        });
      } catch (err) {
        if (err instanceof BasketIsolationError) {
          blocked1Sat = true;
        }
      }

      if (!blockedBsv21 || !blocked1Sat) {
        throw new Error(
          'BasketIsolationError guard did not reject unauthorized bsv21/1sat inputs.'
        );
      }

      collected.push({
        id: 'brc100-isolation',
        title: '2. BRC-100 createAction & Basket Isolation',
        passed: true,
        detail: `Signed TX ${createRes.txid.slice(0, 12)}... from 'default' • Guard blocked unflagged 'bsv21' & '1sat' spends`,
        durationMs: Date.now() - t2Start,
      });
    } catch (err) {
      collected.push({
        id: 'brc100-isolation',
        title: '2. BRC-100 createAction & Basket Isolation',
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t2Start,
      });
    }

    // -------------------------------------------------------------------------
    // TEST 3: Encoding & Decoding BIP-21 URIs (BSV, BSV-21, 1Sat NFT)
    // -------------------------------------------------------------------------
    const t3Start = Date.now();
    try {
      const bsvUri = encodePaymentRequest({
        kind: 'bip21',
        recipient: testAddress,
        amountBsv: 0.0125,
        label: 'SelfTest BSV',
      });
      const decodedBsv = decodePaymentRequest(bsvUri);
      if (
        decodedBsv.kind !== 'bip21' ||
        decodedBsv.satoshis !== 1_250_000 ||
        decodedBsv.recipient !== testAddress
      ) {
        throw new Error('BIP-21 BSV URI round-trip mismatch.');
      }

      const bsv21Uri = encodePaymentRequest({
        kind: 'bsv21',
        recipient: testAddress,
        tokenId: `${mockTxid}_1`,
        tokenAmount: 2500n,
        symbol: 'TEST21',
      });
      const decodedBsv21 = decodePaymentRequest(bsv21Uri);
      if (
        decodedBsv21.kind !== 'bsv21' ||
        decodedBsv21.tokenAmountBigInt !== 2500n ||
        decodedBsv21.tokenId !== `${mockTxid}_1`
      ) {
        throw new Error('BSV-21 Token URI round-trip mismatch.');
      }

      const nftUri = encodePaymentRequest({
        kind: '1sat',
        recipient: testAddress,
        outpoint: `${mockTxid}.2`,
        name: 'SelfTest Ordinal #1',
      });
      const decodedNft = decodePaymentRequest(nftUri);
      if (
        decodedNft.kind !== '1sat' ||
        decodedNft.outpoint !== `${mockTxid}.2`
      ) {
        throw new Error('1Sat NFT URI round-trip mismatch.');
      }

      collected.push({
        id: 'uri-codec',
        title: '3. BIP-21 / BSV-21 / 1Sat URI Codec',
        passed: true,
        detail:
          'Verified lossless encode/decode for BIP-21 (1,250,000 sats), BSV-21 (2500 TEST21), and 1Sat NFT outpoint',
        durationMs: Date.now() - t3Start,
      });
    } catch (err) {
      collected.push({
        id: 'uri-codec',
        title: '3. BIP-21 / BSV-21 / 1Sat URI Codec',
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t3Start,
      });
    }

    // -------------------------------------------------------------------------
    // TEST 4: NFC NDEF Payload Byte Encoding & Decoding
    // -------------------------------------------------------------------------
    const t4Start = Date.now();
    try {
      const sampleNfcUri = encodePaymentRequest({
        kind: 'bsv21',
        recipient: testAddress,
        tokenId: `${mockTxid}_1`,
        tokenAmount: '750',
        symbol: 'MNEE',
      });

      const ndefBytes = Ndef.encodeMessage([Ndef.uriRecord(sampleNfcUri)]);
      if (!ndefBytes || ndefBytes.length === 0) {
        throw new Error('Ndef.encodeMessage returned empty byte array.');
      }

      const decodedRecords = Ndef.decodeMessage(ndefBytes);
      if (!decodedRecords || decodedRecords.length === 0) {
        throw new Error('Ndef.decodeMessage returned no NDEF records.');
      }

      const extractedUri = decodeNdefRecordPayload(decodedRecords[0]);
      if (!extractedUri) {
        throw new Error('decodeNdefRecordPayload returned null.');
      }

      const parsedFromNdef = decodePaymentRequest(extractedUri);
      if (
        parsedFromNdef.kind !== 'bsv21' ||
        parsedFromNdef.tokenAmount !== '750' ||
        parsedFromNdef.symbol !== 'MNEE'
      ) {
        throw new Error('Decoded NDEF URI did not match original BSV-21 request.');
      }

      collected.push({
        id: 'ndef-codec',
        title: '4. NFC NDEF Byte Encoding & Decoding',
        passed: true,
        detail: `Encoded ${ndefBytes.length}-byte NDEF URI record & decoded back into BSV-21 (750 MNEE)`,
        durationMs: Date.now() - t4Start,
      });
    } catch (err) {
      collected.push({
        id: 'ndef-codec',
        title: '4. NFC NDEF Byte Encoding & Decoding',
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t4Start,
      });
    }

    setResults(collected);
    setRunning(false);
    const allPassed = collected.every((r) => r.passed);
    void Haptics.notificationAsync(
      allPassed
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Error
    );
  };

  const handleTestAppBridgePermissionPrompt = async (): Promise<void> => {
    setBridgeTestOutput('Waiting for user approval in Brc100PermissionSheet...');
    const response = await brc100AppBridge.handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 'selftest_rpc_1',
      method: 'listOutputs',
      originator: 'ordinal-market.bsv.app',
      params: {
        basket: '1sat',
        includeTags: true,
      },
    });
    if (response.error) {
      setBridgeTestOutput(`RPC Error (${response.error.code}): ${response.error.message}`);
    } else {
      setBridgeTestOutput(
        `RPC Result: ${JSON.stringify(response.result)}`
      );
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerTextCol}>
          <Text style={styles.badge}>END-TO-END DIAGNOSTICS</Text>
          <Text style={styles.title}>Developer Self-Test Suite</Text>
          <Text style={styles.subtitle}>
            Automated dry-run verification of Keys, BRC-100 Basket Isolation,
            BIP-21/BSV-21/1Sat URIs, and NFC NDEF byte framing.
          </Text>
        </View>
      </View>

      <Pressable
        style={[styles.runButton, running && styles.runButtonDisabled]}
        onPress={() => void runAllSelfTests()}
        disabled={running}
      >
        {running ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.runButtonText}>
            Run Automated Developer Self-Test
          </Text>
        )}
      </Pressable>

      {results.length > 0 ? (
        <View style={styles.resultsList}>
          {results.map((item) => (
            <View
              key={item.id}
              style={[
                styles.resultRow,
                item.passed ? styles.resultRowPass : styles.resultRowFail,
              ]}
            >
              <View style={styles.resultTopLine}>
                <Text style={styles.resultTitle}>{item.title}</Text>
                <Text
                  style={[
                    styles.statusPill,
                    item.passed ? styles.statusPass : styles.statusFail,
                  ]}
                >
                  {item.passed ? `PASS (${item.durationMs}ms)` : 'FAIL'}
                </Text>
              </View>
              <Text style={styles.resultDetail}>{item.detail}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.bridgeSection}>
        <Text style={styles.bridgeTitle}>
          BRC-100 WalletWire AppBridge Interactive Test
        </Text>
        <Text style={styles.bridgeSub}>
          Simulate an external dApp calling listOutputs(&apos;1sat&apos;) to test
          the Biometric Permission Approval Modal.
        </Text>
        <Pressable
          style={styles.bridgeBtn}
          onPress={() => void handleTestAppBridgePermissionPrompt()}
        >
          <Text style={styles.bridgeBtnText}>
            Simulate dApp Basket Permission Request
          </Text>
        </Pressable>
        {bridgeTestOutput ? (
          <Text style={styles.bridgeOutput} selectable>
            {bridgeTestOutput}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  headerTextCol: {
    flex: 1,
  },
  badge: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '800',
  },
  subtitle: {
    color: '#94A3B8',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  runButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  runButtonDisabled: {
    opacity: 0.65,
  },
  runButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  resultsList: {
    gap: 8,
  },
  resultRow: {
    backgroundColor: '#0F172A',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
  },
  resultRowPass: {
    borderColor: '#10B981',
  },
  resultRowFail: {
    borderColor: '#EF4444',
  },
  resultTopLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  resultTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
    flex: 1,
    paddingRight: 8,
  },
  statusPill: {
    fontSize: 10,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  statusPass: {
    color: '#34D399',
  },
  statusFail: {
    color: '#F87171',
  },
  resultDetail: {
    color: '#94A3B8',
    fontSize: 11,
    lineHeight: 16,
  },
  bridgeSection: {
    marginTop: 4,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    gap: 8,
  },
  bridgeTitle: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '700',
  },
  bridgeSub: {
    color: '#94A3B8',
    fontSize: 12,
    lineHeight: 17,
  },
  bridgeBtn: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#38BDF8',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  bridgeBtnText: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '800',
  },
  bridgeOutput: {
    color: '#A7F3D0',
    fontSize: 11,
    fontFamily: 'monospace',
    backgroundColor: '#020617',
    padding: 10,
    borderRadius: 8,
  },
});
