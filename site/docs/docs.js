// Language button (shared "oc-lang" with the landing page) and the changelog's expand / collapse.
document.getElementById("langBtn")?.addEventListener("click", () => setLang(document.documentElement.lang === "tr" ? "en" : "tr"));
for (const b of document.querySelectorAll("[data-all]"))
  b.addEventListener("click", () => document.querySelectorAll("details.rel").forEach((d) => { d.open = b.dataset.all === "open"; }));
// changelog.html#0.5.0 opens that release in both languages and scrolls to it
function openFromHash() {
  const v = decodeURIComponent(location.hash.slice(1)).replace(/^(en|tr)-/, "");
  if (!v) return;
  const mine = document.getElementById(`${document.documentElement.lang}-${v}`);
  for (const l of ["en", "tr"]) { const d = document.getElementById(`${l}-${v}`); if (d) d.open = true; }
  mine?.scrollIntoView();
}
openFromHash();
window.addEventListener("hashchange", openFromHash);
