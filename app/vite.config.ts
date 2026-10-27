import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import fs from "node:fs";
import pkg from "./package.json" with { type: "json" };

/** What each recent version brought, in each language, from the site's changelog (one place to write it): for the
 *  "updated" note the app shows after an update. */
function news() {
  const html = fs.readFileSync(new URL("../site/docs/changelog.html", import.meta.url), "utf8");
  const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const out: Record<string, Record<string, { title: string; text: string }[]>> = {};
  for (const [, lang, v, body] of html.matchAll(/<details class="rel" id="(en|tr)-(\d+\.\d+\.\d+)"[^>]*>([\s\S]*?)<\/details>/g)) {
    if (Object.keys(out[lang] ?? {}).length >= 5) continue; // newest first: the last five cover an update
    (out[lang] ??= {})[v] = [...body.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, li]) => {
      const b = li.match(/^\s*<b>([\s\S]*?)<\/b>/);
      return { title: b ? text(b[1]) : "", text: text(b ? li.slice(b[0].length) : li) };
    });
  }
  return out;
}

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __NEWS__: JSON.stringify(news()) },
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { fs: { allow: [".."] } },
});
