import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  DEFAULT_NFC_ALERT_MESSAGE,
  nfcService,
  NfcServiceError,
} from '../services/nfc/NfcService';
import {
  decodePaymentRequest,
  type DecodedPaymentRequest,
} from '../services/scanner/PaymentUriCodec';

export type NfcModalMode = 'read' | 'write';

export interface NfcModalProps {
  visible: boolean;
  mode: NfcModalMode;
  paymentUri?: string;
  onClose: () => void;
  onPaymentRead?: (decoded: DecodedPaymentRequest) => void;
  onWriteComplete?: (writtenUri: string) => void;
}

type SessionState =
  | 'idle'
  | 'scanning'
  | 'success'
  | 'cancelled'
  | 'unsupported'
  | 'disabled'
  | 'error';

export function NfcModal({
  visible,
  mode,
  paymentUri,
  onClose,
  onPaymentRead,
  onWriteComplete,
}: NfcModalProps): React.JSX.Element {
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [statusMessage, setStatusMessage] = useState<string>(
    DEFAULT_NFC_ALERT_MESSAGE
  );
  const [decodedPreview, setDecodedPreview] =
    useState<DecodedPaymentRequest | null>(null);

  const startNfcSession = useCallback(async () => {
    await Promise.resolve();
    setSessionState('scanning');
    setDecodedPreview(null);
    setStatusMessage(DEFAULT_NFC_ALERT_MESSAGE);

    try {
      const hw = await nfcService.initialize();
      if (!hw.supported) {
        setSessionState('unsupported');
        setStatusMessage(
          'NFC hardware is unavailable on this device or simulator. You can simulate an NFC tap below.'
        );
        return;
      }
      if (!hw.enabled) {
        setSessionState('disabled');
        setStatusMessage(
          'NFC is disabled in system settings. Enable NFC to use Tap-to-Pay.'
        );
        return;
      }

      if (mode === 'read') {
        const result = await nfcService.readPaymentTag({
          alertMessage: DEFAULT_NFC_ALERT_MESSAGE,
        });
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
        setDecodedPreview(result);
        setSessionState('success');
        setStatusMessage('Payment tag read! Routing to confirmation...');
        onPaymentRead?.(result);
      } else {
        const targetUri = (paymentUri ?? '').trim();
        const validated = decodePaymentRequest(targetUri);
        setDecodedPreview(validated);
        await nfcService.writePaymentRequestToTag(targetUri, {
          alertMessage: DEFAULT_NFC_ALERT_MESSAGE,
        });
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
        setSessionState('success');
        setStatusMessage(
          'NDEF payment request broadcast complete! The tapping device received your payment details.'
        );
        onWriteComplete?.(targetUri);
      }
    } catch (err) {
      if (err instanceof NfcServiceError) {
        if (err.isCancelled) {
          setSessionState('cancelled');
          setStatusMessage('NFC session cancelled.');
          return;
        }
        if (err.code === 'NFC_UNSUPPORTED') {
          setSessionState('unsupported');
          setStatusMessage(err.message);
          return;
        }
        if (err.code === 'NFC_DISABLED') {
          setSessionState('disabled');
          setStatusMessage(err.message);
          return;
        }
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSessionState('error');
      setStatusMessage(
        err instanceof Error ? err.message : 'NFC session failed.'
      );
    }
  }, [mode, paymentUri, onPaymentRead, onWriteComplete]);

  useEffect(() => {
    if (!visible) {
      void nfcService.cancelSession();
      return;
    }

    void Promise.resolve().then(() => startNfcSession());

    return () => {
      void nfcService.cancelSession();
    };
  }, [visible, startNfcSession]);

  const handleCancelAndClose = async (): Promise<void> => {
    void Haptics.selectionAsync();
    await nfcService.cancelSession();
    onClose();
  };

  const handleSimulateNfcRead = async (sampleUri: string): Promise<void> => {
    try {
      const decoded = decodePaymentRequest(sampleUri);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDecodedPreview(decoded);
      setSessionState('success');
      onPaymentRead?.(decoded);
    } catch (err) {
      setSessionState('error');
      setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancelAndClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.badgeRow}>
            <View
              style={[
                styles.modePill,
                mode === 'write' ? styles.modePillWrite : styles.modePillRead,
              ]}
            >
              <Text style={styles.modePillText}>
                {mode === 'read'
                  ? 'NFC TAP-TO-PAY (READ NDEF)'
                  : 'NFC TAP-TO-RECEIVE (WRITE NDEF)'}
              </Text>
            </View>
          </View>

          <Text style={styles.title}>
            {mode === 'read' ? 'Scan via NFC' : 'Share via NFC'}
          </Text>

          <Text style={styles.subtitle}>
            {mode === 'read'
              ? 'Tap a receiver device or BSV NFC payment tag to load the payment request.'
              : 'Hold near the sender phone or NFC tag to write your NDEF payment request.'}
          </Text>

          {/* Animated / Visual NFC Radar Ring */}
          <View style={styles.radarOuter}>
            <View
              style={[
                styles.radarInner,
                sessionState === 'success' && styles.radarInnerSuccess,
                sessionState === 'error' && styles.radarInnerError,
              ]}
            >
              {sessionState === 'scanning' ? (
                <ActivityIndicator size="large" color="#38BDF8" />
              ) : (
                <Text style={styles.radarIconText}>
                  {sessionState === 'success'
                    ? 'OK'
                    : sessionState === 'error'
                      ? '!'
                      : 'NFC'}
                </Text>
              )}
            </View>
          </View>

          <Text style={styles.statusText}>{statusMessage}</Text>

          {/* When in write mode, show the NDEF URI being broadcast */}
          {mode === 'write' && paymentUri ? (
            <View style={styles.payloadBox}>
              <Text style={styles.payloadLabel}>
                NDEF URI Record Payload ({paymentUri.length} bytes)
              </Text>
              <Text
                style={styles.payloadMono}
                numberOfLines={3}
                selectable
              >
                {paymentUri}
              </Text>
            </View>
          ) : null}

          {decodedPreview ? (
            <View style={styles.decodedSummaryBox}>
              <Text style={styles.decodedSummaryTitle}>
                Asset: {decodedPreview.asset.toUpperCase()} • Recipient:{' '}
                {decodedPreview.recipient.slice(0, 14)}...
              </Text>
            </View>
          ) : null}

          {/* Android Open NFC Settings Button if Disabled */}
          {sessionState === 'disabled' && Platform.OS === 'android' ? (
            <Pressable
              style={styles.primaryBtn}
              onPress={() => void nfcService.openNfcSettings()}
            >
              <Text style={styles.primaryBtnText}>
                Open Android NFC Settings
              </Text>
            </Pressable>
          ) : null}

          {/* Retry button if cancelled, timed out, or errored */}
          {(sessionState === 'cancelled' || sessionState === 'error') && (
            <Pressable
              style={styles.primaryBtn}
              onPress={() => void startNfcSession()}
            >
              <Text style={styles.primaryBtnText}>
                {mode === 'read' ? 'Retry Scan via NFC' : 'Retry Share via NFC'}
              </Text>
            </Pressable>
          )}

          {/* Simulator Fallback Presets when NFC Hardware is Unavailable */}
          {sessionState === 'unsupported' && mode === 'read' ? (
            <View style={styles.simBox}>
              <Text style={styles.simTitle}>
                Simulator NFC Tap Presets (NDEF URI)
              </Text>
              <View style={styles.simRow}>
                <Pressable
                  style={styles.simChip}
                  onPress={() =>
                    void handleSimulateNfcRead(
                      'bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa?sv&amount=0.005&label=NFC%20Tap%20Coffee'
                    )
                  }
                >
                  <Text style={styles.simChipText}>Tap BSV (0.005)</Text>
                </Pressable>

                <Pressable
                  style={styles.simChip}
                  onPress={() =>
                    void handleSimulateNfcRead(
                      'bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa?sv&asset=bsv21&tokenId=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855_0&tokenAmount=50&symbol=MNEE'
                    )
                  }
                >
                  <Text style={styles.simChipText}>Tap BSV-21 (50 MNEE)</Text>
                </Pressable>

                <Pressable
                  style={styles.simChip}
                  onPress={() =>
                    void handleSimulateNfcRead(
                      'bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa?sv&asset=1sat&outpoint=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.0&name=NFC%20Ordinal'
                    )
                  }
                >
                  <Text style={styles.simChipText}>Tap 1Sat NFT</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <Pressable style={styles.cancelBtn} onPress={handleCancelAndClose}>
            <Text style={styles.cancelBtnText}>
              {sessionState === 'success' ? 'Done' : 'Cancel NFC Session'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.86)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#0F172A',
    borderRadius: 24,
    padding: 22,
    borderWidth: 1,
    borderColor: '#1E293B',
    alignItems: 'center',
  },
  badgeRow: {
    marginBottom: 10,
  },
  modePill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  modePillRead: {
    backgroundColor: '#0C4A6E',
    borderColor: '#38BDF8',
  },
  modePillWrite: {
    backgroundColor: '#064E3B',
    borderColor: '#34D399',
  },
  modePillText: {
    color: '#E0F2FE',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 6,
  },
  subtitle: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 20,
  },
  radarOuter: {
    width: 118,
    height: 118,
    borderRadius: 59,
    backgroundColor: 'rgba(56, 189, 248, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 18,
  },
  radarInner: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: '#020617',
    borderWidth: 2,
    borderColor: '#38BDF8',
    justifyContent: 'center',
    alignItems: 'center',
  },
  radarInnerSuccess: {
    borderColor: '#10B981',
    backgroundColor: '#064E3B',
  },
  radarInnerError: {
    borderColor: '#EF4444',
    backgroundColor: '#450A0A',
  },
  radarIconText: {
    color: '#38BDF8',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 1,
  },
  statusText: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 14,
  },
  payloadBox: {
    width: '100%',
    backgroundColor: '#020617',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 14,
  },
  payloadLabel: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  payloadMono: {
    color: '#93C5FD',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  decodedSummaryBox: {
    width: '100%',
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 14,
    alignItems: 'center',
  },
  decodedSummaryTitle: {
    color: '#A7F3D0',
    fontSize: 12,
    fontWeight: '700',
  },
  primaryBtn: {
    width: '100%',
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginBottom: 10,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  simBox: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
    marginBottom: 14,
  },
  simTitle: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  simRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
  },
  simChip: {
    backgroundColor: '#0F172A',
    borderColor: '#38BDF8',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  simChipText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
  cancelBtn: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '700',
  },
});
