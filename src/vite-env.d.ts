/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WB_TOKEN?: string;
  readonly VITE_OZON_CLIENT_ID?: string;
  readonly VITE_OZON_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
