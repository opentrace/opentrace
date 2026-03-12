declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  readonly VITE_ARCHIVE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
