import { Platform } from 'react-native';
import NfcManager, {
  Ndef,
  NfcError,
  NfcTech,
  type NdefRecord,
} from 'react-native-nfc-manager';
import {
  decodePaymentRequest,
  PaymentUriCodecError,
  type DecodedPaymentRequest,
} from '../scanner/PaymentUriCodec';

export const DEFAULT_NFC_ALERT_MESSAGE =
  'Hold your phone near the BSV wallet or NFC tag';

export const DEFAULT_NFC_TIMEOUT_MS = 45_000;

export type NfcServiceErrorCode =
  | 'NFC_UNSUPPORTED'
  | 'NFC_DISABLED'
  | 'USER_CANCELLED'
  | 'TIMEOUT'
  | 'EMPTY_TAG'
  | 'INVALID_NDEF_PAYLOAD'
  | 'WRITE_FAILED'
  | 'NFC_ERROR';

export class NfcServiceError extends Error {
  public readonly code: NfcServiceErrorCode;

  constructor(code: NfcServiceErrorCode, message: string) {
    super(message);
    this.name = 'NfcServiceError';
    this.code = code;
  }

  public get isCancelled(): boolean {
    return this.code === 'USER_CANCELLED';
  }
}

export interface NfcHardwareStatus {
  supported: boolean;
  enabled: boolean;
  initialized: boolean;
}

export interface NfcSessionOptions {
  alertMessage?: string;
  timeoutMs?: number;
}

/**
 * Decode an individual NDEF record into a UTF-8 string using `Ndef.uri.decodePayload`
 * or `Ndef.text.decodePayload` from `react-native-nfc-manager`.
 */
export function decodeNdefRecordPayload(record: NdefRecord): string | null {
  if (!record || !Array.isArray(record.payload) || record.payload.length === 0) {
    return null;
  }

  const payloadBytes = new Uint8Array(record.payload);

  // 1. Standard Well-Known URI Record (TNF 0x01, RTD_URI 'U' / [0x55])
  if (
    Ndef.isType(record, Ndef.TNF_WELL_KNOWN, Ndef.RTD_URI) ||
    (record.tnf === Ndef.TNF_WELL_KNOWN &&
      (record.type === 'U' ||
        (Array.isArray(record.type) &&
          record.type.length === 1 &&
          record.type[0] === 0x55)))
  ) {
    return Ndef.uri.decodePayload(payloadBytes).trim();
  }

  // 2. Standard Well-Known Text Record (TNF 0x01, RTD_TEXT 'T' / [0x54])
  if (
    Ndef.isType(record, Ndef.TNF_WELL_KNOWN, Ndef.RTD_TEXT) ||
    (record.tnf === Ndef.TNF_WELL_KNOWN &&
      (record.type === 'T' ||
        (Array.isArray(record.type) &&
          record.type.length === 1 &&
          record.type[0] === 0x54)))
  ) {
    return Ndef.text.decodePayload(payloadBytes).trim();
  }

  // 3. Absolute URI or MIME media (e.g. application/json for BRC-100 Action Request)
  if (
    record.tnf === Ndef.TNF_ABSOLUTE_URI ||
    record.tnf === Ndef.TNF_MIME_MEDIA ||
    record.tnf === Ndef.TNF_EXTERNAL_TYPE
  ) {
    return Ndef.util.bytesToString(record.payload).trim();
  }

  // 4. Fallback: attempt URI decode if first byte is a valid NDEF URI prefix, otherwise UTF-8 text
  try {
    return Ndef.uri.decodePayload(payloadBytes).trim();
  } catch {
    try {
      return Ndef.text.decodePayload(payloadBytes).trim();
    } catch {
      return Ndef.util.bytesToString(record.payload).trim();
    }
  }
}

export class NfcService {
  private initialized = false;
  private initPromise: Promise<NfcHardwareStatus> | null = null;
  private manualCancelRequested = false;

