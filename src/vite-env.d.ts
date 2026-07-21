/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Build channel marker. `dev` and `beta` select separate app identities and
   *  visible badges; unset/anything else = stable. Set by the matching Vite mode. */
  readonly VITE_PORTCODE_CHANNEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
