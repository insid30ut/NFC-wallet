import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PrivateKey } from '@bsv/sdk';
import { WalletColors } from '@/constants/theme';

export interface DiagnosticState {
  status: 'testing' | 'ok' | 'error';
  publicKeyHex: string;
  address: string;
  hasCryptoGetRandomValues: boolean;
  hasBuffer: boolean;
  hasProcess: boolean;
  isHermes: boolean;
  errorMessage?: string;
}

export function runHermesCryptoDiagnostic(): DiagnosticState {
  const hasCryptoGetRandomValues =
    typeof globalThis.crypto?.getRandomValues === 'function';
  const hasBuffer = typeof globalThis.Buffer !== 'undefined';
  const hasProcess = typeof globalThis.process !== 'undefined';
  const isHermes =
    typeof (globalThis as unknown as Record<string, unknown>).HermesInternal !==
    'undefined';

  try {
    // Generate an ephemeral key using @bsv/sdk PrivateKey.fromRandom().
    // Per workspace security rules, NEVER log private keys to the console.
    const ephemeralPrivateKey = PrivateKey.fromRandom();
    const publicKey = ephemeralPrivateKey.toPublicKey();
    const publicKeyHex = publicKey.toString();
    const address = publicKey.toAddress();

    return {
      status: 'ok',
      publicKeyHex,
      address,
      hasCryptoGetRandomValues,
      hasBuffer,
      hasProcess,
      isHermes,
    };
  } catch (err) {
    return {
      status: 'error',
      publicKeyHex: '',
      address: '',
      hasCryptoGetRandomValues,
      hasBuffer,
      hasProcess,
      isHermes,
      errorMessage: err instanceof Error ? err.message : 'Unknown crypto error',
    };
  }
}

export function CryptoDiagnosticCard() {
  const [diag, setDiag] = useState<DiagnosticState>(() =>
    runHermesCryptoDiagnostic()
  );

  const handleRegenerate = useCallback(() => {
    setDiag(runHermesCryptoDiagnostic());
  }, []);

  const isHealthy =
    diag.status === 'ok' &&
    diag.publicKeyHex.length === 66 &&
    diag.hasCryptoGetRandomValues &&
    diag.hasBuffer &&
    diag.hasProcess;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.titleGroup}>
          <Text style={styles.title}>@bsv/sdk Hermes Crypto Diagnostic</Text>
          <Text style={styles.subtitle}>
            Tests PrivateKey.fromRandom() & global polyfills
          </Text>
        </View>
        <View
          style={[
            styles.badge,
            isHealthy ? styles.badgeSuccess : styles.badgeError,
          ]}>
          <Text
            style={[
              styles.badgeText,
              isHealthy ? styles.badgeTextSuccess : styles.badgeTextError,
            ]}>
            {isHealthy ? 'PASS' : 'ERROR'}
          </Text>
        </View>
      </View>

      <View style={styles.pillsRow}>
        <StatusPill
          label="getRandomValues"
          active={diag.hasCryptoGetRandomValues}
        />
        <StatusPill label="Buffer" active={diag.hasBuffer} />
        <StatusPill label="process" active={diag.hasProcess} />
        <StatusPill
          label={diag.isHermes ? 'Hermes JS' : 'JS Engine'}
          active={true}
        />
      </View>

      {diag.status === 'ok' ? (
        <View style={styles.outputBox}>
          <Text style={styles.fieldLabel}>
            Generated Public Key Hex (33-byte compressed)
          </Text>
          <Text selectable style={styles.monoValue}>
            {diag.publicKeyHex}
          </Text>

          <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>
            Derived BSV Address
          </Text>
          <Text selectable style={styles.monoValue}>
            {diag.address}
          </Text>
        </View>
      ) : (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            {diag.errorMessage ?? 'Failed to initialize @bsv/sdk PrivateKey'}
          </Text>
        </View>
      )}

      <Pressable
        onPress={handleRegenerate}
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
        ]}>
        <Text style={styles.buttonText}>
          Test PrivateKey.fromRandom() Again
        </Text>
      </Pressable>
    </View>
  );
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return (
    <View
      style={[
        styles.pill,
        active ? styles.pillActive : styles.pillInactive,
      ]}>
      <Text
        style={[
          styles.pillText,
          active ? styles.pillTextActive : styles.pillTextInactive,
        ]}>
        {active ? '✓ ' : '✗ '}
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: WalletColors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: WalletColors.border,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  titleGroup: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: WalletColors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  subtitle: {
    color: WalletColors.textSecondary,
    fontSize: 12,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  badgeSuccess: {
    backgroundColor: WalletColors.successMuted,
  },
  badgeError: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  badgeTextSuccess: {
    color: WalletColors.success,
  },
  badgeTextError: {
    color: WalletColors.danger,
  },
  pillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  pillActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  pillInactive: {
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
  },
  pillTextActive: {
    color: WalletColors.success,
  },
  pillTextInactive: {
    color: WalletColors.danger,
  },
  outputBox: {
    backgroundColor: WalletColors.background,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: WalletColors.border,
  },
  fieldLabel: {
    color: WalletColors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  fieldLabelSpaced: {
    marginTop: 10,
  },
  monoValue: {
    color: WalletColors.primary,
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderRadius: 10,
    padding: 12,
  },
  errorText: {
    color: WalletColors.danger,
    fontSize: 13,
  },
  button: {
    backgroundColor: WalletColors.primary,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: WalletColors.background,
    fontSize: 13,
    fontWeight: '700',
  },
});