  /**
   * Safely check hardware support (`NfcManager.isSupported()`) and start the native
   * NFC manager (`NfcManager.start()`).
   */
  public async initialize(): Promise<NfcHardwareStatus> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async (): Promise<NfcHardwareStatus> => {
      try {
        const supported = await NfcManager.isSupported();
        if (!supported) {
          this.initialized = false;
          return {
            supported: false,
            enabled: false,
            initialized: false,
          };
        }

        if (!this.initialized) {
          await NfcManager.start();
          this.initialized = true;
        }

        let enabled = true;
        try {
          enabled = await NfcManager.isEnabled();
        } catch {
          // On iOS, isEnabled() may not apply the same way as Android; default to true when supported
          enabled = true;
        }

        return {
          supported: true,
          enabled,
          initialized: this.initialized,
        };
      } catch {
        this.initialized = false;
        return {
          supported: false,
          enabled: false,
          initialized: false,
        };
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Open the Android NFC system settings screen when NFC radio is disabled.
   */
  public async openNfcSettings(): Promise<boolean> {
    if (Platform.OS === 'android') {
      try {
        return await NfcManager.goToNfcSetting();
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Cancel any active NFC technology request cleanly.
   */
  public async cancelSession(): Promise<void> {
    this.manualCancelRequested = true;
    try {
      await NfcManager.cancelTechnologyRequest({ throwOnError: false });
    } catch {
      // Ignore cleanup errors when no session is active
    }
  }

  /**
   * Ensure NFC hardware is supported, initialized, and enabled before starting a session.
   */
  private async ensureReady(): Promise<void> {
    const status = await this.initialize();
    if (!status.supported || !status.initialized) {
      throw new NfcServiceError(
        'NFC_UNSUPPORTED',
        'NFC is not supported on this device or simulator.'
      );
    }
    if (!status.enabled) {
      throw new NfcServiceError(
        'NFC_DISABLED',
        'NFC is currently disabled. Please enable NFC in your device settings.'
      );
    }
  }

  /**
   * Request `NfcTech.Ndef` with iOS CoreNFC `alertMessage` and timeout protection.
   */
  private async requestNdefWithTimeout(
    options?: NfcSessionOptions
  ): Promise<void> {
    const alertMessage = options?.alertMessage ?? DEFAULT_NFC_ALERT_MESSAGE;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_NFC_TIMEOUT_MS;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      await Promise.race([
        NfcManager.requestTechnology(NfcTech.Ndef, {
          alertMessage,
        }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            void NfcManager.cancelTechnologyRequest({ throwOnError: false });
            reject(
              new NfcServiceError(
                'TIMEOUT',
                'NFC session timed out while waiting for a BSV wallet or NFC tag.'
              )
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Normalize errors thrown by `react-native-nfc-manager` into `NfcServiceError`.
   */
  private normalizeNfcError(
    err: unknown,
    fallbackCode: NfcServiceErrorCode = 'NFC_ERROR'
  ): NfcServiceError {
    if (err instanceof NfcServiceError) {
      return err;
    }

    if (this.manualCancelRequested || err instanceof NfcError.UserCancel) {
      return new NfcServiceError(
        'USER_CANCELLED',
        'NFC session was cancelled by the user.'
      );
    }

    if (err instanceof NfcError.Timeout) {
      return new NfcServiceError(
        'TIMEOUT',
        'NFC scan timed out. Hold your phone closer to the tag and try again.'
      );
    }

    if (err instanceof NfcError.RadioDisabled) {
      return new NfcServiceError(
        'NFC_DISABLED',
        'NFC radio is disabled on this device.'
      );
    }

    if (err instanceof NfcError.UnsupportedFeature) {
      return new NfcServiceError(
        'NFC_UNSUPPORTED',
        'NFC NDEF is not supported on this device.'
      );
    }

    if (err instanceof PaymentUriCodecError) {
      return new NfcServiceError(
        'INVALID_NDEF_PAYLOAD',
        `Tag payload is not a valid BSV payment request: [${err.code}] ${err.message}`
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();

    if (
      lower.includes('cancel') ||
      lower.includes('usercancel') ||
      lower.includes('invalidated by user')
    ) {
      return new NfcServiceError(
        'USER_CANCELLED',
        'NFC session was cancelled.'
      );
    }

    if (lower.includes('timeout') || lower.includes('timed out')) {
      return new NfcServiceError(
        'TIMEOUT',
        'NFC session timed out before a tag was detected.'
      );
    }

    return new NfcServiceError(
      fallbackCode,
      message || 'An unexpected NFC error occurred.'
    );
  }

  /**
   * Read an NFC tag or peer NDEF payload and decode it into a `DecodedPaymentRequest`.
   *
   * - Requests `NfcTech.Ndef` with iOS CoreNFC `alertMessage`.
   * - Reads the NDEF message and decodes URI or Text records via
   *   `Ndef.uri.decodePayload` / `Ndef.text.decodePayload`.
   * - Parses the string via `decodePaymentRequest()`.
   * - Always calls `NfcManager.cancelTechnologyRequest()` in a `finally` block.
   */
  public async readPaymentTag(
    options?: NfcSessionOptions
  ): Promise<DecodedPaymentRequest> {
    this.manualCancelRequested = false;
    await this.ensureReady();

    try {
      await this.requestNdefWithTimeout(options);

      let tag = await NfcManager.getTag();
      if (!tag?.ndefMessage || tag.ndefMessage.length === 0) {
        try {
          const explicitNdef = await NfcManager.ndefHandler.getNdefMessage();
          if (explicitNdef?.ndefMessage && explicitNdef.ndefMessage.length > 0) {
            tag = explicitNdef;
          }
        } catch {
          // Fall through to EMPTY_TAG check below
        }
      }

      const records = tag?.ndefMessage ?? [];
      if (records.length === 0) {
        throw new NfcServiceError(
          'EMPTY_TAG',
          'NFC tag was detected, but it does not contain any NDEF records.'
        );
      }

      let lastDecodeError: unknown = null;
      for (const record of records) {
        const decodedText = decodeNdefRecordPayload(record);
        if (!decodedText) {
          continue;
        }
        try {
          const paymentRequest = decodePaymentRequest(decodedText);
          if (Platform.OS === 'ios') {
            await NfcManager.setAlertMessageIOS(
              'BSV Payment Request Read!'
            ).catch(() => undefined);
          }
          return paymentRequest;
        } catch (err) {
          lastDecodeError = err;
        }
      }

      if (lastDecodeError) {
        throw lastDecodeError;
      }

      throw new NfcServiceError(
        'INVALID_NDEF_PAYLOAD',
        'No readable URI or Text NDEF payload was found on the NFC tag.'
      );
    } catch (err) {
      const normalized = this.normalizeNfcError(err, 'INVALID_NDEF_PAYLOAD');
      if (Platform.OS === 'ios' && !normalized.isCancelled) {
        await NfcManager.invalidateSessionWithErrorIOS(
          normalized.message
        ).catch(() => undefined);
      }
      throw normalized;
    } finally {
      this.manualCancelRequested = false;
      await NfcManager.cancelTechnologyRequest({ throwOnError: false }).catch(
        () => undefined
      );
    }
  }

  /**
   * Encode a BIP-21 / BSV-21 / 1Sat / BRC-100 payment URI into an NDEF URI record
   * (`Ndef.encodeMessage([Ndef.uriRecord(uri)])`) and write it via
   * `NfcManager.ndefHandler.writeNdefMessage(bytes)`.
   *
   * Always calls `NfcManager.cancelTechnologyRequest()` in a `finally` block.
   */
  public async writePaymentRequestToTag(
    uri: string,
    options?: NfcSessionOptions
  ): Promise<void> {
    this.manualCancelRequested = false;
    const trimmedUri = uri.trim();
    if (!trimmedUri) {
      throw new NfcServiceError(
        'INVALID_NDEF_PAYLOAD',
        'Cannot write an empty payment URI to NFC.'
      );
    }

    // Validate the URI with PaymentUriCodec before starting the NFC session
    decodePaymentRequest(trimmedUri);

    await this.ensureReady();

    const encodedBytes = Ndef.encodeMessage([Ndef.uriRecord(trimmedUri)]);
    if (!encodedBytes || encodedBytes.length === 0) {
      throw new NfcServiceError(
        'WRITE_FAILED',
        'Failed to encode payment URI into an NDEF URI record.'
      );
    }

    try {
      await this.requestNdefWithTimeout({
        alertMessage:
          options?.alertMessage ?? DEFAULT_NFC_ALERT_MESSAGE,
        timeoutMs: options?.timeoutMs ?? DEFAULT_NFC_TIMEOUT_MS,
      });

      await NfcManager.ndefHandler.writeNdefMessage(encodedBytes);

      if (Platform.OS === 'ios') {
        await NfcManager.setAlertMessageIOS(
          'Payment Request Written to NFC!'
        ).catch(() => undefined);
      }
    } catch (err) {
      const normalized = this.normalizeNfcError(err, 'WRITE_FAILED');
      if (Platform.OS === 'ios' && !normalized.isCancelled) {
        await NfcManager.invalidateSessionWithErrorIOS(
          normalized.message
        ).catch(() => undefined);
      }
      throw normalized;
    } finally {
      this.manualCancelRequested = false;
      await NfcManager.cancelTechnologyRequest({ throwOnError: false }).catch(
        () => undefined
      );
    }
  }
}

export const nfcService = new NfcService();
