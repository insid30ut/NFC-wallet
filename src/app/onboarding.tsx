import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { WalletColors } from '@/constants/theme';
import {
  brc100WalletEngine,
  type InitializedWalletResult,
  keyVaultService,
  type WalletKeyMetadata,
} from '@/services/wallet';

type OnboardingStep = 'welcome' | 'unlock' | 'backup' | 'import';

export default function OnboardingScreen() {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Stored wallet metadata (when a wallet already exists on device)
  const [storedMetadata, setStoredMetadata] =
    useState<WalletKeyMetadata | null>(null);

  // Newly created wallet state (held only during backup confirmation)
  const [createdWallet, setCreatedWallet] =
    useState<InitializedWalletResult | null>(null);
  const [backupAcknowledged, setBackupAcknowledged] = useState<boolean>(false);
  const [challengeWordIndex, setChallengeWordIndex] = useState<number>(2);
  const [challengeInput, setChallengeInput] = useState<string>('');

  // Import wallet state
  const [importPhrase, setImportPhrase] = useState<string>('');

  useEffect(() => {
    let mounted = true;

    async function inspectVault() {
      try {
        const hasWallet = await keyVaultService.hasStoredWallet();
        const metadata = await keyVaultService.getStoredPublicMetadata();
        if (mounted) {
          setStoredMetadata(metadata);
          if (hasWallet && metadata) {
            setStep('unlock');
          } else {
            setStep('welcome');
          }
        }
      } catch {
        if (mounted) {
          setStep('welcome');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    void inspectVault();

    return () => {
      mounted = false;
    };
  }, []);

  const createdWords = useMemo(() => {
    if (!createdWallet?.mnemonic) {
      return [];
    }
    return createdWallet.mnemonic.split(' ');
  }, [createdWallet]);

  const expectedChallengeWord = useMemo(() => {
    return createdWords[challengeWordIndex] ?? '';
  }, [createdWords, challengeWordIndex]);

  const isBackupConfirmed = useMemo(() => {
    if (!backupAcknowledged || !expectedChallengeWord) {
      return false;
    }
    return (
      challengeInput.trim().toLowerCase() ===
      expectedChallengeWord.trim().toLowerCase()
    );
  }, [backupAcknowledged, challengeInput, expectedChallengeWord]);

  const importWordsCount = useMemo(() => {
    const normalized = keyVaultService.normalizeMnemonic(importPhrase);
    return normalized ? normalized.split(' ').length : 0;
  }, [importPhrase]);

  const isImportPhraseValid = useMemo(() => {
    return keyVaultService.validateMnemonic(importPhrase);
  }, [importPhrase]);

  const handleCreateNewWallet = useCallback(async () => {
    setErrorMessage(null);
    setSubmitting(true);
    try {
      const result = await keyVaultService.initializeNewWallet();
      await brc100WalletEngine.getDatabase();

      // Pick a deterministic-random word index (0..11) for backup verification
      const randomIdx = Math.floor(Math.random() * 12);
      setChallengeWordIndex(randomIdx);
      setChallengeInput('');
      setBackupAcknowledged(false);
      setCreatedWallet(result);
      setStep('backup');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to initialize new wallet.'
      );
    } finally {
      setSubmitting(false);
    }
  }, []);

  const handleCompleteBackupAndContinue = useCallback(async () => {
    if (!isBackupConfirmed) {
      setErrorMessage(
        `Please enter word #${challengeWordIndex + 1} accurately and confirm you backed up your seed phrase.`
      );
      return;
    }
    setErrorMessage(null);
    // Wipe temporary mnemonic from UI state before navigating
    setCreatedWallet(null);
    setChallengeInput('');
    router.replace('/(tabs)');
  }, [challengeWordIndex, isBackupConfirmed]);

  const handleImportWallet = useCallback(async () => {
    setErrorMessage(null);
    if (!isImportPhraseValid) {
      setErrorMessage(
        'Please enter a valid 12-word BIP-39 recovery phrase (checksum and wordlist verified).'
      );
      return;
    }

    setSubmitting(true);
    try {
      await keyVaultService.importWallet(importPhrase);
      await brc100WalletEngine.getDatabase();
      // Clear phrase from component memory before navigating
      setImportPhrase('');
      router.replace('/(tabs)');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to import recovery phrase.'
      );
    } finally {
      setSubmitting(false);
    }
  }, [importPhrase, isImportPhraseValid]);

  const handleUnlockWallet = useCallback(async () => {
    setErrorMessage(null);
    setSubmitting(true);
    try {
      await keyVaultService.unlockWallet();
      await brc100WalletEngine.getDatabase();
      router.replace('/(tabs)');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to unlock hardware vault.'
      );
    } finally {
      setSubmitting(false);
    }
  }, []);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={WalletColors.primary} />
        <Text style={styles.loadingText}>Checking Hardware Key Vault...</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled">
        <View style={styles.heroHeader}>
          <View style={styles.iconCircle}>
            <Ionicons
              name="shield-half-outline"
              size={32}
              color={WalletColors.primary}
            />
          </View>
          <Text style={styles.appTitle}>BRC-100 NFC BSV Wallet</Text>
          <Text style={styles.appSubtitle}>
            Hardware-backed BIP-39 key vault &amp; isolated UTXO baskets
          </Text>
        </View>

        {errorMessage ? (
          <View style={styles.errorBanner}>
            <Ionicons
              name="alert-circle-outline"
              size={18}
              color={WalletColors.danger}
            />
            <Text style={styles.errorBannerText}>{errorMessage}</Text>
          </View>
        ) : null}

        {step === 'unlock' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Unlock Hardware Key Vault</Text>
            <Text style={styles.cardDescription}>
              Your 12-word BIP-39 seed is encrypted in hardware storage
              (Keychain / Keystore). Authenticate with biometrics to derive your
              root BRC-100 keys in memory.
            </Text>

            {storedMetadata ? (
              <View style={styles.metaBox}>
                <Text style={styles.metaLabel}>BSV Address</Text>
                <Text selectable style={styles.metaValue}>
                  {storedMetadata.address}
                </Text>
                <Text style={[styles.metaLabel, styles.metaLabelSpaced]}>
                  Identity Public Key
                </Text>
                <Text
                  selectable
                  numberOfLines={1}
                  ellipsizeMode="middle"
                  style={styles.metaValue}>
                  {storedMetadata.identityPublicKey}
                </Text>
              </View>
            ) : null}

            <Pressable
              disabled={submitting}
              onPress={handleUnlockWallet}
              style={({ pressed }) => [
                styles.primaryButton,
                (pressed || submitting) && styles.buttonPressed,
              ]}>
              <Ionicons
                name="finger-print-outline"
                size={18}
                color={WalletColors.background}
              />
              <Text style={styles.primaryButtonText}>
                {submitting
                  ? 'Authenticating...'
                  : 'Unlock with Biometrics'}
              </Text>
            </Pressable>

            <View style={styles.dividerRow}>
              <Pressable
                onPress={() => {
                  setErrorMessage(null);
                  setStep('welcome');
                }}>
                <Text style={styles.linkText}>
                  Create or Import a Different Wallet
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {step === 'welcome' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Set Up Your BSV Wallet</Text>
            <Text style={styles.cardDescription}>
              Generate a new 12-word BIP-39 recovery phrase using @bsv/sdk
              cryptographic primitives or import an existing 12-word phrase into
              hardware-backed storage.
            </Text>

            <Pressable
              disabled={submitting}
              onPress={handleCreateNewWallet}
              style={({ pressed }) => [
                styles.primaryButton,
                (pressed || submitting) && styles.buttonPressed,
              ]}>
              <Ionicons
                name="add-circle-outline"
                size={18}
                color={WalletColors.background}
              />
              <Text style={styles.primaryButtonText}>
                {submitting
                  ? 'Generating 12-Word Seed...'
                  : 'Create New 12-Word Wallet'}
              </Text>
            </Pressable>

            <Pressable
              disabled={submitting}
              onPress={() => {
                setErrorMessage(null);
                setStep('import');
              }}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.buttonPressed,
              ]}>
              <Ionicons
                name="download-outline"
                size={18}
                color={WalletColors.textPrimary}
              />
              <Text style={styles.secondaryButtonText}>
                Import Existing 12-Word Phrase
              </Text>
            </Pressable>

            {storedMetadata ? (
              <Pressable
                onPress={() => {
                  setErrorMessage(null);
                  setStep('unlock');
                }}
                style={styles.centerLink}>
                <Text style={styles.linkText}>
                  Back to Unlock Existing Wallet
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}

        {step === 'backup' && createdWallet && (
          <View style={styles.card}>
            <View style={styles.badgeRow}>
              <Text style={styles.stepBadge}>BACKUP CONFIRMATION REQUIRED</Text>
            </View>
            <Text style={styles.cardTitle}>
              Write Down Your 12-Word Recovery Phrase
            </Text>
            <Text style={styles.cardDescription}>
              Write these 12 words in order and store them in a safe offline
              location. They will never be shown again or logged.
            </Text>

            <View style={styles.wordsGrid}>
              {createdWords.map((word, idx) => (
                <View key={`${idx + 1}-${word}`} style={styles.wordChip}>
                  <Text style={styles.wordIndex}>{idx + 1}.</Text>
                  <Text selectable style={styles.wordText}>
                    {word}
                  </Text>
                </View>
              ))}
            </View>

            <View style={styles.metaBox}>
              <Text style={styles.metaLabel}>Derived BSV Address</Text>
              <Text selectable style={styles.metaValue}>
                {createdWallet.address}
              </Text>
              <Text style={[styles.metaLabel, styles.metaLabelSpaced]}>
                Root Identity Public Key ({createdWallet.derivationPath})
              </Text>
              <Text selectable style={styles.metaValue}>
                {createdWallet.identityPublicKey}
              </Text>
            </View>

            <View style={styles.challengeBox}>
              <Text style={styles.challengeLabel}>
                Verify Backup: Type Word #{challengeWordIndex + 1}
              </Text>
              <TextInput
                value={challengeInput}
                onChangeText={setChallengeInput}
                placeholder={`Enter word #${challengeWordIndex + 1}`}
                placeholderTextColor={WalletColors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.textInput}
              />
            </View>

            <Pressable
              onPress={() => setBackupAcknowledged((prev) => !prev)}
              style={styles.checkboxRow}>
              <Ionicons
                name={
                  backupAcknowledged ? 'checkbox' : 'square-outline'
                }
                size={22}
                color={
                  backupAcknowledged
                    ? WalletColors.primary
                    : WalletColors.textSecondary
                }
              />
              <Text style={styles.checkboxLabel}>
                I have written down all 12 words offline and understand that
                losing them means losing access to my funds.
              </Text>
            </Pressable>

            <Pressable
              disabled={!isBackupConfirmed}
              onPress={handleCompleteBackupAndContinue}
              style={({ pressed }) => [
                styles.primaryButton,
                !isBackupConfirmed && styles.buttonDisabled,
                pressed && isBackupConfirmed && styles.buttonPressed,
              ]}>
              <Text style={styles.primaryButtonText}>
                Confirm Backup &amp; Open Wallet Dashboard
              </Text>
            </Pressable>
          </View>
        )}

        {step === 'import' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Import 12-Word Recovery Phrase</Text>
            <Text style={styles.cardDescription}>
              Enter your 12-word BIP-39 mnemonic phrase separated by spaces. It
              will be validated with @bsv/sdk Mnemonic and stored in
              expo-secure-store.
            </Text>

            <TextInput
              value={importPhrase}
              onChangeText={(text) => {
                setErrorMessage(null);
                setImportPhrase(text);
              }}
              placeholder="word1 word2 word3 ... word12"
              placeholderTextColor={WalletColors.textMuted}
              multiline
              numberOfLines={4}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.textInput, styles.multilineInput]}
            />

            <View style={styles.validationRow}>
              <Text style={styles.validationCount}>
                Words: {importWordsCount} / 12
              </Text>
              <Text
                style={[
                  styles.validationStatus,
                  isImportPhraseValid
                    ? styles.validationValid
                    : styles.validationPending,
                ]}>
                {isImportPhraseValid
                  ? '✓ Valid BIP-39 Checksum'
                  : 'Enter 12 valid BIP-39 words'}
              </Text>
            </View>

            <Pressable
              disabled={!isImportPhraseValid || submitting}
              onPress={handleImportWallet}
              style={({ pressed }) => [
                styles.primaryButton,
                (!isImportPhraseValid || submitting) && styles.buttonDisabled,
                pressed && isImportPhraseValid && styles.buttonPressed,
              ]}>
              <Text style={styles.primaryButtonText}>
                {submitting
                  ? 'Importing & Securing Keys...'
                  : 'Import Wallet & Continue'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => {
                setErrorMessage(null);
                setImportPhrase('');
                setStep(storedMetadata ? 'unlock' : 'welcome');
              }}
              style={styles.centerLink}>
              <Text style={styles.linkText}>Cancel</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WalletColors.background,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: WalletColors.background,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    color: WalletColors.textSecondary,
    fontSize: 14,
  },
  scrollContent: {
    padding: 20,
    paddingTop: 56,
    paddingBottom: 40,
    gap: 18,
  },
  heroHeader: {
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: WalletColors.primaryMuted,
    borderWidth: 1,
    borderColor: WalletColors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  appTitle: {
    color: WalletColors.textPrimary,
    fontSize: 22,
    fontWeight: '800',
  },
  appSubtitle: {
    color: WalletColors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
    borderWidth: 1,
    borderColor: WalletColors.danger,
    borderRadius: 12,
    padding: 12,
  },
  errorBannerText: {
    flex: 1,
    color: WalletColors.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  card: {
    backgroundColor: WalletColors.surface,
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: WalletColors.border,
    gap: 14,
  },
  badgeRow: {
    flexDirection: 'row',
  },
  stepBadge: {
    color: WalletColors.primary,
    backgroundColor: WalletColors.primaryMuted,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  cardTitle: {
    color: WalletColors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  cardDescription: {
    color: WalletColors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  metaBox: {
    backgroundColor: WalletColors.background,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: WalletColors.border,
  },
  metaLabel: {
    color: WalletColors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  metaLabelSpaced: {
    marginTop: 10,
  },
  metaValue: {
    color: WalletColors.primary,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  wordsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  wordChip: {
    width: '31%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: WalletColors.background,
    borderWidth: 1,
    borderColor: WalletColors.border,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  wordIndex: {
    color: WalletColors.textMuted,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  wordText: {
    color: WalletColors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  challengeBox: {
    gap: 6,
  },
  challengeLabel: {
    color: WalletColors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  textInput: {
    backgroundColor: WalletColors.background,
    borderWidth: 1,
    borderColor: WalletColors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: WalletColors.textPrimary,
    fontSize: 14,
    fontFamily: 'monospace',
  },
  multilineInput: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 4,
  },
  checkboxLabel: {
    flex: 1,
    color: WalletColors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  validationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  validationCount: {
    color: WalletColors.textSecondary,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  validationStatus: {
    fontSize: 12,
    fontWeight: '600',
  },
  validationValid: {
    color: WalletColors.success,
  },
  validationPending: {
    color: WalletColors.textMuted,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: WalletColors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  primaryButtonText: {
    color: WalletColors.background,
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: WalletColors.surfaceElevated,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: WalletColors.border,
  },
  secondaryButtonText: {
    color: WalletColors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  dividerRow: {
    marginTop: 4,
    alignItems: 'center',
  },
  centerLink: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  linkText: {
    color: WalletColors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
});
