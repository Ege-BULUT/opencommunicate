/* Seeded geometric pictures for profiles: circles, squares, triangles, pentagons and rings from one palette,
   laid out by a small random generator. The same seed and palette always give the same picture, so a device
   only stores { seed, palette } and every client draws it. Output is a 100×100 SVG; the app rounds the corners. */

export type Palette = { id: string; name: string; colors: string[] };

// colors[0] is the background, the rest are the shapes
export const PALETTES: Palette[] = [
  { id: "deniz", name: "Deniz", colors: ["#0b3954", "#087e8b", "#bfd7ea", "#ff5a5f", "#f5d547"] },
  { id: "gunbatimi", name: "Gün batımı", colors: ["#2d1e2f", "#f46036", "#ff9f1c", "#e71d36", "#fdfffc"] },
  { id: "orman", name: "Orman", colors: ["#1b2d1f", "#4f772d", "#90a955", "#ecf39e", "#d4a373"] },
  { id: "neon", name: "Neon", colors: ["#10002b", "#ff006e", "#8338ec", "#3a86ff", "#06ffa5"] },
  { id: "kum", name: "Kum", colors: ["#f4ecd8", "#e07a5f", "#3d405b", "#81b29a", "#f2cc8f"] },
  { id: "buz", name: "Buz", colors: ["#e8f1f8", "#1d3557", "#457b9d", "#a8dadc", "#e63946"] },
  { id: "bauhaus", name: "Bauhaus", colors: ["#f2e9dc", "#d62828", "#003049", "#fcbf49", "#1a1a1a"] },
  { id: "gece", name: "Gece", colors: ["#0d1b2a", "#415a77", "#778da9", "#e0e1dd", "#ffb703"] },
];

export type Art = { seed: string; palette: string };

/** A 32-bit hash of the seed (FNV-1a), then mulberry32: small, fast, the same everywhere. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The palette a seed gets when none was picked. */
export const paletteFor = (seed: string) => PALETTES[Math.floor(rng(`palette:${seed}`)() * PALETTES.length)].id;

const r1 = (n: number) => Math.round(n * 10) / 10;

function polygon(sides: number, cx: number, cy: number, r: number, rot: number): string {
  const pts = Array.from({ length: sides }, (_, i) => {
    const a = rot + (i * 2 * Math.PI) / sides - Math.PI / 2;
    return `${r1(cx + r * Math.cos(a))},${r1(cy + r * Math.sin(a))}`;
  });
  return `<polygon points="${pts.join(" ")}"`;
}

export function artSvg({ seed, palette }: Art): string {
  const colors = (PALETTES.find((p) => p.id === palette) ?? PALETTES[0]).colors;
  const rand = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const ink = colors.slice(1);
  const shapes: string[] = [];
  // one large anchor shape, then 3–5 smaller ones, some of them rings
  const count = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) {
    const big = i === 0;
    const size = big ? 30 + rand() * 18 : 9 + rand() * 20;
    const cx = big ? 30 + rand() * 40 : 8 + rand() * 84;
    const cy = big ? 30 + rand() * 40 : 8 + rand() * 84;
    const rot = rand() * Math.PI * 2;
    const fill = pick(ink);
    const opacity = r1(big ? 1 : 0.7 + rand() * 0.3);
    const kind = pick(["circle", "square", "triangle", "pentagon", "ring"] as const);
    const paint = kind === "ring" ? `fill="none" stroke="${fill}" stroke-width="${r1(size * 0.28)}"` : `fill="${fill}"`;
    const s = r1(size);
    if (kind === "circle" || kind === "ring") shapes.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${kind === "ring" ? r1(s * 0.8) : s}" ${paint} opacity="${opacity}"/>`);
    else if (kind === "square") shapes.push(`<rect x="${r1(cx - s)}" y="${r1(cy - s)}" width="${r1(2 * s)}" height="${r1(2 * s)}" transform="rotate(${Math.round((rot * 180) / Math.PI)} ${r1(cx)} ${r1(cy)})" ${paint} opacity="${opacity}"/>`);
    else shapes.push(`${polygon(kind === "triangle" ? 3 : 5, cx, cy, s * 1.15, rot)} ${paint} opacity="${opacity}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${colors[0]}"/>${shapes.join("")}</svg>`;
}

export const artDataUrl = (a: Art) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artSvg(a))}`;
