declare module "*.css";
/** app/package.json's version, put in by Vite (vite.config.ts). */
declare const __APP_VERSION__: string;
/** Each version's changelog items by language (vite.config.ts): { en: { "0.9.7": [{ title, text }] } }. */
declare const __NEWS__: Record<string, Record<string, { title: string; text: string }[]>>;
/** A file Vite copies into the build, imported as its URL. */
declare module "*?url" { const url: string; export default url; }
