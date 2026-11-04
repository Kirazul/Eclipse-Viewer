/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Pack base URL. Unset: `<base>packs` in dev, R2's public URL in production. */
  readonly PUBLIC_PACK_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
