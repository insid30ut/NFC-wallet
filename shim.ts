import 'react-native-get-random-values';
import { Buffer } from 'buffer';
import processShim from 'process';

const globalScope = globalThis as unknown as {
  Buffer?: typeof Buffer;
  process?: Record<string, unknown> & { env?: Record<string, string | undefined> };
};

if (typeof globalScope.Buffer === 'undefined') {
  globalScope.Buffer = Buffer;
}

if (typeof globalScope.process === 'undefined') {
  globalScope.process = processShim as unknown as Record<string, unknown> & {
    env?: Record<string, string | undefined>;
  };
} else {
  for (const [key, value] of Object.entries(processShim)) {
    if (globalScope.process[key] === undefined) {
      globalScope.process[key] = value;
    }
  }
}

if (!globalScope.process.env) {
  globalScope.process.env = { NODE_ENV: __DEV__ ? 'development' : 'production' };
}
