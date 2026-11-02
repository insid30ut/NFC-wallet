import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { SvgXml } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { BASKET_METADATA, BRC100_BASKETS } from '@/constants/baskets';
import { WalletColors } from '@/constants/theme';
import { networkConfigService, syncService } from '@/services/network';
import {
  brc100WalletEngine,
  type OneSatNftItem,
  transactionBuilder,
} from '@/services/wallet';

function InscriptionPreview({ item }: { item: OneSatNftItem }) {
  const mime = item.contentType.toLowerCase();
  const ordfsUrl = networkConfigService.getOrdfsContentUrl(item.origin);

  if (
    (mime === 'image/svg+xml' || mime === 'application/svg+xml') &&
    item.contentPreview &&
    item.contentPreview.includes('<svg')
  ) {
    return (
      <View style={styles.previewFrame}>
        <SvgXml xml={item.contentPreview} width="100%" height="100%" />
      </View>
    );
  }

  if (mime.startsWith('image/') || mime === 'application/svg+xml') {
    return (
      <View style={styles.previewFrame}>
        <Image
          source={{ uri: ordfsUrl }}
          style={styles.previewImage}
          contentFit="cover"
        />
      </View>
    );
  }

  if (mime === 'text/html') {
    return (
      <View style={[styles.previewFrame, styles.htmlPreviewFrame]}>
        <View style={styles.htmlHeaderBadge}>
          <Ionicons
            name="code-slash-outline"
            size={12}
            color={WalletColors.primary}
          />
          <Text style={styles.htmlHeaderText}>HTML INSCRIPTION</Text>
        </View>
        <Text numberOfLines={5} style={styles.codePreviewText}>
          {item.contentPreview ?? `<iframe src="${ordfsUrl}" />`}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.previewFrame, styles.textPreviewFrame]}>
      <Text numberOfLines={5} style={styles.codePreviewText}>
        {item.contentPreview ?? `1Sat Inscription (${item.contentType})`}
      </Text>
    </View>
  );
}

