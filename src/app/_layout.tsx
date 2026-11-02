import React, { useEffect } from 'react';
import { Linking } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { WalletColors } from '@/constants/theme';
import { Brc100PermissionSheet } from '@/components/Brc100PermissionSheet';
import { brc100AppBridge } from '@/services/brc100/AppBridge';

export default function RootLayout() {
  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      void brc100AppBridge.handleDeepLinkUrl(url);
    });

    Linking.getInitialURL()
      .then((initialUrl) => {
        if (initialUrl) {
          void brc100AppBridge.handleDeepLinkUrl(initialUrl);
        }
      })
      .catch(() => undefined);

    return () => {
      subscription.remove();
    };
  }, []);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: WalletColors.background },
        }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="onboarding"
          options={{
            headerShown: false,
            presentation: 'card',
          }}
        />
      </Stack>
      <Brc100PermissionSheet />
    </>
  );
}
