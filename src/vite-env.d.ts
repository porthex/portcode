/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build channel marker. `dev` = the self-dev build (separate data dir + a
   *  visible DEV badge); unset/anything else = the normal build. Set via
   *  `.env.selfdev`, loaded by Vite's `selfdev` mode. */
  readonly VITE_PORTCODE_CHANNEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
