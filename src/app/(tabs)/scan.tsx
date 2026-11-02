import React, { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { QrScannerView } from '@/components/QrScannerView';
import { ReceiveModal } from '@/components/ReceiveModal';
import { ConfirmSendSheet } from '@/components/ConfirmSendSheet';
import { NfcModal, type NfcModalMode } from '@/components/NfcModal';
import { keyVaultService } from '@/services/wallet/KeyVaultService';
import {
  brc100WalletEngine,
  type Bsv21TokenBalanceSummary,
} from '@/services/wallet/Brc100WalletEngine';
import {
  encodePaymentRequest,
  type DecodedPaymentRequest,
} from '@/services/scanner/PaymentUriCodec';
import { nfcService } from '@/services/nfc/NfcService';

type ScanTabMode = 'qr' | 'nfc';

export default function ScanTapScreen(): React.JSX.Element {
  const [activeTabMode, setActiveTabMode] = useState<ScanTabMode>('qr');
  const [nfcStatus, setNfcStatus] = useState<{
    supported: boolean;
    enabled: boolean;
    checked: boolean;
  }>({
    supported: false,
    enabled: false,
    checked: false,
  });

  const [walletAddress, setWalletAddress] = useState<string>(
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
  );
  const [tokenBalances, setTokenBalances] = useState<
    Bsv21TokenBalanceSummary[]
  >([]);
  const [receiveModalVisible, setReceiveModalVisible] =
    useState<boolean>(false);
  const [nfcModalConfig, setNfcModalConfig] = useState<{
    visible: boolean;
    mode: NfcModalMode;
    paymentUri?: string;
  }>({
    visible: false,
    mode: 'read',
  });
  const [decodedRequest, setDecodedRequest] =
    useState<DecodedPaymentRequest | null>(null);
  const [lastTxBanner, setLastTxBanner] = useState<{
    txid: string;
    summary: string;
  } | null>(null);

  const loadWalletContext = useCallback(async () => {
    try {
      const meta = keyVaultService.getUnlockedMetadata();
      if (meta?.address) {
        setWalletAddress(meta.address);
      }
      const tokens = await brc100WalletEngine.getBsv21TokenBalances();
      setTokenBalances(tokens);
    } catch {
      // Wallet may not be unlocked yet
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => loadWalletContext());

    let mounted = true;
    nfcService
      .initialize()
      .then((hw) => {
        if (mounted) {
          setNfcStatus({
            supported: hw.supported,
            enabled: hw.enabled,
            checked: true,
          });
        }
      })
      .catch(() => {
        if (mounted) {
          setNfcStatus({
            supported: false,
            enabled: false,
            checked: true,
          });
        }
      });

    return () => {
      mounted = false;
    };
  }, [loadWalletContext]);

  const handleSelectTabMode = (nextMode: ScanTabMode): void => {
    void Haptics.selectionAsync();
    setActiveTabMode(nextMode);
  };

  const handleOpenReceiveModal = (): void => {
    void Haptics.selectionAsync();
    void loadWalletContext();
    setReceiveModalVisible(true);
  };

  const handleStartScanViaNfc = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setNfcModalConfig({
      visible: true,
      mode: 'read',
    });
  };

  const handleStartShareViaNfc = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void loadWalletContext();
    const defaultReceiveUri = encodePaymentRequest({
      kind: 'bip21',
      recipient: walletAddress,
      label: 'BSV NFC Tap-to-Receive',
    });
    setNfcModalConfig({
      visible: true,
      mode: 'write',
      paymentUri: defaultReceiveUri,
    });
  };

  const handlePaymentDecoded = useCallback(
    (decoded: DecodedPaymentRequest): void => {
      setNfcModalConfig((prev) => ({ ...prev, visible: false }));
      setDecodedRequest(decoded);
    },
    []
  );

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      keyboardShouldPersistTaps="handled"
    >
      {/* Top Action Header */}
      <View style={styles.headerCard}>
        <View style={styles.headerTextCol}>
          <Text style={styles.headerTitle}>Scan QR &amp; NFC Tap-to-Pay</Text>
          <Text style={styles.headerSubtitle}>
            Unified BIP-21 • BSV-21 • 1Sat NFT • BRC-100 Engine
          </Text>
        </View>
        <Pressable
          style={styles.receiveQrButton}
          onPress={handleOpenReceiveModal}
        >
          <Text style={styles.receiveQrButtonText}>Receive</Text>
        </Pressable>
      </View>

      {/* QR Scanner vs NFC Tap Mode Toggle */}
      <View style={styles.modeToggleBar}>
        <Pressable
          style={[
            styles.modeToggleBtn,
            activeTabMode === 'qr' && styles.modeToggleBtnActive,
          ]}
          onPress={() => handleSelectTabMode('qr')}
        >
          <Text
            style={[
              styles.modeToggleText,
              activeTabMode === 'qr' && styles.modeToggleTextActive,
            ]}
          >
            QR Scanner
          </Text>
        </Pressable>

        <Pressable
          style={[
            styles.modeToggleBtn,
            activeTabMode === 'nfc' && styles.modeToggleBtnActiveNfc,
          ]}
          onPress={() => handleSelectTabMode('nfc')}
        >
          <Text
            style={[
              styles.modeToggleText,
              activeTabMode === 'nfc' && styles.modeToggleTextActive,
            ]}
          >
            NFC Tap
          </Text>
        </Pressable>
      </View>

      {lastTxBanner ? (
        <View style={styles.txBanner}>
          <View style={styles.txBannerHeader}>
            <Text style={styles.txBannerTitle}>Last Broadcast Transaction</Text>
            <Pressable onPress={() => setLastTxBanner(null)}>
              <Text style={styles.txBannerDismiss}>Dismiss</Text>
            </Pressable>
          </View>
          <Text style={styles.txBannerSummary}>{lastTxBanner.summary}</Text>
          <Text style={styles.txBannerTxid} selectable>
            TXID: {lastTxBanner.txid}
          </Text>
        </View>
      ) : null}

      {activeTabMode === 'qr' ? (
        <>
          {/* VisionCamera QR Code Scanner */}
          <QrScannerView
            isActive={
              !receiveModalVisible &&
              !nfcModalConfig.visible &&
              decodedRequest === null
            }
            onPaymentDecoded={handlePaymentDecoded}
          />

          {/* Quick NFC Tap Trigger Strip alongside QR Scanner */}
          <View style={styles.quickNfcStrip}>
            <View style={styles.quickNfcInfo}>
              <Text style={styles.quickNfcTitle}>Prefer Contactless Tap?</Text>
              <Text style={styles.quickNfcSub}>
                Read or broadcast NDEF payment URIs via NFC
              </Text>
            </View>
            <Pressable
              style={styles.quickNfcBtn}
              onPress={handleStartScanViaNfc}
            >
              <Text style={styles.quickNfcBtnText}>Scan via NFC</Text>
            </Pressable>
          </View>
        </>
      ) : (
        /* Dedicated NFC Tap-to-Pay & Tap-to-Receive Panel */
        <View style={styles.nfcPanel}>
          <View style={styles.nfcHeroCircle}>
            <Text style={styles.nfcHeroIcon}>NFC</Text>
          </View>
          <Text style={styles.nfcPanelTitle}>
            Contactless BSV &amp; Token Tap
          </Text>
          <Text style={styles.nfcPanelDescription}>
            Hold your phone near another BSV wallet or NDEF payment tag to
            instantly read or share BIP-21 BSV, BSV-21 Token, or 1Sat Ordinal
            NFT requests.
          </Text>

          <View style={styles.nfcActionStack}>
            <Pressable
              style={styles.scanViaNfcBtn}
              onPress={handleStartScanViaNfc}
            >
              <Text style={styles.scanViaNfcBtnTitle}>
                Scan via NFC (Sender Tap-to-Pay)
              </Text>
              <Text style={styles.scanViaNfcBtnSub}>
                Reads NDEF tag • Opens Confirm Sheet for Biometric Sign &amp; ARC Broadcast
              </Text>
            </Pressable>

            <Pressable
              style={styles.shareViaNfcBtn}
              onPress={handleStartShareViaNfc}
            >
              <Text style={styles.shareViaNfcBtnTitle}>
                Share via NFC (Receiver Address Tap)
              </Text>
              <Text style={styles.shareViaNfcBtnSub}>
                Broadcasts {walletAddress.slice(0, 12)}... as an NDEF URI record
              </Text>
            </Pressable>

            <Pressable
              style={styles.customReceiveNfcBtn}
              onPress={handleOpenReceiveModal}
            >
              <Text style={styles.customReceiveNfcBtnText}>
                Configure Custom Amount / BSV-21 / 1Sat NFC Request
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Supported URI Formats Reference Card */}
      <View style={styles.formatsCard}>
        <Text style={styles.formatsTitle}>Supported QR &amp; NDEF Formats</Text>
        <Text style={styles.formatItem}>
          • Raw BSV Address or Paymail (alias@domain.tld)
        </Text>
        <Text style={styles.formatItem}>
          • BIP-21 BSV: bitcoin:&lt;addr&gt;?sv&amp;amount=&lt;bsv&gt;&amp;label=&lt;note&gt;
        </Text>
        <Text style={styles.formatItem}>
          • BSV-21 Token: bitcoin:&lt;addr&gt;?sv&amp;asset=bsv21&amp;tokenId=&lt;id&gt;&amp;tokenAmount=&lt;amt&gt;
        </Text>
        <Text style={styles.formatItem}>
          • 1Sat Ordinal: bitcoin:&lt;addr&gt;?sv&amp;asset=1sat&amp;outpoint=&lt;txid.vout&gt;
        </Text>
        <Text style={styles.formatItem}>
          • BRC-100 JSON Action Request (createAction payload)
        </Text>
      </View>

      {/* NFC Hardware Status Card */}
      <View style={styles.nfcCard}>
        <View style={styles.nfcRow}>
          <Text style={styles.nfcLabel}>NFC Hardware Status</Text>
          <Text style={styles.nfcValue}>
            {!nfcStatus.checked
              ? 'Checking...'
              : !nfcStatus.supported
                ? 'Simulator / Unavailable (Presets Active)'
                : nfcStatus.enabled
                  ? 'Ready (NDEF / ISO-14443)'
                  : 'NFC Disabled in Settings'}
          </Text>
        </View>
      </View>

      {/* Receive Payment QR & NFC Modal */}
      <ReceiveModal
        visible={receiveModalVisible}
        address={walletAddress}
        tokens={tokenBalances}
        onClose={() => setReceiveModalVisible(false)}
      />

      {/* NFC Read / Write Session Modal */}
      <NfcModal
        visible={nfcModalConfig.visible}
        mode={nfcModalConfig.mode}
        paymentUri={nfcModalConfig.paymentUri}
        onClose={() =>
          setNfcModalConfig((prev) => ({ ...prev, visible: false }))
        }
        onPaymentRead={handlePaymentDecoded}
      />

      {/* Unified Confirm Transaction Bottom Sheet */}
      <ConfirmSendSheet
        visible={decodedRequest !== null}
        request={decodedRequest}
        onClose={() => setDecodedRequest(null)}
        onSuccess={(result) => {
          setLastTxBanner(result);
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 36,
  },
  headerCard: {
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#334155',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  headerTextCol: {
    flex: 1,
    paddingRight: 12,
  },
  headerTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '800',
  },
  headerSubtitle: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 3,
  },
  receiveQrButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  receiveQrButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  modeToggleBar: {
    flexDirection: 'row',
    backgroundColor: '#020617',
    borderRadius: 12,
    padding: 4,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  modeToggleBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
  },
  modeToggleBtnActive: {
    backgroundColor: '#2563EB',
  },
  modeToggleBtnActiveNfc: {
    backgroundColor: '#059669',
  },
  modeToggleText: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '800',
  },
  modeToggleTextActive: {
    color: '#FFFFFF',
  },
  txBanner: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginBottom: 14,
  },
  txBannerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  txBannerTitle: {
    color: '#6EE7B7',
    fontSize: 13,
    fontWeight: '800',
  },
  txBannerDismiss: {
    color: '#A7F3D0',
    fontSize: 12,
    fontWeight: '700',
  },
  txBannerSummary: {
    color: '#ECFDF5',
    fontSize: 12,
    marginBottom: 3,
  },
  txBannerTxid: {
    color: '#A7F3D0',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  quickNfcStrip: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginTop: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  quickNfcInfo: {
    flex: 1,
  },
  quickNfcTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
  },
  quickNfcSub: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  quickNfcBtn: {
    backgroundColor: '#059669',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  quickNfcBtnText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  nfcPanel: {
    backgroundColor: '#1E293B',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: '#334155',
    alignItems: 'center',
  },
  nfcHeroCircle: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: '#020617',
    borderWidth: 2,
    borderColor: '#10B981',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  nfcHeroIcon: {
    color: '#34D399',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 1,
  },
  nfcPanelTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 6,
  },
  nfcPanelDescription: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 18,
  },
  nfcActionStack: {
    width: '100%',
    gap: 10,
  },
  scanViaNfcBtn: {
    backgroundColor: '#2563EB',
    borderRadius: 14,
    padding: 15,
  },
  scanViaNfcBtnTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  scanViaNfcBtnSub: {
    color: '#DBEAFE',
    fontSize: 11,
    marginTop: 3,
  },
  shareViaNfcBtn: {
    backgroundColor: '#059669',
    borderRadius: 14,
    padding: 15,
  },
  shareViaNfcBtnTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  shareViaNfcBtnSub: {
    color: '#D1FAE5',
    fontSize: 11,
    marginTop: 3,
  },
  customReceiveNfcBtn: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  customReceiveNfcBtnText: {
    color: '#93C5FD',
    fontSize: 12,
    fontWeight: '700',
  },
  formatsCard: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginTop: 14,
    gap: 5,
  },
  formatsTitle: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 3,
  },
  formatItem: {
    color: '#94A3B8',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  nfcCard: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
    marginTop: 12,
  },
  nfcRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  nfcLabel: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  nfcValue: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '700',
  },
});
