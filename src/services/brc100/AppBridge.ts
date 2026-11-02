import { Buffer } from 'buffer';
import type {
  AuthenticatedResult,
  CreateActionResult,
  CreateSignatureArgs,
  CreateSignatureResult,
  GetHeightResult,
  GetPublicKeyArgs,
  GetPublicKeyResult,
  ListOutputsArgs,
  ListOutputsResult,
  OriginatorDomainNameStringUnder250Bytes,
  SignActionArgs,
  SignActionResult,
} from '@bsv/sdk';
import {
  type BasketName,
  BRC100_BASKETS,
} from '@/constants/baskets';
import {
  type Brc100ExtendedCreateActionArgs,
  Brc100WalletEngine,
  brc100WalletEngine,
} from '@/services/wallet/Brc100WalletEngine';
import {
  KeyVaultService,
  keyVaultService,
} from '@/services/wallet/KeyVaultService';

export type Brc100BridgeMethod =
  | 'createAction'
  | 'signAction'
  | 'listOutputs'
  | 'getPublicKey'
  | 'createSignature'
  | 'getHeight'
  | 'isAuthenticated';

export interface Brc100JsonRpcRequest<TParams = Record<string, unknown>> {
  jsonrpc?: '2.0';
  id: string | number;
  method: Brc100BridgeMethod;
  originator?: string;
  params?: TParams;
}

export interface Brc100JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface Brc100JsonRpcResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: TResult;
  error?: Brc100JsonRpcError;
}

export type PermissionApprovalType = 'basket-access' | 'sign-action';

export interface PendingBrc100PermissionRequest {
  requestId: string;
  rpcId: string | number;
  originator: string;
  method: Brc100BridgeMethod;
  approvalType: PermissionApprovalType;
  baskets: BasketName[];
  summary: string;
  totalSatoshis?: number;
  createdAt: number;
}

type PermissionListener = (
  pending: PendingBrc100PermissionRequest | null
) => void;

interface DeferredPermissionEntry {
  request: PendingBrc100PermissionRequest;
  resolve: (approved: boolean) => void;
}

const SUPPORTED_METHODS = new Set<Brc100BridgeMethod>([
  'createAction',
  'signAction',
  'listOutputs',
  'getPublicKey',
  'createSignature',
  'getHeight',
  'isAuthenticated',
]);

/**
 * BRC-100 Application Bridge (`AppBridge`)
 *
 * Implements the BRC-100 WalletWire / JSON-RPC 2.0 protocol for:
 * - In-app WebView message bridges (`window.ReactNativeWebView.postMessage`)
 * - Deep-link invocations (`nfcwallet://brc100?...` or `brc100://...`)
 * - Programmatic dApp requests
 *
 * Gates sensitive operations (`createAction`, `signAction`, `createSignature`,
 * and `listOutputs` basket queries) behind interactive user + biometric approval
 * via `Brc100PermissionSheet`.
 */
export class Brc100AppBridge {
  private readonly walletEngine: Brc100WalletEngine;
  private readonly keyVault: KeyVaultService;
  private readonly listeners = new Set<PermissionListener>();
  private readonly permissionQueue: DeferredPermissionEntry[] = [];
  private activeEntry: DeferredPermissionEntry | null = null;

  constructor(
    walletEngine: Brc100WalletEngine = brc100WalletEngine,
    keyVault: KeyVaultService = keyVaultService
  ) {
    this.walletEngine = walletEngine;
    this.keyVault = keyVault;
  }

