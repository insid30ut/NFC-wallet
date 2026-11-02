import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useObjectOutput,
  type CameraObjectOutput,
  type ScannedCode,
  type ScannedObject,
  type ScannedObjectType,
} from 'react-native-vision-camera';
import * as Haptics from 'expo-haptics';
import {
  decodePaymentRequest,
  PaymentUriCodecError,
  type DecodedPaymentRequest,
} from '../services/scanner/PaymentUriCodec';

export interface ScannedCodeResult {
  type: ScannedObjectType;
  value?: string;
}

export interface UseCodeScannerConfig {
  codeTypes: ScannedObjectType[];
  onCodeScanned: (codes: ScannedCodeResult[]) => void;
}

/**
 * VisionCamera QR Code Scanner hook supporting `useCodeScanner({ codeTypes: ['qr'] })`.
 * Wraps VisionCamera v5 Nitro `useObjectOutput` while exposing the familiar `useCodeScanner` signature.
 */
export function useCodeScanner({
  codeTypes,
  onCodeScanned,
}: UseCodeScannerConfig): CameraObjectOutput {
  const onCodeScannedRef = useRef(onCodeScanned);
  useEffect(() => {
    onCodeScannedRef.current = onCodeScanned;
  }, [onCodeScanned]);

  return useObjectOutput({
    types: codeTypes,
    onObjectsScanned: useCallback((objects: ScannedObject[]) => {
      const extracted: ScannedCodeResult[] = [];
      for (const obj of objects) {
        const candidate = obj as Partial<ScannedCode>;
        if (
          typeof candidate.value === 'string' &&
          candidate.value.trim().length > 0
        ) {
          extracted.push({
            type: obj.type,
            value: candidate.value,
          });
        }
      }
      if (extracted.length > 0) {
        onCodeScannedRef.current(extracted);
      }
    }, []),
  });
}

export interface QrScannerViewProps {
  isActive?: boolean;
  onPaymentDecoded: (decoded: DecodedPaymentRequest) => void;
}

