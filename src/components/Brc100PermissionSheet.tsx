import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  brc100AppBridge,
  type PendingBrc100PermissionRequest,
} from '@/services/brc100/AppBridge';
import { BASKET_METADATA } from '@/constants/baskets';

export interface Brc100PermissionSheetProps {
  /**
   * Optional override for controlled rendering; when omitted, subscribes
   * automatically to `brc100AppBridge`.
   */
  overrideRequest?: PendingBrc100PermissionRequest | null;
}

export function Brc100PermissionSheet({
  overrideRequest,
}: Brc100PermissionSheetProps = {}): React.JSX.Element {
  const [subscribedRequest, setSubscribedRequest] =
    useState<PendingBrc100PermissionRequest | null>(() =>
      brc100AppBridge.getActivePermissionRequest()
    );
  const [approving, setApproving] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = brc100AppBridge.subscribePermissionRequests((req) => {
      setSubscribedRequest(req);
      setErrorMsg(null);
      setApproving(false);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const activeRequest =
    overrideRequest !== undefined ? overrideRequest : subscribedRequest;

  if (!activeRequest) {
    return <></>;
  }

  const handleApprove = async (): Promise<void> => {
    setApproving(true);
    setErrorMsg(null);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await brc100AppBridge.approveActivePermissionRequest();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setErrorMsg(
        err instanceof Error ? err.message : 'Biometric confirmation failed.'
      );
      setApproving(false);
    }
  };

  const handleReject = (): void => {
    void Haptics.selectionAsync();
    brc100AppBridge.rejectActivePermissionRequest();
  };

  return (
    <Modal
      visible={activeRequest !== null}
      transparent
      animationType="slide"
      onRequestClose={handleReject}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.handleBar} />

          <View style={styles.badgeRow}>
            <View
              style={[
                styles.typePill,
                activeRequest.approvalType === 'sign-action'
                  ? styles.typePillSign
                  : styles.typePillBasket,
              ]}
            >
              <Text style={styles.typePillText}>
                {activeRequest.approvalType === 'sign-action'
                  ? 'BRC-100 SIGNATURE REQUEST'
                  : 'BRC-100 BASKET ACCESS REQUEST'}
              </Text>
            </View>
          </View>

          <Text style={styles.title}>dApp Permission Request</Text>
          <Text style={styles.subtitle}>
            An external BRC-100 application is requesting wallet authorization.
          </Text>

          <View style={styles.detailsCard}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Originator dApp</Text>
              <Text style={styles.originatorValue}>
                {activeRequest.originator}
              </Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>WalletWire Method</Text>
              <Text style={styles.methodValue}>{activeRequest.method}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.detailCol}>
              <Text style={styles.detailLabel}>Requested Baskets</Text>
              <View style={styles.basketsWrap}>
                {activeRequest.baskets.length > 0 ? (
                  activeRequest.baskets.map((basket) => {
                    const meta = BASKET_METADATA[basket];
                    return (
                      <View key={basket} style={styles.basketChip}>
                        <Text style={styles.basketChipCode}>
                          {basket.toUpperCase()}
                        </Text>
                        <Text style={styles.basketChipLabel}>
                          {meta?.label ?? basket}
                        </Text>
                      </View>
                    );
                  })
                ) : (
                  <Text style={styles.detailSummary}>
                    Cryptographic Key Operation (No UTXO Basket)
                  </Text>
                )}
              </View>
            </View>

            {activeRequest.totalSatoshis !== undefined ? (
              <>
                <View style={styles.divider} />
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Output Satoshis</Text>
                  <Text style={styles.satsValue}>
                    {activeRequest.totalSatoshis.toLocaleString()} sats
                  </Text>
                </View>
              </>
            ) : null}

            <View style={styles.divider} />

            <View style={styles.detailCol}>
              <Text style={styles.detailLabel}>Action / Scope Summary</Text>
              <Text style={styles.detailSummary}>{activeRequest.summary}</Text>
            </View>
          </View>

          {errorMsg ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
          ) : null}

          <View style={styles.buttonsRow}>
            <Pressable
              style={styles.rejectBtn}
              onPress={handleReject}
              disabled={approving}
            >
              <Text style={styles.rejectBtnText}>Reject</Text>
            </Pressable>

            <Pressable
              style={[
                styles.approveBtn,
                approving && styles.approveBtnDisabled,
              ]}
              onPress={handleApprove}
              disabled={approving}
            >
              {approving ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.approveBtnText}>
                  Biometric Approve
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.85)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderColor: '#1E293B',
  },
  handleBar: {
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#334155',
    alignSelf: 'center',
    marginBottom: 14,
  },
  badgeRow: {
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  typePill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  typePillSign: {
    backgroundColor: '#451A03',
    borderColor: '#F59E0B',
  },
  typePillBasket: {
    backgroundColor: '#1E3A8A',
    borderColor: '#3B82F6',
  },
  typePillText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 4,
  },
  subtitle: {
    color: '#94A3B8',
    fontSize: 13,
    marginBottom: 16,
  },
  detailsCard: {
    backgroundColor: '#020617',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  detailCol: {
    paddingVertical: 6,
  },
  detailLabel: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  originatorValue: {
    color: '#38BDF8',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  methodValue: {
    color: '#FBBF24',
    fontSize: 13,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  satsValue: {
    color: '#34D399',
    fontSize: 13,
    fontWeight: '800',
  },
  basketsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  basketChip: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  basketChipCode: {
    color: '#60A5FA',
    fontSize: 11,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  basketChipLabel: {
    color: '#CBD5E1',
    fontSize: 11,
  },
  detailSummary: {
    color: '#E2E8F0',
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  divider: {
    height: 1,
    backgroundColor: '#1E293B',
    marginVertical: 6,
  },
  errorBox: {
    backgroundColor: '#450A0A',
    borderColor: '#DC2626',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 14,
  },
  errorText: {
    color: '#FECACA',
    fontSize: 12,
  },
  buttonsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  rejectBtn: {
    flex: 1,
    backgroundColor: '#1E293B',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  rejectBtnText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '700',
  },
  approveBtn: {
    flex: 1.4,
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  approveBtnDisabled: {
    opacity: 0.65,
  },
  approveBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
});
