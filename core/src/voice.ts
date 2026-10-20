/* Reading a message aloud: a message is split into runs of Turkish and English, so each is spoken by a voice
   of its own language, and English terms inside a Turkish sentence ("vercel'e deploy ettim") keep their
   English pronunciation. No model, no dictionary: Turkish letters, English spelling patterns and a short list
   of tech words decide.
   ponytail: heuristic + word list; a character-trigram classifier if mislabelled words pile up. */

export type Lang = "tr" | "en";
export type Run = { lang: Lang; text: string };

const TR_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;
// letters and letter pairs Turkish spelling never uses
const EN_MARKS = /[qwx]|th|sh|ch|ck|ph|gh|ee|oo|ou|ea|tion$|ing$/i;
const TECH = new Set(("vercel claude gpt openai anthropic gemini copilot deploy deployed commit commits merge merged rebase " +
  "build release branch push pushed pull request review issue api sdk cli url json yaml token bug fix feature " +
  "code script react vite node npm electron capacitor android ios github gitlab git docker server client cache login " +
  "logout frontend backend database prompt chat app web online offline update upgrade download upload agent " +
  "agents session hook hooks mcp repo repository workflow pipeline config setup debug log logs error mac macos " +
  "windows linux terminal shell bash python typescript javascript google apple microsoft slack discord whatsapp " +
  "telegram notion figma linear jira stripe aws azure firebase supabase sentry cursor ok okay")
  .split(" "));
// short Turkish words that may be written in capitals, and are not acronyms
const TR_CAPS = new Set(["VE", "BU", "DA", "DE", "NE", "O", "BEN", "SEN", "AMA", "YA", "MI", "Mİ", "EVET", "HAYIR", "TAMAM", "YOK", "VAR", "ŞU"]);
// endings only Turkish words have (-lar, -dım and the like also end English words: dollar, quantum)
const TR_ENDINGS = /(iyor|[ıuü]yor|m[ıiuü]ş|[ae]c[ae]k)$/i;
const TR_WORDS = new Set(["ve", "bir", "bu", "şu", "için", "ile", "de", "da", "mi", "ne", "çok", "ama", "gibi", "daha", "var", "yok", "sonra", "tamam", "evet", "hayır", "ben", "sen", "biz", "bence", "şimdi", "neden", "nasıl", "olur", "olarak", "kadar"]);
const TR_TOO = new Set(["a", "on"]); // English words that are Turkish words too ("on" is ten)
const EN_WORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "to", "of", "and", "you", "i", "it", "in", "on", "for", "this", "that", "with", "be", "have", "has", "do", "does", "did", "not", "can", "will", "my", "your", "we", "they", "what", "how", "why", "when", "please", "thanks", "yes", "no", "if", "or", "but"]);

const english = (w: string) =>
  TECH.has(w.toLowerCase()) ||
  (EN_WORDS.has(w.toLowerCase()) && !TR_TOO.has(w.toLowerCase())) || // "the", "is" inside a Turkish message
  (/^[A-Z]{2,6}\d*$/.test(w) && !TR_CAPS.has(w)) || // an acronym: GPT, API, PR, GPT4
  /[a-z][A-Z]/.test(w) ||                            // camelCase, OpenCommunicate
  (/\d/.test(w) && /\p{L}/u.test(w)) ||              // v8, gpt4o (a plain number is read in the sentence's language)
  EN_MARKS.test(w);

/** The language a message is mostly in: whichever has more words only it uses. */
export function baseLang(text: string): Lang {
  const words = text.match(/[\p{L}]+/gu) ?? [];
  const tr = words.filter((w) => TR_LETTERS.test(w) || TR_WORDS.has(w.toLocaleLowerCase("tr")) || TR_ENDINGS.test(w)).length;
  const en = words.filter((w) => EN_WORDS.has(w.toLowerCase())).length;
  return tr > en ? "tr" : "en";
}

/** A message as runs to speak, each in one language. Code blocks are named, not read; a link is read as its site. */
export function speechRuns(text: string): Run[] {
  const base = baseLang(text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g, " "));
  const prepared = text
    .replace(/```[\s\S]*?```/g, ` ${base === "tr" ? "kod bloğu" : "code block"} `)
    .replace(/https?:\/\/[^\s/]+\S*/g, (u) => { try { return ` ${new URL(u).hostname.replace(/^www\./, "")} `; } catch { return " "; } });
  // inline code, a file or site name, a word (with a Turkish suffix after an apostrophe), anything else
  const re = /(`[^`]*`)|((?:[\p{L}\d_-]+\.)+[a-z]{2,6}\b(?:\/\S*)?)|([\p{L}\d]+)(?:['’]([\p{L}]+))?|([^\p{L}\d`]+)/gu;
  const out: Run[] = [];
  const push = (lang: Lang, t: string) => {
    const last = out.at(-1);
    if (last && (last.lang === lang || !/[\p{L}\d]/u.test(t))) last.text += t; // spaces and punctuation join the run they follow
    else out.push({ lang, text: t });
  };
  for (const m of prepared.matchAll(re)) {
    if (m[1]) push("en", ` ${m[1].slice(1, -1)} `);
    else if (m[2]) push("en", m[2]);
    else if (m[3]) {
      const lang = TR_LETTERS.test(m[3]) ? "tr" : english(m[3]) ? "en" : base;
      if (m[4] && lang === "en") { push("en", m[3]); push("tr", ` ${m[4]}`); } // vercel'e: "vercel" in English, "e" in Turkish
      else push(lang, m[0]);
    } else if (m[5]) push(base, m[5]);
  }
  return out.map((r) => ({ lang: r.lang, text: r.text.replace(/\s+/g, " ").trim() })).filter((r) => /[\p{L}\d]/u.test(r.text));
}
