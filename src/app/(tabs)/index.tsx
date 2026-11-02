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
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { WalletNetwork } from '@bsv/sdk';
import { CryptoDiagnosticCard } from '@/components/CryptoDiagnosticCard';
import { ReceiveModal } from '@/components/ReceiveModal';
import {
  BASKET_METADATA,
  type BasketName,
  BRC100_BASKETS,
  type BasketSummary,
} from '@/constants/baskets';
import { WalletColors } from '@/constants/theme';
import {
  networkConfigService,
  syncService,
} from '@/services/network';
import {
  brc100WalletEngine,
  type Bsv21TokenBalanceSummary,
  keyVaultService,
  transactionBuilder,
  type WalletKeyMetadata,
} from '@/services/wallet';

const BASKETS: BasketSummary[] = [
  BASKET_METADATA[BRC100_BASKETS.DEFAULT],
  BASKET_METADATA[BRC100_BASKETS.BSV21],
  BASKET_METADATA[BRC100_BASKETS.ONESAT],
];

export default function HomeScreen() {
  const [unlockedMeta, setUnlockedMeta] = useState<WalletKeyMetadata | null>(
    () => keyVaultService.getUnlockedMetadata()
  );
  const [network, setNetwork] = useState<WalletNetwork>(() =>
    networkConfigService.getNetwork()
  );
  const [feeRateSatsPerKb, setFeeRateSatsPerKb] = useState<number>(50);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [syncBanner, setSyncBanner] = useState<string | null>(null);

  const [basketStats, setBasketStats] = useState<
    Record<BasketName, { utxoCount: number; totalSatoshis: number }>
  >({
    [BRC100_BASKETS.DEFAULT]: { utxoCount: 0, totalSatoshis: 0 },
    [BRC100_BASKETS.BSV21]: { utxoCount: 0, totalSatoshis: 0 },
    [BRC100_BASKETS.ONESAT]: { utxoCount: 0, totalSatoshis: 0 },
  });
  const [tokenBalances, setTokenBalances] = useState<
    Bsv21TokenBalanceSummary[]
  >([]);

  // Send BSV / Send BSV-21 Modal state
  const [sendModalMode, setSendModalMode] = useState<'bsv' | 'bsv21' | null>(
    null
  );
  const [selectedToken, setSelectedToken] =
    useState<Bsv21TokenBalanceSummary | null>(null);
  const [recipientInput, setRecipientInput] = useState<string>('');
  const [amountInput, setAmountInput] = useState<string>('');
  const [sendingTx, setSendingTx] = useState<boolean>(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastTxid, setLastTxid] = useState<string | null>(null);
  const [receiveModalVisible, setReceiveModalVisible] =
    useState<boolean>(false);

  const loadLocalState = useCallback(async () => {
    setUnlockedMeta(keyVaultService.getUnlockedMetadata());
    try {
      const [summaries, tokens, quote] = await Promise.all([
        brc100WalletEngine.getBasketSummaries(),
        brc100WalletEngine.getBsv21TokenBalances(),
        networkConfigService.fetchArcFeeQuote(),
      ]);
      setBasketStats(summaries);
      setTokenBalances(tokens);
      setFeeRateSatsPerKb(quote.satoshisPerKilobyte);
    } catch {
      // Ignore if SQLite not yet ready
    }
  }, []);

  const handlePullToRefresh = useCallback(async () => {
    setSyncing(true);
    setSyncBanner(null);
    try {
      const result = await syncService.syncWallet();
      await loadLocalState();
      setLastSyncedAt(result.syncedAt);
      if (result.totalInternalized > 0) {
        setSyncBanner(
          `Internalized ${result.totalInternalized} new UTXO(s): ${result.newDefaultCount} BSV, ${result.newBsv21Count} BSV-21, ${result.new1SatCount} 1Sat`
        );
      }
    } catch (err) {
      setSyncBanner(
        err instanceof Error ? err.message : 'Network sync encountered an error'
      );
    } finally {
      setSyncing(false);
    }
  }, [loadLocalState]);

  useEffect(() => {
    void Promise.resolve().then(() => loadLocalState());
    const unsubVault = keyVaultService.subscribe(() => {
      void loadLocalState();
    });
    const unsubNet = networkConfigService.subscribe((nextNet) => {
      setNetwork(nextNet);
      void loadLocalState();
    });
    return () => {
      unsubVault();
      unsubNet();
    };
  }, [loadLocalState]);

  const handleToggleNetwork = useCallback(() => {
    const next: WalletNetwork = network === 'mainnet' ? 'testnet' : 'mainnet';
    networkConfigService.setNetwork(next);
  }, [network]);

  const handleExecuteSend = useCallback(async () => {
    setSendError(null);
    setSendingTx(true);
    try {
      if (sendModalMode === 'bsv') {
        const sats = Number(amountInput.trim());
        const res = await transactionBuilder.sendBsv(recipientInput.trim(), sats);
        setLastTxid(res.txid);
        setSendModalMode(null);
        setRecipientInput('');
        setAmountInput('');
        await loadLocalState();
      } else if (sendModalMode === 'bsv21' && selectedToken) {
        const rawAmt = BigInt(amountInput.trim());
        const res = await transactionBuilder.sendBsv21Token(
          selectedToken.tokenId,
          recipientInput.trim(),
          rawAmt
        );
        setLastTxid(res.txid);
        setSendModalMode(null);
        setSelectedToken(null);
        setRecipientInput('');
        setAmountInput('');
        await loadLocalState();
      }
    } catch (err) {
      setSendError(
        err instanceof Error ? err.message : 'Transaction broadcast failed.'
      );
    } finally {
      setSendingTx(false);
    }
  }, [
    amountInput,
    loadLocalState,
    recipientInput,
    selectedToken,
    sendModalMode,
  ]);

  const defaultSatoshis = basketStats[BRC100_BASKETS.DEFAULT].totalSatoshis;
  const bsvFormatted = (defaultSatoshis / 100_000_000).toFixed(8);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      refreshControl={
        <RefreshControl
          refreshing={syncing}
          onRefresh={handlePullToRefresh}
          tintColor={WalletColors.primary}
          colors={[WalletColors.primary]}
        />
      }>
      {/* Real-Time BSV Balance & Network Card */}
      <View style={styles.balanceHeroCard}>
        <View style={styles.heroTopRow}>
          <Pressable
            onPress={handleToggleNetwork}
            style={({ pressed }) => [
              styles.networkPill,
              pressed && styles.buttonPressed,
            ]}>
            <View
              style={[
                styles.networkDot,
                network === 'mainnet' ? styles.dotMainnet : styles.dotTestnet,
              ]}
            />
            <Text style={styles.networkPillText}>
              {network === 'mainnet' ? 'BSV Mainnet' : 'BSV Testnet'}
            </Text>
            <Ionicons
              name="swap-horizontal-outline"
              size={13}
              color={WalletColors.textSecondary}
            />
          </Pressable>

          <Pressable
            disabled={syncing}
            onPress={handlePullToRefresh}
            style={({ pressed }) => [
              styles.syncButton,
              pressed && styles.buttonPressed,
            ]}>
            {syncing ? (
              <ActivityIndicator size="small" color={WalletColors.primary} />
            ) : (
              <Ionicons
                name="refresh-outline"
                size={15}
                color={WalletColors.primary}
              />
            )}
            <Text style={styles.syncButtonText}>
              {syncing ? 'Syncing...' : 'Sync UTXOs'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.balanceCenter}>
          <Text style={styles.balanceCaption}>
            SPENDABLE BSV (&apos;default&apos; BASKET)
          </Text>
          <Text style={styles.balanceBsvText}>{bsvFormatted} BSV</Text>
          <Text style={styles.balanceSatsText}>
            {defaultSatoshis.toLocaleString()} satoshis · ARC Fee:{' '}
            {feeRateSatsPerKb} sats/KB
          </Text>
          {lastSyncedAt ? (
            <Text style={styles.syncedTimestamp}>
              Last synced {new Date(lastSyncedAt).toLocaleTimeString()}
            </Text>
          ) : null}
        </View>

        {syncBanner ? (
          <View style={styles.syncBannerBox}>
            <Text style={styles.syncBannerText}>{syncBanner}</Text>
          </View>
        ) : null}

        {lastTxid ? (
          <View style={styles.txBannerBox}>
            <Text style={styles.txBannerLabel}>Last Broadcast TXID (ARC):</Text>
            <Text selectable numberOfLines={1} style={styles.txBannerValue}>
              {lastTxid}
            </Text>
          </View>
        ) : null}

        {unlockedMeta ? (
          <View style={styles.heroActionsRow}>
            <Pressable
              onPress={() => {
                setSendError(null);
                setRecipientInput('');
                setAmountInput('');
                setSendModalMode('bsv');
              }}
              style={({ pressed }) => [
                styles.primaryActionBtn,
                pressed && styles.buttonPressed,
              ]}>
              <Ionicons
                name="paper-plane-outline"
                size={16}
                color={WalletColors.background}
              />
              <Text style={styles.primaryActionBtnText}>Send BSV</Text>
            </Pressable>

            <Pressable
              onPress={() => setReceiveModalVisible(true)}
              style={({ pressed }) => [
                styles.addressCompactBox,
                pressed && styles.buttonPressed,
              ]}>
              <Text style={styles.addressCompactLabel}>
                Receive QR · Tap to Open
              </Text>
              <Text
                selectable
                numberOfLines={1}
                ellipsizeMode="middle"
                style={styles.addressCompactValue}>
                {unlockedMeta.address}
              </Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => router.push('/onboarding')}
            style={({ pressed }) => [
              styles.onboardingButton,
              pressed && styles.buttonPressed,
            ]}>
            <Ionicons
              name="key-outline"
              size={16}
              color={WalletColors.background}
            />
            <Text style={styles.onboardingButtonText}>
              Create, Import, or Unlock Wallet
            </Text>
          </Pressable>
        )}
      </View>

      {/* BSV-21 Fungible Token Balances Section */}
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionTitle}>BSV-21 Token Balances</Text>
          <Text style={styles.sectionBadge}>BRC-163 · &apos;bsv21&apos;</Text>
        </View>
        <Text style={styles.sectionSubtitle}>
          1-satoshi carrier outputs isolated from standard BSV fee selection
        </Text>
      </View>

      {tokenBalances.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons
            name="layers-outline"
            size={24}
            color={WalletColors.textMuted}
          />
          <Text style={styles.emptyCardTitle}>No BSV-21 Tokens Indexed</Text>
          <Text style={styles.emptyCardSubtitle}>
            Pull down to sync incoming application/bsv-20 inscriptions from
            GorillaPool 1Sat Indexer into the isolated &apos;bsv21&apos; basket.
          </Text>
        </View>
      ) : (
        tokenBalances.map((token) => (
          <View key={token.tokenId} style={styles.tokenCard}>
            <View style={styles.tokenTopRow}>
              <View style={styles.tokenIdentity}>
                <View style={styles.tokenSymbolAvatar}>
                  <Text style={styles.tokenSymbolAvatarText}>
                    {token.symbol.slice(0, 3).toUpperCase()}
                  </Text>
                </View>
                <View>
                  <Text style={styles.tokenSymbolText}>{token.symbol}</Text>
                  <Text
                    selectable
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={styles.tokenIdText}>
                    ID: {token.tokenId}
                  </Text>
                </View>
              </View>

              <View style={styles.tokenAmountGroup}>
                <Text style={styles.tokenFormattedAmount}>
                  {token.formattedAmount}
                </Text>
                <Text style={styles.tokenUtxoMeta}>
                  {token.utxoCount} carrier UTXO(s) · dec {token.decimals}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={() => {
                setSendError(null);
                setSelectedToken(token);
                setRecipientInput('');
                setAmountInput('');
                setSendModalMode('bsv21');
              }}
              style={({ pressed }) => [
                styles.sendTokenButton,
                pressed && styles.buttonPressed,
              ]}>
              <Ionicons
                name="send-outline"
                size={14}
                color={WalletColors.primary}
              />
              <Text style={styles.sendTokenButtonText}>
                Transfer {token.symbol}
              </Text>
            </Pressable>
          </View>
        ))
      )}

      {/* BRC-100 UTXO Baskets Summary */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>BRC-100 UTXO Baskets (SQLite)</Text>
        <Text style={styles.sectionSubtitle}>
          Strict basket isolation enforced in SQLite schema &amp; coin selection
        </Text>
      </View>

      {BASKETS.map((basket) => {
        const stats = basketStats[basket.id];
        return (
          <View key={basket.id} style={styles.basketCard}>
            <View style={styles.basketTopRow}>
              <View>
                <Text style={styles.basketTitle}>{basket.label}</Text>
                <Text style={styles.basketStandard}>
                  Basket: &apos;{basket.id}&apos; · {basket.standard}
                </Text>
              </View>
              <View
                style={[
                  styles.isolationBadge,
                  basket.spendableForFees
                    ? styles.feeSpendableBadge
                    : styles.isolatedBadge,
                ]}>
                <Text
                  style={[
                    styles.isolationBadgeText,
                    basket.spendableForFees
                      ? styles.feeSpendableText
                      : styles.isolatedText,
                  ]}>
                  {basket.spendableForFees ? 'FEE SOURCE' : 'ISOLATED CARRIER'}
                </Text>
              </View>
            </View>
            <Text style={styles.basketDescription}>{basket.description}</Text>
            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>Tracked Outputs</Text>
              <Text style={styles.balanceValue}>
                {stats.utxoCount} UTXOs ({stats.totalSatoshis} sats)
              </Text>
            </View>
          </View>
        );
      })}

      <CryptoDiagnosticCard />

      {/* Send BSV / Send BSV-21 Modal */}
      <Modal
        visible={sendModalMode !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSendModalMode(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {sendModalMode === 'bsv'
                  ? 'Send Standard BSV'
                  : `Send ${selectedToken?.symbol ?? 'BSV-21'} Token`}
              </Text>
              <Pressable onPress={() => setSendModalMode(null)}>
                <Ionicons
                  name="close-circle-outline"
                  size={24}
                  color={WalletColors.textSecondary}
                />
              </Pressable>
            </View>

            <Text style={styles.modalSubtitle}>
              {sendModalMode === 'bsv'
                ? "Funds & network fees are selected strictly from the 'default' basket and broadcast via ARC."
                : `Selects '${selectedToken?.symbol}' UTXOs from 'bsv21' while funding BSV network fees strictly from the 'default' basket.`}
            </Text>

            {sendError ? (
              <View style={styles.modalErrorBox}>
                <Text style={styles.modalErrorText}>{sendError}</Text>
              </View>
            ) : null}

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Recipient BSV Address</Text>
              <TextInput
                value={recipientInput}
                onChangeText={setRecipientInput}
                placeholder="1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
                placeholderTextColor={WalletColors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.textInput}
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>
                {sendModalMode === 'bsv'
                  ? 'Amount (in Satoshis)'
                  : `Raw Token Units (Available: ${selectedToken?.rawAmount ?? '0'})`}
              </Text>
              <TextInput
                value={amountInput}
                onChangeText={setAmountInput}
                placeholder="1000"
                placeholderTextColor={WalletColors.textMuted}
                keyboardType="numeric"
                style={styles.textInput}
              />
            </View>

            <Pressable
              disabled={sendingTx}
              onPress={handleExecuteSend}
              style={({ pressed }) => [
                styles.onboardingButton,
                (pressed || sendingTx) && styles.buttonPressed,
              ]}>
              <Text style={styles.onboardingButtonText}>
                {sendingTx ? 'Signing & Broadcasting via ARC...' : 'Sign & Broadcast'}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <ReceiveModal
        visible={receiveModalVisible}
        address={unlockedMeta?.address ?? ''}
        tokens={tokenBalances}
        onClose={() => setReceiveModalVisible(false)}
      />
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
  balanceHeroCard: {
    backgroundColor: WalletColors.surface,
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: WalletColors.border,
    gap: 14,
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  networkPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: WalletColors.background,
    borderWidth: 1,
    borderColor: WalletColors.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  networkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotMainnet: {
    backgroundColor: WalletColors.success,
  },
  dotTestnet: {
    backgroundColor: WalletColors.primary,
  },
  networkPillText: {
    color: WalletColors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  syncButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: WalletColors.primaryMuted,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  syncButtonText: {
    color: WalletColors.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  balanceCenter: {
    alignItems: 'center',
    paddingVertical: 6,
    gap: 4,
  },
  balanceCaption: {
    color: WalletColors.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  balanceBsvText: {
    color: WalletColors.textPrimary,
    fontSize: 28,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  balanceSatsText: {
    color: WalletColors.primary,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  syncedTimestamp: {
    color: WalletColors.textMuted,
    fontSize: 11,
  },
  syncBannerBox: {
    backgroundColor: WalletColors.successMuted,
    borderRadius: 10,
    padding: 10,
  },
  syncBannerText: {
    color: WalletColors.success,
    fontSize: 12,
    textAlign: 'center',
  },
  txBannerBox: {
    backgroundColor: WalletColors.background,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: WalletColors.border,
  },
  txBannerLabel: {
    color: WalletColors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  txBannerValue: {
    color: WalletColors.success,
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  heroActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  primaryActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: WalletColors.primary,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  primaryActionBtnText: {
    color: WalletColors.background,
    fontSize: 13,
    fontWeight: '800',
  },
  addressCompactBox: {
    flex: 1,
    backgroundColor: WalletColors.background,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: WalletColors.border,
  },
  addressCompactLabel: {
    color: WalletColors.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  addressCompactValue: {
    color: WalletColors.textPrimary,
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 1,
  },
  onboardingButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: WalletColors.primary,
    borderRadius: 12,
    paddingVertical: 13,
  },
  onboardingButtonText: {
    color: WalletColors.background,
    fontSize: 13,
    fontWeight: '700',
  },
  buttonPressed: {
    opacity: 0.85,
  },
  sectionHeader: {
    marginTop: 4,
    gap: 2,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    color: WalletColors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  sectionBadge: {
    color: WalletColors.primary,
    backgroundColor: WalletColors.primaryMuted,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  sectionSubtitle: {
    color: WalletColors.textSecondary,
    fontSize: 12,
  },
  emptyCard: {
    backgroundColor: WalletColors.surface,
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: WalletColors.border,
    alignItems: 'center',
    gap: 6,
  },
  emptyCardTitle: {
    color: WalletColors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  emptyCardSubtitle: {
    color: WalletColors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  tokenCard: {
    backgroundColor: WalletColors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: WalletColors.border,
    gap: 12,
  },
  tokenTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  tokenIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  tokenSymbolAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: WalletColors.primaryMuted,
    borderWidth: 1,
    borderColor: WalletColors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tokenSymbolAvatarText: {
    color: WalletColors.primary,
    fontSize: 12,
    fontWeight: '800',
  },
  tokenSymbolText: {
    color: WalletColors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  tokenIdText: {
    color: WalletColors.textMuted,
    fontSize: 11,
    fontFamily: 'monospace',
    maxWidth: 160,
  },
  tokenAmountGroup: {
    alignItems: 'flex-end',
  },
  tokenFormattedAmount: {
    color: WalletColors.success,
    fontSize: 16,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  tokenUtxoMeta: {
    color: WalletColors.textMuted,
    fontSize: 10,
  },
  sendTokenButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: WalletColors.background,
    borderWidth: 1,
    borderColor: WalletColors.border,
    borderRadius: 10,
    paddingVertical: 9,
  },
  sendTokenButtonText: {
    color: WalletColors.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  basketCard: {
    backgroundColor: WalletColors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: WalletColors.border,
    gap: 10,
  },
  basketTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  basketTitle: {
    color: WalletColors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  basketStandard: {
    color: WalletColors.primary,
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  isolationBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  feeSpendableBadge: {
    backgroundColor: WalletColors.primaryMuted,
  },
  isolatedBadge: {
    backgroundColor: WalletColors.successMuted,
  },
  isolationBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  feeSpendableText: {
    color: WalletColors.primary,
  },
  isolatedText: {
    color: WalletColors.success,
  },
  basketDescription: {
    color: WalletColors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: WalletColors.border,
  },
  balanceLabel: {
    color: WalletColors.textMuted,
    fontSize: 12,
  },
  balanceValue: {
    color: WalletColors.textPrimary,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'monospace',
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
    fontSize: 18,
    fontWeight: '700',
  },
  modalSubtitle: {
    color: WalletColors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  modalErrorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: WalletColors.danger,
  },
  modalErrorText: {
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
});
