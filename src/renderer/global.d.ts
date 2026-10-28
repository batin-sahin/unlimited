import type { UnlimitedApi } from "../shared/types";

declare global {
  interface Window {
    unlimited: UnlimitedApi;
  }
}

export {};
