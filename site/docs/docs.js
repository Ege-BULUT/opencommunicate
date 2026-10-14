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

// Phones: the page list is a drawer. The menu button opens it; the shade, Escape, or a link closes it.
const menu = document.getElementById("menuBtn");
if (menu) {
  const scrim = document.body.appendChild(Object.assign(document.createElement("div"), { className: "scrim" }));
  const set = (open) => { document.body.classList.toggle("nav-open", open); menu.setAttribute("aria-expanded", String(open)); };
  menu.addEventListener("click", () => set(!document.body.classList.contains("nav-open")));
  scrim.addEventListener("click", () => set(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
  document.getElementById("docsNav")?.addEventListener("click", (e) => { if (e.target.closest("a")) set(false); });
  matchMedia("(min-width: 821px)").addEventListener("change", (e) => { if (e.matches) set(false); });
}
