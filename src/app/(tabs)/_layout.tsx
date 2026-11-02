import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { WalletColors } from '@/constants/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: {
          backgroundColor: WalletColors.surface,
        },
        headerTintColor: WalletColors.textPrimary,
        headerTitleStyle: {
          fontWeight: '700',
        },
        tabBarStyle: {
          backgroundColor: WalletColors.surface,
          borderTopColor: WalletColors.border,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: WalletColors.primary,
        tabBarInactiveTintColor: WalletColors.textMuted,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          headerTitle: 'Home · Balances & Baskets',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="wallet-outline" size={size} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="collectibles"
        options={{
          title: 'Collectibles',
          headerTitle: 'Collectibles · 1Sat NFTs',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="diamond-outline" size={size} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: 'Scan/Tap',
          headerTitle: 'Scan / Tap · QR & NFC',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="scan-outline" size={size} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          headerTitle: 'Settings · Security & Backup',
          tabBarIcon: ({ color, size }) => (
            <Ionicons
              name="shield-checkmark-outline"
              size={size}
              color={String(color)}
            />
          ),
        }}
      />
    </Tabs>
  );
}
