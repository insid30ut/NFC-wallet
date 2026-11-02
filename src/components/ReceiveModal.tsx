import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Haptics from 'expo-haptics';
import {
  encodePaymentRequest,
  PaymentUriCodecError,
} from '../services/scanner/PaymentUriCodec';
import type { Bsv21TokenBalanceSummary } from '../services/wallet/Brc100WalletEngine';
import { NfcModal } from './NfcModal';

export interface ReceiveModalProps {
  visible: boolean;
  address: string;
  tokens?: Bsv21TokenBalanceSummary[];
  onClose: () => void;
}

type ReceiveMode = 'address' | 'bip21' | 'bsv21' | '1sat';
type ShareChannel = 'qr' | 'nfc';

export function ReceiveModal({
  visible,
  address,
  tokens = [],
  onClose,
}: ReceiveModalProps): React.JSX.Element {
  const [channel, setChannel] = useState<ShareChannel>('qr');
  const [mode, setMode] = useState<ReceiveMode>('bip21');
  const [bsvAmountInput, setBsvAmountInput] = useState<string>('');
  const [labelInput, setLabelInput] = useState<string>('');
  const [tokenIdInput, setTokenIdInput] = useState<string>(
    tokens[0]?.tokenId ?? ''
  );
  const [tokenSymbolInput, setTokenSymbolInput] = useState<string>(
    tokens[0]?.symbol ?? ''
  );
  const [tokenAmountInput, setTokenAmountInput] = useState<string>('');
  const [nftOutpointInput, setNftOutpointInput] = useState<string>('');
  const [nftNameInput, setNftNameInput] = useState<string>('');
  const [sharedFeedback, setSharedFeedback] = useState<boolean>(false);
  const [nfcModalVisible, setNfcModalVisible] = useState<boolean>(false);
  const [nfcWriteDoneBanner, setNfcWriteDoneBanner] = useState<boolean>(false);

  const fallbackAddress =
    address && address.trim().length > 0
      ? address.trim()
      : '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

  const { uriPayload, validationWarning } = useMemo(() => {
    try {
      if (mode === 'address') {
        return {
          uriPayload: encodePaymentRequest({
            kind: 'address',
            recipient: fallbackAddress,
          }),
          validationWarning: null,
        };
      }

      if (mode === 'bip21') {
        const trimmedAmount = bsvAmountInput.trim();
        const amountBsv =
          trimmedAmount.length > 0 ? Number(trimmedAmount) : undefined;

        return {
          uriPayload: encodePaymentRequest({
            kind: 'bip21',
            recipient: fallbackAddress,
            amountBsv,
            label: labelInput.trim() || undefined,
          }),
          validationWarning: null,
        };
      }

      if (mode === 'bsv21') {
        const effectiveTokenId =
          tokenIdInput.trim() ||
          tokens[0]?.tokenId ||
          '0000000000000000000000000000000000000000000000000000000000000001_0';
        const effectiveTokenAmount = tokenAmountInput.trim() || '1';

        return {
          uriPayload: encodePaymentRequest({
            kind: 'bsv21',
            recipient: fallbackAddress,
            tokenId: effectiveTokenId,
            tokenAmount: effectiveTokenAmount,
            symbol: tokenSymbolInput.trim() || undefined,
            label: labelInput.trim() || undefined,
          }),
          validationWarning:
            !tokenIdInput.trim() || !tokenAmountInput.trim()
              ? 'Enter a valid BSV-21 Token ID (<txid_vout>) and amount below.'
              : null,
        };
      }

      // mode === '1sat'
      const effectiveOutpoint =
        nftOutpointInput.trim() ||
        '0000000000000000000000000000000000000000000000000000000000000001.0';

      return {
        uriPayload: encodePaymentRequest({
          kind: '1sat',
          recipient: fallbackAddress,
          outpoint: effectiveOutpoint,
          name: nftNameInput.trim() || undefined,
          label: labelInput.trim() || undefined,
        }),
        validationWarning: !nftOutpointInput.trim()
          ? 'Enter a 1Sat Ordinal outpoint (<txid.vout>) below.'
          : null,
      };
    } catch (err) {
      const msg =
        err instanceof PaymentUriCodecError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        uriPayload: fallbackAddress,
        validationWarning: msg,
      };
    }
  }, [
    mode,
    fallbackAddress,
    bsvAmountInput,
    labelInput,
    tokenIdInput,
    tokenSymbolInput,
    tokenAmountInput,
    nftOutpointInput,
    nftNameInput,
    tokens,
  ]);

  const handleSelectMode = (nextMode: ReceiveMode): void => {
    void Haptics.selectionAsync();
    setMode(nextMode);
  };

  const handleSelectChannel = (nextChannel: ShareChannel): void => {
    void Haptics.selectionAsync();
    setChannel(nextChannel);
    if (nextChannel === 'nfc') {
      setNfcModalVisible(true);
    }
  };

  const handleSelectKnownToken = (token: Bsv21TokenBalanceSummary): void => {
    void Haptics.selectionAsync();
    setTokenIdInput(token.tokenId);
    setTokenSymbolInput(token.symbol);
  };

  const handleShareUri = async (): Promise<void> => {
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await Share.share({
        message: uriPayload,
        title: 'BSV Payment Request',
      });
      setSharedFeedback(true);
      setTimeout(() => setSharedFeedback(false), 2000);
    } catch {
      // User dismissed native share sheet
    }
  };

  const handleOpenNfcShare = (): void => {
    void Haptics.selectionAsync();
    setNfcWriteDoneBanner(false);
    setNfcModalVisible(true);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.title}>Receive Payment</Text>
              <Text style={styles.subtitle}>
                Dynamic QR &amp; NFC NDEF Payment Generator
              </Text>
            </View>
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>Done</Text>
            </Pressable>
          </View>

          {/* QR vs NFC Tap Channel Toggle */}
          <View style={styles.channelToggle}>
            <Pressable
              style={[
                styles.channelBtn,
                channel === 'qr' && styles.channelBtnActive,
              ]}
              onPress={() => handleSelectChannel('qr')}
            >
              <Text
                style={[
                  styles.channelBtnText,
                  channel === 'qr' && styles.channelBtnTextActive,
                ]}
              >
                QR Code
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.channelBtn,
                channel === 'nfc' && styles.channelBtnActiveNfc,
              ]}
              onPress={() => handleSelectChannel('nfc')}
            >
              <Text
                style={[
                  styles.channelBtnText,
                  channel === 'nfc' && styles.channelBtnTextActive,
                ]}
              >
                NFC Tap (NDEF)
              </Text>
            </Pressable>
          </View>

          {/* Asset Mode Tabs */}
          <View style={styles.modeTabs}>
            <Pressable
              style={[
                styles.modeTab,
                mode === 'bip21' && styles.modeTabActive,
              ]}
              onPress={() => handleSelectMode('bip21')}
            >
              <Text
                style={[
                  styles.modeTabText,
                  mode === 'bip21' && styles.modeTabTextActive,
                ]}
              >
                BSV
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.modeTab,
                mode === 'bsv21' && styles.modeTabActive,
              ]}
              onPress={() => handleSelectMode('bsv21')}
            >
              <Text
                style={[
                  styles.modeTabText,
                  mode === 'bsv21' && styles.modeTabTextActive,
                ]}
              >
                BSV-21
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.modeTab,
                mode === '1sat' && styles.modeTabActive,
              ]}
              onPress={() => handleSelectMode('1sat')}
            >
              <Text
                style={[
                  styles.modeTabText,
                  mode === '1sat' && styles.modeTabTextActive,
                ]}
              >
                1Sat NFT
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.modeTab,
                mode === 'address' && styles.modeTabActive,
              ]}
              onPress={() => handleSelectMode('address')}
            >
              <Text
                style={[
                  styles.modeTabText,
                  mode === 'address' && styles.modeTabTextActive,
                ]}
              >
                Address
              </Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.qrSection}>
              <View style={styles.qrWrapper}>
                <QRCode
                  value={uriPayload}
                  size={190}
                  backgroundColor="#FFFFFF"
                  color="#0F172A"
                />
              </View>
              <Text style={styles.qrHint}>
                {mode === 'address'
                  ? 'Standard P2PKH Receiving Address'
                  : mode === 'bip21'
                    ? 'BIP-21 BSV Payment Request (?sv)'
                    : mode === 'bsv21'
                      ? 'BSV-21 Fungible Token Request (?sv&asset=bsv21)'
                      : '1Sat Ordinal NFT Transfer Request (?sv&asset=1sat)'}
              </Text>
            </View>

            {nfcWriteDoneBanner ? (
              <View style={styles.nfcSuccessBanner}>
                <Text style={styles.nfcSuccessText}>
                  Payment request broadcast via NFC NDEF record!
                </Text>
              </View>
            ) : null}

            {validationWarning ? (
              <View style={styles.warningBanner}>
                <Text style={styles.warningText}>{validationWarning}</Text>
              </View>
            ) : null}

            {mode === 'bip21' ? (
              <View style={styles.formSection}>
                <Text style={styles.inputLabel}>
                  Requested Amount (BSV, optional)
                </Text>
                <TextInput
                  style={styles.input}
                  value={bsvAmountInput}
                  onChangeText={setBsvAmountInput}
                  placeholder="e.g. 0.025"
                  placeholderTextColor="#64748B"
                  keyboardType="decimal-pad"
                />

                <Text style={styles.inputLabel}>Label / Note (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={labelInput}
                  onChangeText={setLabelInput}
                  placeholder="e.g. Coffee & Pastry"
                  placeholderTextColor="#64748B"
                />
              </View>
            ) : null}

            {mode === 'bsv21' ? (
              <View style={styles.formSection}>
                {tokens.length > 0 ? (
                  <View style={styles.tokenChipsWrap}>
                    <Text style={styles.inputLabel}>Quick-Select Token</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.tokenChipsRow}
                    >
                      {tokens.map((t) => {
                        const selected = tokenIdInput === t.tokenId;
                        return (
                          <Pressable
                            key={t.tokenId}
                            style={[
                              styles.tokenChip,
                              selected && styles.tokenChipActive,
                            ]}
                            onPress={() => handleSelectKnownToken(t)}
                          >
                            <Text
                              style={[
                                styles.tokenChipText,
                                selected && styles.tokenChipTextActive,
                              ]}
                            >
                              {t.symbol}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  </View>
                ) : null}

                <Text style={styles.inputLabel}>
                  BSV-21 Token ID (txid_vout)
                </Text>
                <TextInput
                  style={styles.input}
                  value={tokenIdInput}
                  onChangeText={setTokenIdInput}
                  placeholder="e.g. e3b0c442..._0"
                  placeholderTextColor="#64748B"
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                <View style={styles.twoColRow}>
                  <View style={styles.colHalf}>
                    <Text style={styles.inputLabel}>Token Amount</Text>
                    <TextInput
                      style={styles.input}
                      value={tokenAmountInput}
                      onChangeText={setTokenAmountInput}
                      placeholder="e.g. 100"
                      placeholderTextColor="#64748B"
                      keyboardType="numeric"
                    />
                  </View>
                  <View style={styles.colHalf}>
                    <Text style={styles.inputLabel}>Symbol (optional)</Text>
                    <TextInput
                      style={styles.input}
                      value={tokenSymbolInput}
                      onChangeText={setTokenSymbolInput}
                      placeholder="e.g. MNEE"
                      placeholderTextColor="#64748B"
                      autoCapitalize="characters"
                    />
                  </View>
                </View>
              </View>
            ) : null}

            {mode === '1sat' ? (
              <View style={styles.formSection}>
                <Text style={styles.inputLabel}>
                  1Sat Ordinal Outpoint (txid.vout)
                </Text>
                <TextInput
                  style={styles.input}
                  value={nftOutpointInput}
                  onChangeText={setNftOutpointInput}
                  placeholder="e.g. e3b0c442....0"
                  placeholderTextColor="#64748B"
                  autoCapitalize="none"
                  autoCorrect={false}
                />

                <Text style={styles.inputLabel}>
                  Collectible Name (optional)
                </Text>
                <TextInput
                  style={styles.input}
                  value={nftNameInput}
                  onChangeText={setNftNameInput}
                  placeholder="e.g. Genesis Ordinal"
                  placeholderTextColor="#64748B"
                />
              </View>
            ) : null}

            <View style={styles.uriBox}>
              <Text style={styles.uriBoxLabel}>Encoded NDEF / QR Payload</Text>
              <Text style={styles.uriBoxValue} selectable>
                {uriPayload}
              </Text>
            </View>

            <View style={styles.actionButtonsRow}>
              <Pressable
                style={styles.nfcShareBtn}
                onPress={handleOpenNfcShare}
              >
                <Text style={styles.nfcShareBtnText}>Share via NFC</Text>
              </Pressable>

              <Pressable style={styles.shareBtn} onPress={handleShareUri}>
                <Text style={styles.shareBtnText}>
                  {sharedFeedback ? 'Shared!' : 'Share / Copy URI'}
                </Text>
              </Pressable>
            </View>
          </ScrollView>

          <NfcModal
            visible={nfcModalVisible}
            mode="write"
            paymentUri={uriPayload}
            onClose={() => {
              setNfcModalVisible(false);
              setChannel('qr');
            }}
            onWriteComplete={() => {
              setNfcWriteDoneBanner(true);
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.82)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
    maxHeight: '92%',
    borderTopWidth: 1,
    borderColor: '#1E293B',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
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
  channelToggle: {
    flexDirection: 'row',
    backgroundColor: '#020617',
    borderRadius: 12,
    padding: 4,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  channelBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: 'center',
  },
  channelBtnActive: {
    backgroundColor: '#1E3A8A',
  },
  channelBtnActiveNfc: {
    backgroundColor: '#065F46',
  },
  channelBtnText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '700',
  },
  channelBtnTextActive: {
    color: '#FFFFFF',
  },
  modeTabs: {
    flexDirection: 'row',
    backgroundColor: '#020617',
    borderRadius: 12,
    padding: 4,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  modeTab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: 'center',
  },
  modeTabActive: {
    backgroundColor: '#2563EB',
  },
  modeTabText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '700',
  },
  modeTabTextActive: {
    color: '#FFFFFF',
  },
  scrollContent: {
    paddingBottom: 16,
  },
  qrSection: {
    alignItems: 'center',
    marginBottom: 14,
  },
  qrWrapper: {
    backgroundColor: '#FFFFFF',
    padding: 14,
    borderRadius: 20,
    borderWidth: 3,
    borderColor: '#3B82F6',
  },
  qrHint: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 8,
    fontWeight: '600',
  },
  nfcSuccessBanner: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
    alignItems: 'center',
  },
  nfcSuccessText: {
    color: '#6EE7B7',
    fontSize: 12,
    fontWeight: '700',
  },
  warningBanner: {
    backgroundColor: '#451A03',
    borderColor: '#D97706',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  warningText: {
    color: '#FDE68A',
    fontSize: 12,
  },
  formSection: {
    marginBottom: 14,
  },
  inputLabel: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#F8FAFC',
    fontSize: 14,
  },
  tokenChipsWrap: {
    marginBottom: 6,
  },
  tokenChipsRow: {
    gap: 8,
  },
  tokenChip: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  tokenChipActive: {
    backgroundColor: '#1E3A8A',
    borderColor: '#3B82F6',
  },
  tokenChipText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '700',
  },
  tokenChipTextActive: {
    color: '#93C5FD',
  },
  twoColRow: {
    flexDirection: 'row',
    gap: 10,
  },
  colHalf: {
    flex: 1,
  },
  uriBox: {
    backgroundColor: '#020617',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 14,
  },
  uriBoxLabel: {
    color: '#64748B',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  uriBoxValue: {
    color: '#93C5FD',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  nfcShareBtn: {
    flex: 1,
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  nfcShareBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  shareBtn: {
    flex: 1,
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  shareBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
});
