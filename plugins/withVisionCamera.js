const { withInfoPlist, AndroidConfig } = require('@expo/config-plugins');

/**
 * Expo Config Plugin for react-native-vision-camera v5 (Nitro).
 * Configures iOS Info.plist NSCameraUsageDescription and Android CAMERA permission.
 */
function withVisionCamera(config, props = {}) {
  const cameraPermissionText =
    props.cameraPermissionText ||
    'Allow $(PRODUCT_NAME) to access your camera to scan QR codes.';

  config = withInfoPlist(config, (plistConfig) => {
    plistConfig.modResults.NSCameraUsageDescription =
      plistConfig.modResults.NSCameraUsageDescription || cameraPermissionText;
    return plistConfig;
  });

  config = AndroidConfig.Permissions.withPermissions(config, [
    'android.permission.CAMERA',
  ]);

  return config;
}

module.exports = withVisionCamera;
