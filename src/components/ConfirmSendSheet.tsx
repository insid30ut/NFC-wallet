import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Transaction } from '@bsv/sdk';
import {
  bsvDecimalToSatoshis,
  isValidBsvAddress,
  satoshisToBsvString,
  type DecodedPaymentRequest,
} from '../services/scanner/PaymentUriCodec';
import { transactionBuilder } from '../services/wallet/TransactionBuilder';
import { brc100WalletEngine } from '../services/wallet/Brc100WalletEngine';
import { keyVaultService } from '../services/wallet/KeyVaultService';
import {
  networkConfigService,
  type ArcFeeQuote,
} from '../services/network/NetworkConfig';

export interface ConfirmSendSheetProps {
  visible: boolean;
  request: DecodedPaymentRequest | null;
  onClose: () => void;
  onSuccess?: (result: { txid: string; summary: string }) => void;
}

export function ConfirmSendSheet({
  visible,
  request,
  onClose,
  onSuccess,
}: ConfirmSendSheetProps): React.JSX.Element {
  const [editableBsvAmount, setEditableBsvAmount] = useState<string>('');
  const [feeQuote, setFeeQuote] = useState<ArcFeeQuote | null>(null);
  const [loadingFee, setLoadingFee] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [txResult, setTxResult] = useState<{
    txid: string;
    feeSatoshis: number;
    summary: string;
  } | null>(null);

  useEffect(() => {
    if (!visible || !request) {
      return;
    }

    let cancelled = false;
    async function prepareSheet(): Promise<void> {
      await Promise.resolve();
      if (cancelled || !request) return;
      setErrorMsg(null);
      setTxResult(null);
      if (request.kind === 'bip21' && request.satoshis !== undefined) {
        setEditableBsvAmount(satoshisToBsvString(request.satoshis));
      } else {
        setEditableBsvAmount('');
      }
      setLoadingFee(true);
      try {
        const quote = await networkConfigService.fetchArcFeeQuote();
        if (!cancelled) {
          setFeeQuote(quote);
        }
      } catch {
        // Fallback fee quote is handled by networkConfigService
      } finally {
        if (!cancelled) {
          setLoadingFee(false);
        }
      }
    }

    void prepareSheet();

    return () => {
      cancelled = true;
    };
  }, [visible, request]);

  const estimatedFeeSats = useMemo(() => {
    const rate = feeQuote?.satoshisPerKilobyte ?? 100;
    if (!request) {
      return 25;
    }
    const estBytes =
      request.kind === 'bsv21'
        ? 480
        : request.kind === '1sat'
          ? 380
          : request.kind === 'brc100-action'
            ? 420
            : 230;
    return Math.max(1, Math.ceil((estBytes * rate) / 1000));
  }, [feeQuote, request]);

  const assetBadgeText = useMemo(() => {
    if (!request) return 'BSV';
    switch (request.kind) {
      case 'address':
      case 'paymail':
      case 'bip21':
        return 'BSV (Default Basket)';
      case 'bsv21':
        return `BSV-21 Token (${request.symbol ?? 'BSV21'})`;
      case '1sat':
        return '1Sat Ordinal NFT';
      case 'brc100-action':
        return 'BRC-100 Action Request';
    }
  }, [request]);

  const amountDisplay = useMemo(() => {
    if (!request) return '—';
    switch (request.kind) {
      case 'address':
      case 'paymail':
      case 'bip21': {
        if (request.kind === 'bip21' && request.satoshis !== undefined) {
          return `${satoshisToBsvString(request.satoshis)} BSV (${request.satoshis.toLocaleString()} sats)`;
        }
        if (editableBsvAmount.trim()) {
          try {
            const { satoshis, amountBsv } =
              bsvDecimalToSatoshis(editableBsvAmount);
            return `${amountBsv} BSV (${satoshis.toLocaleString()} sats)`;
          } catch {
            return 'Enter valid BSV amount';
          }
        }
        return 'Enter BSV amount below';
      }
      case 'bsv21':
        return `${request.tokenAmount} ${request.symbol ?? 'Tokens'}`;
      case '1sat':
        return `1 Ordinal NFT (1 sat) • ${request.name ?? request.outpoint.slice(0, 14)}...`;
      case 'brc100-action':
        return `${request.totalSatoshis.toLocaleString()} sats across ${request.action.outputs.length} output(s)`;
    }
  }, [request, editableBsvAmount]);

  const needsManualAmountInput =
    request !== null &&
    (request.kind === 'address' ||
      request.kind === 'paymail' ||
      (request.kind === 'bip21' && request.satoshis === undefined));

  const handleConfirmSend = async (): Promise<void> => {
    if (!request) return;
    setErrorMsg(null);
    setSubmitting(true);

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await keyVaultService.unlockWallet({
        biometricPromptMessage:
          'Authenticate with biometrics to sign and broadcast BRC-100 transaction',
      });

      if (
        request.kind === 'address' ||
        request.kind === 'paymail' ||
        request.kind === 'bip21'
      ) {
        if (!isValidBsvAddress(request.recipient)) {
          throw new Error(
            `Recipient "${request.recipient}" is a Paymail handle. Please scan or enter a resolved P2PKH BSV address.`
          );
        }

        let satoshisToSend: number;
        if (request.kind === 'bip21' && request.satoshis !== undefined) {
          satoshisToSend = request.satoshis;
        } else {
          const converted = bsvDecimalToSatoshis(editableBsvAmount);
          satoshisToSend = converted.satoshis;
        }

        const res = await transactionBuilder.sendBsv(
          request.recipient,
          satoshisToSend
        );
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
        const summary = `Sent ${satoshisToSend.toLocaleString()} sats to ${request.recipient.slice(0, 10)}...`;
        setTxResult({
          txid: res.txid,
          feeSatoshis: estimatedFeeSats,
          summary,
        });
        onSuccess?.({ txid: res.txid, summary });
        return;
      }

      if (request.kind === 'bsv21') {
        if (!isValidBsvAddress(request.recipient)) {
          throw new Error(
            'BSV-21 token transfer requires a P2PKH BSV address recipient.'
          );
        }
        const tokenUnits =
          request.tokenAmountBigInt ??
          BigInt(Math.round(Number(request.tokenAmount)));
        const res = await transactionBuilder.sendBsv21Token(
          request.tokenId,
          request.recipient,
          tokenUnits
        );
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
        const summary = `Sent ${request.tokenAmount} ${request.symbol ?? 'BSV-21'} to ${request.recipient.slice(0, 10)}...`;
        setTxResult({
          txid: res.txid,
          feeSatoshis: estimatedFeeSats,
          summary,
        });
        onSuccess?.({ txid: res.txid, summary });
        return;
      }

      if (request.kind === '1sat') {
        if (!isValidBsvAddress(request.recipient)) {
          throw new Error(
            '1Sat NFT transfer requires a P2PKH BSV address recipient.'
          );
        }
        // Check both dot and underscore outpoint formats against wallet outputs
        const res = await transactionBuilder.send1SatNft(
          request.outpointUnderscore,
          request.recipient
        );
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
        const summary = `Transferred 1Sat NFT (${request.outpoint.slice(0, 12)}...) to ${request.recipient.slice(0, 10)}...`;
        setTxResult({
          txid: res.txid,
          feeSatoshis: estimatedFeeSats,
          summary,
        });
        onSuccess?.({ txid: res.txid, summary });
        return;
      }

      if (request.kind === 'brc100-action') {
        const feeRate = feeQuote?.satoshisPerKilobyte ?? 50;
        const actionRes = await brc100WalletEngine.createAction({
          description: request.action.description,
          outputs: request.action.outputs.map((out) => ({
            lockingScript: out.lockingScript,
            satoshis: out.satoshis,
            outputDescription: out.outputDescription ?? 'BRC-100 Action Output',
            basket: out.basket,
            tags: out.tags,
            customInstructions: out.customInstructions,
          })),
          labels: request.action.labels,
          feeRateSatsPerKb: feeRate,
          options: {
            signAndProcess: true,
            randomizeOutputs: false,
          },
        });
        if (!actionRes.txid || !actionRes.tx) {
          throw new Error('BRC-100 createAction did not produce a signed tx.');
        }
        const rawTxHex = Transaction.fromBinary(actionRes.tx).toHex();
        const broadcastRes =
          await networkConfigService.broadcastTransaction(rawTxHex);
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
        const summary = `Executed BRC-100 action: "${request.action.description}"`;
        setTxResult({
          txid: broadcastRes.txid,
          feeSatoshis: estimatedFeeSats,
          summary,
        });
        onSuccess?.({ txid: broadcastRes.txid, summary });
      }
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!request) {
    return <></>;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handleBar} />

          <View style={styles.headerRow}>
            <View>
              <Text style={styles.title}>Confirm Transaction</Text>
              <Text style={styles.subtitle}>
                Unified BRC-100 Payment & Asset Sheet
              </Text>
            </View>
            <Pressable
              style={styles.closeBtn}
              onPress={onClose}
              disabled={submitting}
            >
              <Text style={styles.closeBtnText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Asset Type Pill */}
            <View style={styles.assetBadgeRow}>
              <View style={styles.assetBadge}>
                <Text style={styles.assetBadgeLabel}>{assetBadgeText}</Text>
              </View>
              <Text style={styles.networkBadge}>
                {networkConfigService.getNetwork().toUpperCase()}
              </Text>
            </View>

            {/* Summary Card */}
            <View style={styles.summaryCard}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Asset</Text>
                <Text style={styles.detailValue}>
                  {request.asset.toUpperCase()}
                </Text>
              </View>

              <View style={styles.divider} />

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Amount</Text>
                <Text style={styles.detailValueHighlight}>{amountDisplay}</Text>
              </View>

              <View style={styles.divider} />

              <View style={styles.detailColumn}>
                <Text style={styles.detailLabel}>Recipient</Text>
                <Text style={styles.monoValue} selectable>
                  {request.recipient}
                </Text>
              </View>

              {request.kind === 'bsv21' ? (
                <>
                  <View style={styles.divider} />
                  <View style={styles.detailColumn}>
                    <Text style={styles.detailLabel}>Token ID (txid_vout)</Text>
                    <Text style={styles.monoValue} selectable>
                      {request.tokenId}
                    </Text>
                  </View>
                </>
              ) : null}

              {request.kind === '1sat' ? (
                <>
                  <View style={styles.divider} />
                  <View style={styles.detailColumn}>
                    <Text style={styles.detailLabel}>
                      Ordinal Outpoint (Input #0 → Output #0)
                    </Text>
                    <Text style={styles.monoValue} selectable>
                      {request.outpoint}
                    </Text>
                  </View>
                </>
              ) : null}

              {request.kind === 'brc100-action' ? (
                <>
                  <View style={styles.divider} />
                  <View style={styles.detailColumn}>
                    <Text style={styles.detailLabel}>Action Description</Text>
                    <Text style={styles.detailValue}>
                      {request.action.description}
                    </Text>
                  </View>
                </>
              ) : null}

              {(request.kind === 'bip21' ||
                request.kind === 'bsv21' ||
                request.kind === '1sat') &&
              request.label ? (
                <>
                  <View style={styles.divider} />
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Note / Label</Text>
                    <Text style={styles.detailValue}>{request.label}</Text>
                  </View>
                </>
              ) : null}

              <View style={styles.divider} />

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Estimated Network Fee</Text>
                {loadingFee ? (
                  <ActivityIndicator size="small" color="#60A5FA" />
                ) : (
                  <Text style={styles.feeValue}>
                    ~{estimatedFeeSats} sats (
                    {feeQuote?.satoshisPerKilobyte ?? 100} sat/KB via ARC)
                  </Text>
                )}
              </View>

              <View style={styles.basketNotice}>
                <Text style={styles.basketNoticeText}>
                  Strict Basket Isolation: Network fee is funded exclusively
                  from the &apos;default&apos; BSV basket.
                </Text>
              </View>
            </View>

            {needsManualAmountInput && !txResult ? (
              <View style={styles.manualAmountSection}>
                <Text style={styles.inputLabel}>
                  Enter Amount to Send (BSV)
                </Text>
                <TextInput
                  style={styles.input}
                  value={editableBsvAmount}
                  onChangeText={setEditableBsvAmount}
                  placeholder="e.g. 0.01"
                  placeholderTextColor="#64748B"
                  keyboardType="decimal-pad"
                  editable={!submitting}
                />
              </View>
            ) : null}

            {errorMsg ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Transaction Error</Text>
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            {txResult ? (
              <View style={styles.successBox}>
                <Text style={styles.successTitle}>
                  Broadcast Confirmed via ARC
                </Text>
                <Text style={styles.successSummary}>{txResult.summary}</Text>
                <Text style={styles.successTxid} selectable>
                  TXID: {txResult.txid}
                </Text>
                <Text style={styles.successFee}>
                  Actual Network Fee: {txResult.feeSatoshis} sats
                </Text>
              </View>
            ) : (
              <Pressable
                style={[
                  styles.confirmBtn,
                  submitting && styles.confirmBtnDisabled,
                ]}
                onPress={handleConfirmSend}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.confirmBtnText}>
                    Sign & Broadcast Transaction
                  </Text>
                )}
              </Pressable>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.84)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
    maxHeight: '90%',
    borderTopWidth: 1,
    borderColor: '#1E293B',
  },
  handleBar: {
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#334155',
    alignSelf: 'center',
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '800',
  },
  subtitle: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  closeBtnText: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '700',
  },
  scrollContent: {
    paddingBottom: 16,
  },
  assetBadgeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  assetBadge: {
    backgroundColor: '#1E3A8A',
    borderColor: '#3B82F6',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
  },
  assetBadgeLabel: {
    color: '#93C5FD',
    fontSize: 12,
    fontWeight: '700',
  },
  networkBadge: {
    color: '#34D399',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  summaryCard: {
    backgroundColor: '#020617',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 14,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  detailColumn: {
    paddingVertical: 6,
  },
  detailLabel: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  detailValue: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
  },
  detailValueHighlight: {
    color: '#38BDF8',
    fontSize: 14,
    fontWeight: '800',
  },
  monoValue: {
    color: '#E2E8F0',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  feeValue: {
    color: '#FBBF24',
    fontSize: 12,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    backgroundColor: '#1E293B',
    marginVertical: 6,
  },
  basketNotice: {
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 8,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  basketNoticeText: {
    color: '#64748B',
    fontSize: 11,
  },
  manualAmountSection: {
    marginBottom: 14,
  },
  inputLabel: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: '#F8FAFC',
    fontSize: 15,
  },
  errorBox: {
    backgroundColor: '#450A0A',
    borderColor: '#DC2626',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  errorTitle: {
    color: '#FCA5A5',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  errorText: {
    color: '#FECACA',
    fontSize: 12,
  },
  successBox: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  successTitle: {
    color: '#6EE7B7',
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 4,
  },
  successSummary: {
    color: '#ECFDF5',
    fontSize: 13,
    marginBottom: 6,
  },
  successTxid: {
    color: '#A7F3D0',
    fontSize: 11,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  successFee: {
    color: '#6EE7B7',
    fontSize: 11,
    fontWeight: '600',
  },
  confirmBtn: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  confirmBtnDisabled: {
    opacity: 0.6,
  },
  confirmBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
});
