/// <reference types="vite/client" />

import type { AppApi } from './shared/contracts';

declare global {
  interface Window {
    novelCompiler: AppApi;
  }
}

export {};
