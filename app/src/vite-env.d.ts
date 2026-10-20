declare module "*.css";
/** app/package.json's version, put in by Vite (vite.config.ts). */
declare const __APP_VERSION__: string;
/** A file Vite copies into the build, imported as its URL. */
declare module "*?url" { const url: string; export default url; }