export default function CollectiblesScreen() {
  const oneSatBasket = BASKET_METADATA[BRC100_BASKETS.ONESAT];
  const [nfts, setNfts] = useState<OneSatNftItem[]>([]);
  const [syncing, setSyncing] = useState<boolean>(false);

  // Send NFT modal state
  const [selectedNft, setSelectedNft] = useState<OneSatNftItem | null>(null);
  const [recipientAddress, setRecipientAddress] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastSentTxid, setLastSentTxid] = useState<string | null>(null);

  const loadCollectibles = useCallback(async () => {
    try {
      const list = await brc100WalletEngine.get1SatNftCollectibles();
      setNfts(list);
    } catch {
      // Ignore if DB not initialized
    }
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await syncService.syncWallet();
      await loadCollectibles();
    } finally {
      setSyncing(false);
    }
  }, [loadCollectibles]);

  useEffect(() => {
    let mounted = true;
    brc100WalletEngine
      .get1SatNftCollectibles()
      .then((list) => {
        if (mounted) {
          setNfts(list);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const handleSendNft = useCallback(async () => {
    if (!selectedNft) {
      return;
    }
    setErrorMsg(null);
    setSending(true);
    try {
      const res = await transactionBuilder.send1SatNft(
        selectedNft.outpoint,
        recipientAddress.trim()
      );
      setLastSentTxid(res.txid);
      setSelectedNft(null);
      setRecipientAddress('');
      await loadCollectibles();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to transfer 1Sat NFT.'
      );
    } finally {
      setSending(false);
    }
  }, [loadCollectibles, recipientAddress, selectedNft]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      refreshControl={
        <RefreshControl
          refreshing={syncing}
          onRefresh={handleSync}
          tintColor={WalletColors.primary}
          colors={[WalletColors.primary]}
        />
      }>
      <View style={styles.headerCard}>
        <View style={styles.headerTopRow}>
          <Text style={styles.badge}>
            BRC-147 · &apos;{oneSatBasket.id}&apos; Basket
          </Text>
          <Pressable
            disabled={syncing}
            onPress={handleSync}
            style={({ pressed }) => [
              styles.syncPill,
              pressed && styles.buttonPressed,
            ]}>
            {syncing ? (
              <ActivityIndicator size="small" color={WalletColors.primary} />
            ) : (
              <Ionicons
                name="refresh-outline"
                size={14}
                color={WalletColors.primary}
              />
            )}
            <Text style={styles.syncPillText}>
              {syncing ? 'Syncing...' : 'Sync 1Sat'}
            </Text>
          </Pressable>
        </View>
        <Text style={styles.title}>1Sat Ordinals &amp; NFTs ({nfts.length})</Text>
        <Text style={styles.description}>{oneSatBasket.description}</Text>

        {lastSentTxid ? (
          <View style={styles.txSuccessBox}>
            <Text style={styles.txSuccessLabel}>
              Last 1Sat NFT Transfer TXID:
            </Text>
            <Text selectable numberOfLines={1} style={styles.txSuccessValue}>
              {lastSentTxid}
            </Text>
          </View>
        ) : null}
      </View>

      {nfts.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons
            name="diamond-outline"
            size={32}
            color={WalletColors.textMuted}
          />
          <Text style={styles.emptyTitle}>No 1Sat Inscriptions Indexed</Text>
          <Text style={styles.emptySubtext}>
            Pull down to sync image/*, SVG, HTML, and text inscriptions from
            GorillaPool into the isolated &apos;1sat&apos; basket.
          </Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {nfts.map((nft) => (
            <View key={nft.outpoint} style={styles.nftCard}>
              <InscriptionPreview item={nft} />

              <View style={styles.nftCardBody}>
                <View style={styles.mimeRow}>
                  <Text numberOfLines={1} style={styles.mimeBadge}>
                    {nft.contentType}
                  </Text>
                  <Text style={styles.satBadge}>1 sat</Text>
                </View>

                <Text numberOfLines={1} style={styles.nftName}>
                  {nft.name}
                </Text>
                <Text
                  selectable
                  numberOfLines={1}
                  ellipsizeMode="middle"
                  style={styles.nftOrigin}>
                  origin: {nft.origin}
                </Text>

                <Pressable
                  onPress={() => {
                    setErrorMsg(null);
                    setRecipientAddress('');
                    setSelectedNft(nft);
                  }}
                  style={({ pressed }) => [
                    styles.sendNftBtn,
                    pressed && styles.buttonPressed,
                  ]}>
                  <Ionicons
                    name="paper-plane-outline"
                    size={13}
                    color={WalletColors.background}
                  />
                  <Text style={styles.sendNftBtnText}>Send NFT</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Send 1Sat NFT Modal */}
      <Modal
        visible={selectedNft !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedNft(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                Send 1Sat NFT: {selectedNft?.name}
              </Text>
              <Pressable onPress={() => setSelectedNft(null)}>
                <Ionicons
                  name="close-circle-outline"
                  size={24}
                  color={WalletColors.textSecondary}
                />
              </Pressable>
            </View>

            <View style={styles.satpointNotice}>
              <Text style={styles.satpointNoticeTitle}>
                Ordinal Satpoint Alignment Guaranteed
              </Text>
              <Text style={styles.satpointNoticeText}>
                • Input #0: {selectedNft?.outpoint} (1 sat from &apos;1sat&apos; basket){'\n'}
                • Input #1: Fee funding UTXO from &apos;default&apos; basket{'\n'}
                • Output #0: 1 sat inscription to recipient address
              </Text>
            </View>

            {errorMsg ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Recipient BSV Address</Text>
              <TextInput
                value={recipientAddress}
                onChangeText={setRecipientAddress}
                placeholder="Enter recipient BSV P2PKH address"
                placeholderTextColor={WalletColors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.textInput}
              />
            </View>

            <Pressable
              disabled={sending}
              onPress={handleSendNft}
              style={({ pressed }) => [
                styles.confirmSendBtn,
                (pressed || sending) && styles.buttonPressed,
              ]}>
              <Text style={styles.confirmSendBtnText}>
                {sending
                  ? 'Signing & Broadcasting via ARC...'
                  : 'Transfer 1Sat NFT'}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WalletColors.background,
  },
  contentContainer: {
    padding: 16,
    gap: 16,
    paddingBottom: 36,
  },
  headerCard: {
    backgroundColor: WalletColors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: WalletColors.border,
    gap: 8,
  },
  headerTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    color: WalletColors.primary,
    backgroundColor: WalletColors.primaryMuted,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  syncPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: WalletColors.background,
    borderWidth: 1,
    borderColor: WalletColors.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  syncPillText: {
    color: WalletColors.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  title: {
    color: WalletColors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  description: {
    color: WalletColors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  txSuccessBox: {
    marginTop: 4,
    backgroundColor: WalletColors.background,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: WalletColors.border,
  },
  txSuccessLabel: {
    color: WalletColors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  txSuccessValue: {
    color: WalletColors.success,
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  emptyState: {
    backgroundColor: WalletColors.surface,
    borderRadius: 16,
    padding: 28,
    borderWidth: 1,
    borderColor: WalletColors.border,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: {
    color: WalletColors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  emptySubtext: {
    color: WalletColors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 12,
  },
  nftCard: {
    width: '48%',
    backgroundColor: WalletColors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: WalletColors.border,
    overflow: 'hidden',
  },
  previewFrame: {
    width: '100%',
    height: 140,
    backgroundColor: WalletColors.background,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  htmlPreviewFrame: {
    padding: 10,
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    gap: 6,
  },
  htmlHeaderBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: WalletColors.primaryMuted,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  htmlHeaderText: {
    color: WalletColors.primary,
    fontSize: 9,
    fontWeight: '800',
  },
  textPreviewFrame: {
    padding: 10,
  },
  codePreviewText: {
    color: WalletColors.textSecondary,
    fontSize: 10,
    fontFamily: 'monospace',
    lineHeight: 14,
  },
  nftCardBody: {
    padding: 12,
    gap: 6,
  },
  mimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  mimeBadge: {
    color: WalletColors.primary,
    fontSize: 10,
    fontFamily: 'monospace',
    maxWidth: '72%',
  },
  satBadge: {
    color: WalletColors.success,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  nftName: {
    color: WalletColors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  nftOrigin: {
    color: WalletColors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  sendNftBtn: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: WalletColors.primary,
    borderRadius: 8,
    paddingVertical: 8,
  },
  sendNftBtnText: {
    color: WalletColors.background,
    fontSize: 12,
    fontWeight: '700',
  },
  buttonPressed: {
    opacity: 0.85,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: WalletColors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    borderTopWidth: 1,
    borderColor: WalletColors.border,
    gap: 14,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalTitle: {
    color: WalletColors.textPrimary,
    fontSize: 17,
    fontWeight: '700',
    flex: 1,
  },
  satpointNotice: {
    backgroundColor: WalletColors.background,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: WalletColors.border,
    gap: 4,
  },
  satpointNoticeTitle: {
    color: WalletColors.success,
    fontSize: 12,
    fontWeight: '700',
  },
  satpointNoticeText: {
    color: WalletColors.textSecondary,
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 17,
  },
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: WalletColors.danger,
  },
  errorText: {
    color: WalletColors.danger,
    fontSize: 12,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    color: WalletColors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  textInput: {
    backgroundColor: WalletColors.background,
    borderWidth: 1,
    borderColor: WalletColors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: WalletColors.textPrimary,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  confirmSendBtn: {
    backgroundColor: WalletColors.primary,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  confirmSendBtnText: {
    color: WalletColors.background,
    fontSize: 14,
    fontWeight: '700',
  },
});