  /**
   * Subscribe to active permission prompts so `Brc100PermissionSheet` can render them.
   */
  public subscribePermissionRequests(
    listener: PermissionListener
  ): () => void {
    this.listeners.add(listener);
    listener(this.activeEntry?.request ?? null);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getActivePermissionRequest(): PendingBrc100PermissionRequest | null {
    return this.activeEntry?.request ?? null;
  }

  private notifyListeners(): void {
    const current = this.activeEntry?.request ?? null;
    for (const listener of this.listeners) {
      listener(current);
    }
  }

  private advancePermissionQueue(): void {
    if (this.activeEntry || this.permissionQueue.length === 0) {
      this.notifyListeners();
      return;
    }
    this.activeEntry = this.permissionQueue.shift() ?? null;
    this.notifyListeners();
  }

  /**
   * Enqueue a permission request and wait for the user to approve or reject in `Brc100PermissionSheet`.
   */
  public requestUserPermission(
    request: Omit<PendingBrc100PermissionRequest, 'requestId' | 'createdAt'>
  ): Promise<boolean> {
    const fullRequest: PendingBrc100PermissionRequest = {
      ...request,
      requestId: `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    };

    return new Promise<boolean>((resolve) => {
      this.permissionQueue.push({
        request: fullRequest,
        resolve,
      });
      this.advancePermissionQueue();
    });
  }

  /**
   * Called by `Brc100PermissionSheet` when the user taps "Approve with Biometrics".
   */
  public async approveActivePermissionRequest(): Promise<void> {
    const current = this.activeEntry;
    if (!current) {
      return;
    }

    // Require biometric unlock / verification via KeyVaultService
    await this.keyVault.unlockWallet({
      requireBiometrics: true,
      biometricPromptMessage: `Approve ${current.request.method} for ${current.request.originator}`,
    });

    this.activeEntry = null;
    current.resolve(true);
    this.advancePermissionQueue();
  }

  /**
   * Called by `Brc100PermissionSheet` when the user taps "Reject".
   */
  public rejectActivePermissionRequest(): void {
    const current = this.activeEntry;
    if (!current) {
      return;
    }
    this.activeEntry = null;
    current.resolve(false);
    this.advancePermissionQueue();
  }

  /**
   * Inspect which baskets a request touches (`default`, `bsv21`, `1sat`).
   */
  private extractRequestedBaskets(
    method: Brc100BridgeMethod,
    params: Record<string, unknown>
  ): BasketName[] {
    const baskets = new Set<BasketName>();

    if (method === 'listOutputs') {
      const b = params.basket;
      if (
        b === BRC100_BASKETS.DEFAULT ||
        b === BRC100_BASKETS.BSV21 ||
        b === BRC100_BASKETS.ONESAT
      ) {
        baskets.add(b);
      } else {
        baskets.add(BRC100_BASKETS.DEFAULT);
      }
    } else if (method === 'createAction') {
      baskets.add(BRC100_BASKETS.DEFAULT);
      if (Array.isArray(params.outputs)) {
        for (const out of params.outputs) {
          if (out && typeof out === 'object') {
            const b = (out as Record<string, unknown>).basket;
            if (
              b === BRC100_BASKETS.DEFAULT ||
              b === BRC100_BASKETS.BSV21 ||
              b === BRC100_BASKETS.ONESAT
            ) {
              baskets.add(b);
            }
          }
        }
      }
      const flags = params.carrierSpendFlags as
        | { allowBsv21Spend?: boolean; allow1SatSpend?: boolean }
        | undefined;
      if (flags?.allowBsv21Spend) {
        baskets.add(BRC100_BASKETS.BSV21);
      }
      if (flags?.allow1SatSpend) {
        baskets.add(BRC100_BASKETS.ONESAT);
      }
    }

    return Array.from(baskets);
  }

  /**
   * Dispatch a validated BRC-100 method call to `Brc100WalletEngine`.
   */
  public async dispatchMethod(
    method: Brc100BridgeMethod,
    rawParams: Record<string, unknown> | undefined,
    originator = 'unknown-dapp.local',
    options?: { skipInteractivePermission?: boolean }
  ): Promise<
    | CreateActionResult
    | SignActionResult
    | ListOutputsResult
    | GetPublicKeyResult
    | CreateSignatureResult
    | GetHeightResult
    | AuthenticatedResult
    | { authenticated: boolean }
  > {
    const params = rawParams ?? {};
    const safeOriginator = (originator.trim() ||
      'unknown-dapp.local') as OriginatorDomainNameStringUnder250Bytes;

    // Determine whether this method requires interactive user + biometric approval
    const requiresPermission =
      !options?.skipInteractivePermission &&
      (method === 'createAction' ||
        method === 'signAction' ||
        method === 'listOutputs' ||
        method === 'createSignature');

    if (requiresPermission) {
      const baskets = this.extractRequestedBaskets(method, params);
      const approvalType: PermissionApprovalType =
        method === 'listOutputs' ? 'basket-access' : 'sign-action';

      let totalSatoshis: number | undefined;
      let summary = `dApp "${safeOriginator}" requests ${method}`;

      if (method === 'listOutputs') {
        summary = `Read unspent outputs in basket "${baskets.join(', ')}"`;
      } else if (method === 'createAction') {
        const desc =
          typeof params.description === 'string'
            ? params.description
            : 'Create & sign BRC-100 transaction';
        if (Array.isArray(params.outputs)) {
          totalSatoshis = params.outputs.reduce((acc: number, item: unknown) => {
            if (item && typeof item === 'object') {
              const s = Number((item as Record<string, unknown>).satoshis ?? 0);
              return acc + (Number.isFinite(s) ? s : 0);
            }
            return acc;
          }, 0);
        }
        summary = desc;
      } else if (method === 'signAction') {
        summary = `Complete signature for pending action (${String(params.reference ?? '').slice(0, 14)}...)`;
      } else if (method === 'createSignature') {
        summary = `Sign cryptographic payload with protocol ${JSON.stringify(params.protocolID ?? [0, 'default'])}`;
      }

      const approved = await this.requestUserPermission({
        rpcId: Date.now(),
        originator: safeOriginator,
        method,
        approvalType,
        baskets,
        summary,
        totalSatoshis,
      });

      if (!approved) {
        throw new Error(
          `User rejected BRC-100 "${method}" request from ${safeOriginator}.`
        );
      }
    }

    switch (method) {
      case 'createAction':
        return this.walletEngine.createAction(
          params as unknown as Brc100ExtendedCreateActionArgs,
          safeOriginator
        );

      case 'signAction':
        return this.walletEngine.signAction(
          params as unknown as SignActionArgs,
          safeOriginator
        );

      case 'listOutputs':
        return this.walletEngine.listOutputs(
          params as unknown as ListOutputsArgs,
          safeOriginator
        );

      case 'getPublicKey':
        return this.walletEngine.getPublicKey(
          params as unknown as GetPublicKeyArgs,
          safeOriginator
        );

      case 'createSignature':
        return this.walletEngine.createSignature(
          params as unknown as CreateSignatureArgs,
          safeOriginator
        );

      case 'getHeight':
        return this.walletEngine.getHeight(params, safeOriginator);

      case 'isAuthenticated': {
        try {
          return await this.walletEngine.isAuthenticated(params, safeOriginator);
        } catch {
          return { authenticated: false };
        }
      }
    }
  }

  /**
   * Handle a JSON-RPC 2.0 request payload (from WebView `onMessage` or direct bridge).
   */
  public async handleJsonRpcMessage(
    rawPayload: string | Brc100JsonRpcRequest,
    defaultOriginator = 'webview-dapp.local',
    options?: { skipInteractivePermission?: boolean }
  ): Promise<Brc100JsonRpcResponse> {
    let parsed: Brc100JsonRpcRequest;
    try {
      parsed =
        typeof rawPayload === 'string'
          ? (JSON.parse(rawPayload) as Brc100JsonRpcRequest)
          : rawPayload;
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    const rpcId = parsed?.id ?? null;
    const method = parsed?.method;

    if (!method || !SUPPORTED_METHODS.has(method)) {
      return {
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: -32601,
          message: `Unsupported BRC-100 WalletWire method: "${String(method)}"`,
        },
      };
    }

    try {
      const result = await this.dispatchMethod(
        method,
        parsed.params,
        parsed.originator ?? defaultOriginator,
        options
      );
      return {
        jsonrpc: '2.0',
        id: rpcId,
        result,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRejected = msg.toLowerCase().includes('rejected');
      return {
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: isRejected ? 4001 : -32000,
          message: msg,
        },
      };
    }
  }

  /**
   * Handle a deep-link URL such as:
   * - `nfcwallet://brc100?request=<base64-or-urlencoded-jsonrpc>`
   * - `nfcwallet://brc100?method=getHeight&originator=example.com&id=1`
   */
  public async handleDeepLinkUrl(
    url: string,
    options?: { skipInteractivePermission?: boolean }
  ): Promise<Brc100JsonRpcResponse | null> {
    const trimmed = url.trim();
    if (!/^(?:nfcwallet|brc100):\/\//i.test(trimmed)) {
      return null;
    }

    const qIndex = trimmed.indexOf('?');
    if (qIndex === -1) {
      return null;
    }

    const queryString = trimmed.slice(qIndex + 1);
    const params: Record<string, string> = {};
    for (const part of queryString.split('&')) {
      const eq = part.indexOf('=');
      if (eq !== -1) {
        const k = decodeURIComponent(part.slice(0, eq));
        const v = decodeURIComponent(part.slice(eq + 1));
        params[k] = v;
      }
    }

    if (params.request) {
      let jsonStr = params.request;
      if (!jsonStr.trim().startsWith('{')) {
        jsonStr = Buffer.from(jsonStr, 'base64').toString('utf8');
      }
      return this.handleJsonRpcMessage(
        jsonStr,
        params.originator ?? 'deeplink-dapp.local',
        options
      );
    }

    if (params.method) {
      const parsedParams = params.params
        ? (JSON.parse(params.params) as Record<string, unknown>)
        : {};
      return this.handleJsonRpcMessage(
        {
          jsonrpc: '2.0',
          id: params.id ?? `dl_${Date.now()}`,
          method: params.method as Brc100BridgeMethod,
          originator: params.originator ?? 'deeplink-dapp.local',
          params: parsedParams,
        },
        params.originator ?? 'deeplink-dapp.local',
        options
      );
    }

    return null;
  }

  /**
   * Returns the JavaScript injection script for an in-app React Native WebView
   * to expose `window.bsvWallet` implementing the BRC-100 WalletWire interface.
   */
  public getInjectedWebViewScript(originator = 'webview-dapp.local'): string {
    return `
      (function() {
        if (window.bsvWallet) return;
        var pending = {};
        var reqCounter = 0;
        window.addEventListener('message', function(event) {
          try {
            var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            if (data && data.jsonrpc === '2.0' && data.id !== undefined && pending[data.id]) {
              var handler = pending[data.id];
              delete pending[data.id];
              if (data.error) handler.reject(new Error(data.error.message || 'BRC-100 RPC Error'));
              else handler.resolve(data.result);
            }
          } catch (e) {}
        });
        function callBridge(method, params) {
          return new Promise(function(resolve, reject) {
            var id = 'brc100_' + (++reqCounter) + '_' + Date.now();
            pending[id] = { resolve: resolve, reject: reject };
            var payload = JSON.stringify({
              jsonrpc: '2.0',
              id: id,
              method: method,
              originator: ${JSON.stringify(originator)},
              params: params || {}
            });
            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
              window.ReactNativeWebView.postMessage(payload);
            } else {
              reject(new Error('ReactNativeWebView bridge unavailable'));
            }
          });
        }
        window.bsvWallet = {
          createAction: function(args) { return callBridge('createAction', args); },
          signAction: function(args) { return callBridge('signAction', args); },
          listOutputs: function(args) { return callBridge('listOutputs', args); },
          getPublicKey: function(args) { return callBridge('getPublicKey', args); },
          createSignature: function(args) { return callBridge('createSignature', args); },
          getHeight: function() { return callBridge('getHeight', {}); },
          isAuthenticated: function() { return callBridge('isAuthenticated', {}); }
        };
      })();
      true;
    `;
  }
}

export const brc100AppBridge = new Brc100AppBridge();
