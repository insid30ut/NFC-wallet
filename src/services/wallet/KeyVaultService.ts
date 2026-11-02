import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { HD, KeyDeriver, Mnemonic, PrivateKey } from '@bsv/sdk';

const SECURE_STORE_MNEMONIC_KEY = 'nfc_bsv_wallet.mnemonic_v1';
const SECURE_STORE_IDENTITY_PUBKEY_KEY = 'nfc_bsv_wallet.identity_pubkey_v1';
const SECURE_STORE_ADDRESS_KEY = 'nfc_bsv_wallet.address_v1';

/**
 * Standard BSV BIP-44 derivation path (coin type 236 for Bitcoin SV).
 */
export const BSV_ROOT_DERIVATION_PATH = "m/44'/236'/0'/0/0";

export interface WalletKeyMetadata {
  identityPublicKey: string;
  address: string;
  derivationPath: string;
}

export interface InitializedWalletResult extends WalletKeyMetadata {
  /**
   * Returned ONLY once during `initializeNewWallet()` so the user can
   * complete their 12-word seed phrase backup confirmation in Onboarding.
   * Never log this value to the console.
   */
  mnemonic: string;
}

interface UnlockedKeyMaterial extends WalletKeyMetadata {
  masterHdKey: HD;
  rootPrivateKey: PrivateKey;
  keyDeriver: KeyDeriver;
}

export interface KeyVaultOptions {
  requireBiometrics?: boolean;
  biometricPromptMessage?: string;
}

/**
 * Hardware-backed Key Vault Service for BRC-100 BSV Wallet.
 *
 * Security invariants:
 * - Generates & validates 12-word BIP-39 mnemonics (128-bit entropy) using `@bsv/sdk`.
 * - Derives root HD private keys via `@bsv/sdk` `Mnemonic` -> `HD.fromSeed()` -> `PrivateKey`.
 * - Stores mnemonics exclusively in hardware-backed storage (`expo-secure-store` /
 *   iOS Keychain / Android Keystore) gated by `expo-local-authentication`.
 * - NEVER logs mnemonics, seeds, or private keys to the console.
 */
export class KeyVaultService {
  private unlockedMaterial: UnlockedKeyMaterial | null = null;
  private listeners = new Set<(unlocked: boolean) => void>();

