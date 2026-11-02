import type { WalletNetwork } from '@bsv/sdk';
import { brc100WalletEngine } from '@/services/wallet/Brc100WalletEngine';

export interface NetworkEndpoints {
  network: WalletNetwork;
  label: string;
  whatsOnChainBaseUrl: string;
  gorillaPoolOrdinalsBaseUrl: string;
  ordfsContentBaseUrl: string;
  arcPrimaryBaseUrl: string;
  arcFallbackBaseUrl: string;
  defaultFeeRateSatsPerKb: number;
}

export interface ArcFeeQuote {
  satoshisPerKilobyte: number;
  bytes: number;
  satoshis: number;
  sourceEndpoint: string;
  fetchedAt: number;
}

export interface ArcBroadcastResponse {
  txid: string;
  txStatus: string;
  extraInfo?: string;
  blockHeight?: number;
  endpointUsed: string;
}

export const NETWORK_ENDPOINTS: Record<WalletNetwork, NetworkEndpoints> = {
  mainnet: {
    network: 'mainnet',
    label: 'BSV Mainnet',
    whatsOnChainBaseUrl: 'https://api.whatsonchain.com/v1/bsv/main',
    gorillaPoolOrdinalsBaseUrl: 'https://ordinals.gorillapool.io/api',
    ordfsContentBaseUrl: 'https://ordfs.network',
    arcPrimaryBaseUrl: 'https://arc.gorillapool.io',
    arcFallbackBaseUrl: 'https://arc.taal.com',
    defaultFeeRateSatsPerKb: 50,
  },
  testnet: {
    network: 'testnet',
    label: 'BSV Testnet',
    whatsOnChainBaseUrl: 'https://api.whatsonchain.com/v1/bsv/test',
    gorillaPoolOrdinalsBaseUrl: 'https://testnet.ordinals.gorillapool.io/api',
    ordfsContentBaseUrl: 'https://ordfs.network',
    arcPrimaryBaseUrl: 'https://testnet.arc.gorillapool.io',
    arcFallbackBaseUrl: 'https://arc-test.taal.com',
    defaultFeeRateSatsPerKb: 50,
  },
};

export class NetworkConfigService {
  private currentNetwork: WalletNetwork = 'mainnet';
  private listeners = new Set<(network: WalletNetwork) => void>();
  private cachedFeeQuotes: Partial<Record<WalletNetwork, ArcFeeQuote>> = {};

  /**
   * Returns the currently active BSV network ('mainnet' | 'testnet').
   */
  public getNetwork(): WalletNetwork {
    return this.currentNetwork;
  }

  /**
   * Switches between BSV Mainnet and Testnet and notifies subscribers.
   */
  public setNetwork(network: WalletNetwork): void {
    if (this.currentNetwork === network) {
      return;
    }
    this.currentNetwork = network;
    brc100WalletEngine.setNetwork(network);
    for (const listener of this.listeners) {
      listener(network);
    }
  }

