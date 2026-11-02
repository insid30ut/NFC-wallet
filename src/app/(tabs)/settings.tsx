import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { WalletColors } from '@/constants/theme';
import { DeveloperSelfTestCard } from '@/components/DeveloperSelfTestCard';
import { keyVaultService } from '@/services/wallet';

export default function SettingsScreen() {
  const [biometricHardware, setBiometricHardware] = useState<boolean | null>(
    null
  );
  const [secureStoreAvailable, setSecureStoreAvailable] = useState<
    boolean | null
  >(null);
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() =>
    keyVaultService.isUnlocked()
  );

  useEffect(() => {
    let mounted = true;

    async function checkSecurityModules() {
      try {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        if (mounted) {
          setBiometricHardware(hasHardware);
        }
      } catch {
        if (mounted) {
          setBiometricHardware(false);
        }
      }

      try {
        const isAvailable = await SecureStore.isAvailableAsync();
        if (mounted) {
          setSecureStoreAvailable(isAvailable);
        }
      } catch {
        if (mounted) {
          setSecureStoreAvailable(false);
        }
      }
    }

    void checkSecurityModules();
    const unsubscribe = keyVaultService.subscribe((unlocked) => {
      if (mounted) {
        setIsUnlocked(unlocked);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}>
      <View style={styles.card}>
        <Text style={styles.title}>Hardware Key Storage &amp; Biometrics</Text>
        <Text style={styles.description}>
          Mnemonics and master private keys are stored exclusively in
          hardware-backed storage (iOS Keychain / Android Keystore) via
          expo-secure-store and gated by expo-local-authentication. Private
          keys are never logged to the console.
        </Text>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Vault Session Status</Text>
          <Text
            style={[
              styles.rowValue,
              !isUnlocked && { color: WalletColors.primary },
            ]}>
            {isUnlocked ? 'Unlocked in Memory' : 'Locked'}
          </Text>
        </View>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>SecureStore (Keychain / Keystore)</Text>
          <Text style={styles.rowValue}>
            {secureStoreAvailable === null
              ? 'Checking...'
              : secureStoreAvailable
                ? 'Available'
                : 'Unavailable'}
          </Text>
        </View>

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Biometric Sensor (FaceID / TouchID)</Text>
          <Text style={styles.rowValue}>
            {biometricHardware === null
              ? 'Checking...'
              : biometricHardware
                ? 'Present'
                : 'Not Detected'}
          </Text>
        </View>

        <View style={styles.actionsRow}>
          {isUnlocked ? (
            <Pressable
              onPress={() => {
                keyVaultService.lockWallet();
                router.push('/onboarding');
              }}
              style={({ pressed }) => [
                styles.lockButton,
                pressed && styles.buttonPressed,
              ]}>
              <Text style={styles.lockButtonText}>Lock Hardware Vault</Text>
            </Pressable>
          ) : null}

          <Pressable
            onPress={() => router.push('/onboarding')}
            style={({ pressed }) => [
              styles.onboardingButton,
              pressed && styles.buttonPressed,
            ]}>
            <Text style={styles.onboardingButtonText}>
              {isUnlocked
                ? 'Manage / Replace Wallet'
                : 'Unlock / Onboarding'}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>BRC-100 SQLite Basket Store</Text>
        <Text style={styles.description}>
          Local UTXO caching and BRC-100 wallet state persistence backed by
          expo-sqlite (
          {typeof SQLite.openDatabaseAsync === 'function'
            ? 'Async SQLite Driver Ready'
            : 'Loaded'}
          ) and @bsv/wallet-toolbox-mobile.
        </Text>
      </View>

      <DeveloperSelfTestCard />
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
  },
  card: {
    backgroundColor: WalletColors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: WalletColors.border,
    gap: 10,
  },
  title: {
    color: WalletColors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  description: {
    color: WalletColors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: WalletColors.background,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: WalletColors.border,
  },
  rowLabel: {
    color: WalletColors.textSecondary,
    fontSize: 12,
  },
  rowValue: {
    color: WalletColors.success,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  actionsRow: {
    marginTop: 6,
    gap: 10,
  },
  lockButton: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: WalletColors.danger,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  lockButtonText: {
    color: WalletColors.danger,
    fontSize: 13,
    fontWeight: '700',
  },
  onboardingButton: {
    backgroundColor: WalletColors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  onboardingButtonText: {
    color: WalletColors.background,
    fontSize: 13,
    fontWeight: '700',
  },
  buttonPressed: {
    opacity: 0.85,
  },
});