export function QrScannerView({
  isActive = true,
  onPaymentDecoded,
}: QrScannerViewProps): React.JSX.Element {
  const {
    hasPermission,
    canRequestPermission,
    requestPermission,
  } = useCameraPermission();
  const device = useCameraDevice('back');

  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState<string>('');
  const lastScanTimestampRef = useRef<number>(0);

  const processRawPayload = useCallback(
    async (rawValue: string): Promise<void> => {
      try {
        const decoded = decodePaymentRequest(rawValue);
        setScanError(null);
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
        onPaymentDecoded(decoded);
      } catch (err) {
        await Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Warning
        );
        const msg =
          err instanceof PaymentUriCodecError
            ? `[${err.code}] ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        setScanError(msg);
      }
    },
    [onPaymentDecoded]
  );

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      if (!isActive) return;
      const firstValue = codes[0]?.value;
      if (!firstValue) return;

      const now = Date.now();
      if (now - lastScanTimestampRef.current < 2200) {
        return;
      }
      lastScanTimestampRef.current = now;
      void processRawPayload(firstValue);
    },
  });

  const handleToggleTorch = (): void => {
    void Haptics.selectionAsync();
    setTorchOn((prev) => !prev);
  };

  const handleRequestPermission = async (): Promise<void> => {
    void Haptics.selectionAsync();
    if (canRequestPermission) {
      await requestPermission();
    } else {
      await Linking.openSettings();
    }
  };

  const handleManualDecode = (): void => {
    if (!manualInput.trim()) return;
    void processRawPayload(manualInput.trim());
  };

  return (
    <View style={styles.container}>
      {/* Camera Viewport or Clean Permission Fallback */}
      <View style={styles.cameraFrame}>
        {!hasPermission ? (
          <View style={styles.permissionFallback}>
            <Text style={styles.permissionBadge}>CAMERA ACCESS REQUIRED</Text>
            <Text style={styles.permissionTitle}>
              Enable Camera to Scan BSV & BRC-100 QR Codes
            </Text>
            <Text style={styles.permissionDescription}>
              We use your camera strictly to scan BIP-21 payment URIs, BSV-21
              token requests, 1Sat Ordinal transfers, and BRC-100 dApp action
              requests.
            </Text>
            <Pressable
              style={styles.permissionBtn}
              onPress={handleRequestPermission}
            >
              <Text style={styles.permissionBtnText}>
                {canRequestPermission
                  ? 'Grant Camera Permission'
                  : 'Open System Settings'}
              </Text>
            </Pressable>
          </View>
        ) : !device ? (
          <View style={styles.permissionFallback}>
            <Text style={styles.permissionBadge}>NO CAMERA DEVICE</Text>
            <Text style={styles.permissionTitle}>
              Rear Camera Unavailable on Simulator
            </Text>
            <Text style={styles.permissionDescription}>
              Use the manual Payment URI / QR payload input below to test
              decoding and transaction confirmation.
            </Text>
          </View>
        ) : (
          <View style={styles.cameraWrapper}>
            <Camera
              style={StyleSheet.absoluteFill}
              device={device}
              isActive={isActive}
              outputs={[codeScanner]}
              torchMode={torchOn ? 'on' : 'off'}
            />

            {/* Reticle Overlay */}
            <View style={styles.overlayContainer} pointerEvents="box-none">
              <View style={styles.reticleBox}>
                <View style={[styles.corner, styles.cornerTL]} />
                <View style={[styles.corner, styles.cornerTR]} />
                <View style={[styles.corner, styles.cornerBL]} />
                <View style={[styles.corner, styles.cornerBR]} />
              </View>

              <View style={styles.cameraControlsRow}>
                <View style={styles.scanStatusPill}>
                  <View style={styles.liveDot} />
                  <Text style={styles.scanStatusText}>
                    Scanning QR (BIP-21 • BSV-21 • 1Sat • BRC-100)
                  </Text>
                </View>

                <Pressable
                  style={[
                    styles.torchButton,
                    torchOn && styles.torchButtonActive,
                  ]}
                  onPress={handleToggleTorch}
                >
                  <Text
                    style={[
                      styles.torchButtonText,
                      torchOn && styles.torchButtonTextActive,
                    ]}
                  >
                    {torchOn ? 'Torch ON' : 'Torch OFF'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}
      </View>

      {/* Error Banner if Malformed QR Scanned */}
      {scanError ? (
        <View style={styles.errorBanner}>
          <View style={styles.errorHeaderRow}>
            <Text style={styles.errorTitle}>Invalid Payment QR / URI</Text>
            <Pressable onPress={() => setScanError(null)}>
              <Text style={styles.dismissText}>Dismiss</Text>
            </Pressable>
          </View>
          <Text style={styles.errorBody}>{scanError}</Text>
        </View>
      ) : null}

      {/* Manual URI Entry & Preset Payloads for Simulator / Clipboard */}
      <View style={styles.manualCard}>
        <Text style={styles.manualTitle}>
          Paste or Test Payment URI / BRC-100 Payload
        </Text>
        <View style={styles.manualInputRow}>
          <TextInput
            style={styles.manualInput}
            value={manualInput}
            onChangeText={setManualInput}
            placeholder="bitcoin:1A1zP1e...?sv&amount=0.01"
            placeholderTextColor="#64748B"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.decodeBtn} onPress={handleManualDecode}>
            <Text style={styles.decodeBtnText}>Decode</Text>
          </Pressable>
        </View>

        <View style={styles.presetRow}>
          <Pressable
            style={styles.presetChip}
            onPress={() =>
              void processRawPayload(
                'bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa?sv&amount=0.0025&label=Espresso'
              )
            }
          >
            <Text style={styles.presetChipText}>Test BIP-21 BSV</Text>
          </Pressable>

          <Pressable
            style={styles.presetChip}
            onPress={() =>
              void processRawPayload(
                'bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa?sv&asset=bsv21&tokenId=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855_0&tokenAmount=250&symbol=MNEE'
              )
            }
          >
            <Text style={styles.presetChipText}>Test BSV-21</Text>
          </Pressable>

          <Pressable
            style={styles.presetChip}
            onPress={() =>
              void processRawPayload(
                'bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa?sv&asset=1sat&outpoint=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.0&name=Genesis%20Ordinal'
              )
            }
          >
            <Text style={styles.presetChipText}>Test 1Sat NFT</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  cameraFrame: {
    height: 310,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 14,
  },
  cameraWrapper: {
    flex: 1,
  },
  overlayContainer: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 18,
    paddingHorizontal: 14,
  },
  reticleBox: {
    width: 190,
    height: 190,
    marginTop: 12,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: '#38BDF8',
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 12,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 12,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 12,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 12,
  },
  cameraControlsRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  scanStatusPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#34D399',
    marginRight: 7,
  },
  scanStatusText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 1,
  },
  torchButton: {
    backgroundColor: 'rgba(15, 23, 42, 0.88)',
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#475569',
  },
  torchButtonActive: {
    backgroundColor: '#F59E0B',
    borderColor: '#FBBF24',
  },
  torchButtonText: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '800',
  },
  torchButtonTextActive: {
    color: '#020617',
  },
  permissionFallback: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  permissionBadge: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  permissionTitle: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 8,
  },
  permissionDescription: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 16,
  },
  permissionBtn: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
  },
  permissionBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  errorBanner: {
    backgroundColor: '#450A0A',
    borderColor: '#DC2626',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  errorHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  errorTitle: {
    color: '#FCA5A5',
    fontSize: 13,
    fontWeight: '700',
  },
  dismissText: {
    color: '#FECACA',
    fontSize: 12,
    fontWeight: '700',
  },
  errorBody: {
    color: '#FECACA',
    fontSize: 12,
  },
  manualCard: {
    backgroundColor: '#1E293B',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  manualTitle: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 8,
  },
  manualInputRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  manualInput: {
    flex: 1,
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: '#F8FAFC',
    fontSize: 13,
  },
  decodeBtn: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 10,
  },
  decodeBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  presetChip: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  presetChipText: {
    color: '#93C5FD',
    fontSize: 11,
    fontWeight: '600',
  },
});