  /**
   * Normalizes a mnemonic phrase (lowercase, single-space separated, trimmed).
   */
  public normalizeMnemonic(mnemonic: string): string {
    return mnemonic
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Generates a fresh 12-word (128-bit entropy) BIP-39 mnemonic using `@bsv/sdk`.
   */
  public generateMnemonic(): string {
    const mnemonicObj = Mnemonic.fromRandom(128);
    return this.normalizeMnemonic(mnemonicObj.toString());
  }

  /**
   * Validates that a phrase is a valid 12-word BIP-39 mnemonic with a valid checksum.
   */
  public validateMnemonic(mnemonic: string): boolean {
    const normalized = this.normalizeMnemonic(mnemonic);
    if (!normalized) {
      return false;
    }

    const words = normalized.split(' ');
    if (words.length !== 12) {
      return false;
    }

    try {
      return Mnemonic.isValid(normalized);
    } catch {
      return false;
    }
  }

  /**
   * Derives the root HD key, child PrivateKey, and BRC-100 KeyDeriver from a validated 12-word mnemonic.
   */
  private deriveFromMnemonic(mnemonic: string): UnlockedKeyMaterial {
    const normalized = this.normalizeMnemonic(mnemonic);
    if (!this.validateMnemonic(normalized)) {
      throw new Error(
        'Invalid BIP-39 mnemonic phrase. Must be a valid 12-word recovery phrase.'
      );
    }

    const mnemonicInstance = Mnemonic.fromString(normalized);
    const seedBytes = mnemonicInstance.toSeed();
    const masterHdKey = HD.fromSeed(seedBytes);
    const derivedChildHd = masterHdKey.derive(BSV_ROOT_DERIVATION_PATH);
    const rootPrivateKey = derivedChildHd.privKey;
    const publicKey = rootPrivateKey.toPublicKey();
    const identityPublicKey = publicKey.toString();
    const address = publicKey.toAddress();
    const keyDeriver = new KeyDeriver(rootPrivateKey);

    return {
      masterHdKey,
      rootPrivateKey,
      keyDeriver,
      identityPublicKey,
      address,
      derivationPath: BSV_ROOT_DERIVATION_PATH,
    };
  }

  /**
   * Gates hardware vault access with FaceID / TouchID / Android Biometrics when supported.
   */
  private async authenticateBiometrics(promptMessage: string): Promise<void> {
    if (Platform.OS === 'web') {
      return;
    }

    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();

    if (!hasHardware || !isEnrolled) {
      // Device has no biometric sensor or user has not enrolled biometrics on simulator/device
      return;
    }

    const authResult = await LocalAuthentication.authenticateAsync({
      promptMessage,
      fallbackLabel: 'Use Device Passcode',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });

    if (!authResult.success) {
      throw new Error(
        authResult.error
          ? `Biometric authentication failed: ${authResult.error}`
          : 'Biometric authentication was cancelled.'
      );
    }
  }

  /**
   * Saves the mnemonic and public metadata into `expo-secure-store`.
   */
  private async saveToSecureStore(
    normalizedMnemonic: string,
    metadata: WalletKeyMetadata
  ): Promise<void> {
    const isAvailable = await SecureStore.isAvailableAsync();
    if (!isAvailable) {
      throw new Error(
        'Hardware-backed SecureStore is not available on this runtime.'
      );
    }

    const secureOptions: SecureStore.SecureStoreOptions = {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    };

    await SecureStore.setItemAsync(
      SECURE_STORE_MNEMONIC_KEY,
      normalizedMnemonic,
      secureOptions
    );
    await SecureStore.setItemAsync(
      SECURE_STORE_IDENTITY_PUBKEY_KEY,
      metadata.identityPublicKey,
      secureOptions
    );
    await SecureStore.setItemAsync(
      SECURE_STORE_ADDRESS_KEY,
      metadata.address,
      secureOptions
    );
  }

  /**
   * Generates a new 12-word BIP-39 wallet, persists the mnemonic in `expo-secure-store`
   * (gated by `expo-local-authentication`), unlocks the key deriver in memory,
   * and returns the mnemonic once for user backup confirmation.
   */
  public async initializeNewWallet(
    options?: KeyVaultOptions
  ): Promise<InitializedWalletResult> {
    if (options?.requireBiometrics !== false) {
      await this.authenticateBiometrics(
        options?.biometricPromptMessage ??
          'Authenticate to secure your new BSV wallet keys'
      );
    }

    const mnemonic = this.generateMnemonic();
    const material = this.deriveFromMnemonic(mnemonic);

    await this.saveToSecureStore(mnemonic, {
      identityPublicKey: material.identityPublicKey,
      address: material.address,
      derivationPath: material.derivationPath,
    });

    this.unlockedMaterial = material;
    this.notifyListeners();

    return {
      mnemonic,
      identityPublicKey: material.identityPublicKey,
      address: material.address,
      derivationPath: material.derivationPath,
    };
  }

  /**
   * Validates an existing 12-word BIP-39 mnemonic, stores it in `expo-secure-store`
   * (gated by `expo-local-authentication`), and unlocks the wallet in memory.
   */
  public async importWallet(
    mnemonic: string,
    options?: KeyVaultOptions
  ): Promise<WalletKeyMetadata> {
    const normalized = this.normalizeMnemonic(mnemonic);
    const material = this.deriveFromMnemonic(normalized);

    if (options?.requireBiometrics !== false) {
      await this.authenticateBiometrics(
        options?.biometricPromptMessage ??
          'Authenticate to import your BSV recovery phrase'
      );
    }

    await this.saveToSecureStore(normalized, {
      identityPublicKey: material.identityPublicKey,
      address: material.address,
      derivationPath: material.derivationPath,
    });

    this.unlockedMaterial = material;
    this.notifyListeners();

    return {
      identityPublicKey: material.identityPublicKey,
      address: material.address,
      derivationPath: material.derivationPath,
    };
  }

  /**
   * Prompts for biometric authentication (`expo-local-authentication`), retrieves the
   * 12-word mnemonic from `expo-secure-store`, and derives the root HD key in memory.
   */
  public async unlockWallet(
    options?: KeyVaultOptions
  ): Promise<WalletKeyMetadata> {
    if (options?.requireBiometrics !== false) {
      await this.authenticateBiometrics(
        options?.biometricPromptMessage ??
          'Unlock your BRC-100 BSV hardware vault'
      );
    }

    const isAvailable = await SecureStore.isAvailableAsync();
    if (!isAvailable) {
      throw new Error(
        'Hardware-backed SecureStore is not available on this runtime.'
      );
    }

    const storedMnemonic = await SecureStore.getItemAsync(
      SECURE_STORE_MNEMONIC_KEY,
      {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }
    );

    if (!storedMnemonic) {
      throw new Error(
        'No wallet seed found in SecureStore. Please create or import a wallet first.'
      );
    }

    const material = this.deriveFromMnemonic(storedMnemonic);
    this.unlockedMaterial = material;
    this.notifyListeners();

    return {
      identityPublicKey: material.identityPublicKey,
      address: material.address,
      derivationPath: material.derivationPath,
    };
  }

  /**
   * Wipes all in-memory private keys and key derivers while keeping the encrypted
   * hardware keystore record intact.
   */
  public lockWallet(): void {
    this.unlockedMaterial = null;
    this.notifyListeners();
  }

  /**
   * Unlocks an ephemeral in-memory KeyVaultService instance from a mnemonic
   * (used by isolated Developer Self-Test dry runs without overwriting SecureStore).
   */
  public unlockEphemeralInMemory(mnemonic: string): WalletKeyMetadata {
    const material = this.deriveFromMnemonic(mnemonic);
    this.unlockedMaterial = material;
    this.notifyListeners();
    return {
      identityPublicKey: material.identityPublicKey,
      address: material.address,
      derivationPath: material.derivationPath,
    };
  }

  /**
   * Checks whether a wallet has already been provisioned in SecureStore without
   * exposing the stored mnemonic.
   */
  public async hasStoredWallet(): Promise<boolean> {
    try {
      const isAvailable = await SecureStore.isAvailableAsync();
      if (!isAvailable) {
        return false;
      }
      const pubKey = await SecureStore.getItemAsync(
        SECURE_STORE_IDENTITY_PUBKEY_KEY
      );
      return Boolean(pubKey);
    } catch {
      return false;
    }
  }

  /**
   * Reads the non-sensitive public metadata (identity public key and address) if stored.
   */
  public async getStoredPublicMetadata(): Promise<WalletKeyMetadata | null> {
    try {
      const isAvailable = await SecureStore.isAvailableAsync();
      if (!isAvailable) {
        return null;
      }
      const [identityPublicKey, address] = await Promise.all([
        SecureStore.getItemAsync(SECURE_STORE_IDENTITY_PUBKEY_KEY),
        SecureStore.getItemAsync(SECURE_STORE_ADDRESS_KEY),
      ]);

      if (!identityPublicKey || !address) {
        return null;
      }

      return {
        identityPublicKey,
        address,
        derivationPath: BSV_ROOT_DERIVATION_PATH,
      };
    } catch {
      return null;
    }
  }

  /**
   * Returns true if the wallet is currently unlocked in memory.
   */
  public isUnlocked(): boolean {
    return this.unlockedMaterial !== null;
  }

  /**
   * Returns the unlocked public metadata or null if locked.
   */
  public getUnlockedMetadata(): WalletKeyMetadata | null {
    if (!this.unlockedMaterial) {
      return null;
    }
    return {
      identityPublicKey: this.unlockedMaterial.identityPublicKey,
      address: this.unlockedMaterial.address,
      derivationPath: this.unlockedMaterial.derivationPath,
    };
  }

  /**
   * Returns the active BRC-100 KeyDeriver (throws if wallet is locked).
   */
  public getKeyDeriver(): KeyDeriver {
    if (!this.unlockedMaterial) {
      throw new Error('Wallet is locked. Call unlockWallet() before deriving keys.');
    }
    return this.unlockedMaterial.keyDeriver;
  }

  /**
   * Returns the active root PrivateKey (throws if wallet is locked).
   */
  public getRootPrivateKey(): PrivateKey {
    if (!this.unlockedMaterial) {
      throw new Error('Wallet is locked. Call unlockWallet() before signing.');
    }
    return this.unlockedMaterial.rootPrivateKey;
  }

  /**
   * Subscribe to lock/unlock state transitions.
   */
  public subscribe(listener: (unlocked: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const unlocked = this.isUnlocked();
    for (const listener of this.listeners) {
      listener(unlocked);
    }
  }
}

export const keyVaultService = new KeyVaultService();
