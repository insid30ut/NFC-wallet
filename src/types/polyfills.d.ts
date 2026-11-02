/* eslint-disable no-var */
declare var Buffer: typeof import('buffer').Buffer;
declare var HermesInternal: Record<string, unknown> | undefined;

declare module 'process' {
  export interface ProcessShim {
    env: Record<string, string | undefined>;
    version: string;
    browser?: boolean;
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
    cwd: () => string;
    [key: string]: unknown;
  }

  const processShim: ProcessShim;
  export default processShim;
}