  /**
   * Subscribes to network switching events.
   */
  public subscribe(listener: (network: WalletNetwork) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns the REST & ARC endpoints for the specified (or active) network.
   */
  public getEndpoints(network: WalletNetwork = this.currentNetwork): NetworkEndpoints {
    return NETWORK_ENDPOINTS[network];
  }

  /**
   * Builds a WhatsOnChain URL for unspent UTXO lookup by address.
   */
  public getWhatsOnChainUtxosUrl(
    address: string,
    network: WalletNetwork = this.currentNetwork
  ): string {
    const { whatsOnChainBaseUrl } = this.getEndpoints(network);
    return `${whatsOnChainBaseUrl}/address/${encodeURIComponent(address)}/unspent`;
  }

  /**
   * Builds a WhatsOnChain URL for raw transaction hex lookup.
   */
  public getWhatsOnChainRawTxUrl(
    txid: string,
    network: WalletNetwork = this.currentNetwork
  ): string {
    const { whatsOnChainBaseUrl } = this.getEndpoints(network);
    return `${whatsOnChainBaseUrl}/tx/${encodeURIComponent(txid)}/hex`;
  }

  /**
   * Builds a GorillaPool 1Sat Ordinals URL for unspent ordinal/BSV-21 TXO lookup by address.
   */
  public getGorillaPoolAddressUnspentUrl(
    address: string,
    network: WalletNetwork = this.currentNetwork
  ): string {
    const { gorillaPoolOrdinalsBaseUrl } = this.getEndpoints(network);
    return `${gorillaPoolOrdinalsBaseUrl}/txos/address/${encodeURIComponent(address)}/unspent?limit=100`;
  }

  /**
   * Builds an ORDFS content URL for rendering 1Sat Ordinal inscriptions (`image/*`, `image/svg+xml`, `text/html`).
   */
  public getOrdfsContentUrl(
    originOrOutpoint: string,
    network: WalletNetwork = this.currentNetwork
  ): string {
    const { ordfsContentBaseUrl } = this.getEndpoints(network);
    const normalized = originOrOutpoint
      .replace(/^origin_/, '')
      .replace('.', '_');
    return `${ordfsContentBaseUrl}/${encodeURIComponent(normalized)}`;
  }

  /**
   * Queries TAAL / GorillaPool ARC (`GET /v1/policy`) for the current mining fee quote.
   * Falls back to a safe standard BSV relay fee rate (50 sats/KB) if offline.
   */
  public async fetchArcFeeQuote(
    network: WalletNetwork = this.currentNetwork
  ): Promise<ArcFeeQuote> {
    const cached = this.cachedFeeQuotes[network];
    if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
      return cached;
    }

    const endpoints = this.getEndpoints(network);
    const arcBases = [endpoints.arcPrimaryBaseUrl, endpoints.arcFallbackBaseUrl];

    for (const baseUrl of arcBases) {
      try {
        const response = await fetch(`${baseUrl}/v1/policy`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          continue;
        }
        const json = (await response.json()) as {
          policy?: {
            miningFee?: {
              satoshis?: number;
              bytes?: number;
            };
          };
        };
        const sats = json.policy?.miningFee?.satoshis;
        const bytes = json.policy?.miningFee?.bytes;
        if (
          typeof sats === 'number' &&
          sats > 0 &&
          typeof bytes === 'number' &&
          bytes > 0
        ) {
          const satoshisPerKilobyte = Math.max(
            1,
            Math.ceil((sats * 1000) / bytes)
          );
          const quote: ArcFeeQuote = {
            satoshisPerKilobyte,
            bytes,
            satoshis: sats,
            sourceEndpoint: baseUrl,
            fetchedAt: Date.now(),
          };
          this.cachedFeeQuotes[network] = quote;
          return quote;
        }
      } catch {
        // Try fallback ARC endpoint
      }
    }

    return {
      satoshisPerKilobyte: endpoints.defaultFeeRateSatsPerKb,
      bytes: 1000,
      satoshis: endpoints.defaultFeeRateSatsPerKb,
      sourceEndpoint: 'fallback-default-policy',
      fetchedAt: Date.now(),
    };
  }

  /**
   * Broadcasts a signed transaction to TAAL / GorillaPool ARC (`POST /v1/tx`).
   */
  public async broadcastTransaction(
    rawTxHex: string,
    network: WalletNetwork = this.currentNetwork
  ): Promise<ArcBroadcastResponse> {
    const endpoints = this.getEndpoints(network);
    const arcBases = [endpoints.arcPrimaryBaseUrl, endpoints.arcFallbackBaseUrl];
    let lastErrorMessage = 'ARC broadcast failed across configured endpoints';

    for (const baseUrl of arcBases) {
      const txEndpoint = `${baseUrl}/v1/tx`;
      try {
        const response = await fetch(txEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ rawTx: rawTxHex }),
        });

        const payload = (await response.json().catch(() => ({}))) as {
          txid?: string;
          txStatus?: string;
          extraInfo?: string;
          blockHeight?: number;
          detail?: string;
          title?: string;
        };

        if (response.ok && payload.txid) {
          return {
            txid: payload.txid,
            txStatus: payload.txStatus ?? 'SEEN_ON_NETWORK',
            extraInfo: payload.extraInfo,
            blockHeight: payload.blockHeight,
            endpointUsed: txEndpoint,
          };
        }

        lastErrorMessage =
          payload.detail ??
          payload.extraInfo ??
          payload.title ??
          `HTTP ${response.status} from ${txEndpoint}`;
      } catch (err) {
        lastErrorMessage =
          err instanceof Error ? err.message : 'Network error calling ARC';
      }
    }

    throw new Error(lastErrorMessage);
  }
}

export const networkConfigService = new NetworkConfigService();
