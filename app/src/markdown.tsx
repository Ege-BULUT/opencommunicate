import { Fragment, useMemo, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";
import { openLink } from "./platform.ts";

/** A message's text: links open outside the app, and a fenced block (```lang … ```) shows as what it holds:
 *  ```md as Markdown (tables too), any other as code. Nothing in a message ever becomes HTML: Markdown is parsed
 *  to tokens and drawn here, and HTML written in it shows as text. */
export function MessageText({ text }: { text: string }) {
  const parts = useMemo(() => fences(text), [text]);
  return <>{parts.map((p, i) => typeof p === "string" ? <Fragment key={i}>{linkify(p)}</Fragment>
    : MARKDOWN.has(p.lang) ? <Markdown key={i} src={p.body} /> : <Code key={i} text={p.body} />)}</>;
}

const MARKDOWN = new Set(["md", "markdown"]);
type Fence = { lang: string; body: string };

/** Text and the fenced blocks in it, in order; a block left open stays text. */
export function fences(text: string): (string | Fence)[] {
  const out: (string | Fence)[] = [];
  const re = /^(`{3,})[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)\n?^\1[ \t]*$\n?/gm; // closed by as many backticks: ```` can hold ```
  let at = 0;
  for (let m; (m = re.exec(text)); at = re.lastIndex) {
    const before = text.slice(at, m.index).replace(/\n$/, "");
    if (before) out.push(before);
    out.push({ lang: m[2].toLowerCase(), body: m[3] });
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Web addresses (https://… or www.…) in plain text, as links. A full stop, comma or closing bracket right after
 *  one ends the sentence, not the address (a bracket the address opened stays in it). */
function linkify(text: string): ReactNode[] {
  return text.split(/((?:https?:\/\/|www\.)[^\s<>]+)/gi).flatMap((part, i) => {
    if (i % 2 === 0) return part ? [part] : [];
    let url = part;
    while (/[.,;:!?'"»…)\]}]$/.test(url) && !(url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0))) url = url.slice(0, -1);
    const rest = part.slice(url.length);
    return [<Link key={i} href={/^www\./i.test(url) ? `https://${url}` : url}>{url}</Link>, ...(rest ? [rest] : [])];
  });
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} onClick={(e) => { e.preventDefault(); openLink(href); }}>{children}</a>;
}

/** Wide tables and long lines scroll sideways inside the bubble instead of widening it. */
function Code({ text }: { text: string }) {
  return <div className="scroll-x"><pre className="code"><code>{text}</code></pre></div>;
}

function Markdown({ src }: { src: string }) {
  const tokens = useMemo(() => new Lexer({ gfm: true }).lex(src), [src]);
  return <div className="md">{blocks(tokens)}</div>;
}

const blocks = (tokens: Token[]): ReactNode[] => tokens.map(block);

function block(t: Token, k: number): ReactNode {
  switch (t.type) {
    case "space": return null;
    case "heading": { const H = `h${Math.min(t.depth + 2, 6)}` as "h3"; return <H key={k}>{inline(t.tokens)}</H>; } // # is still small in a bubble
    case "paragraph": return <p key={k}>{inline(t.tokens)}</p>;
    case "text": return <Fragment key={k}>{t.tokens ? inline(t.tokens) : t.text}</Fragment>; // a tight list's item
    case "blockquote": return <blockquote key={k}>{blocks(t.tokens ?? [])}</blockquote>;
    case "code": return <Code key={k} text={t.text} />;
    case "hr": return <hr key={k} />;
    case "list": {
      const L = t.ordered ? "ol" : "ul";
      return <L key={k} start={t.ordered && t.start !== 1 ? Number(t.start) : undefined} className={t.items.some((i: Tokens.ListItem) => i.task) ? "tasks" : undefined}>
        {t.items.map((item: Tokens.ListItem, j: number) => <li key={j}>{blocks(item.tokens)}</li>)}
      </L>;
    }
    case "checkbox": return <input key={k} type="checkbox" checked={t.checked} disabled />;
    case "table": {
      const cell = (c: Tokens.TableCell, j: number, Tag: "th" | "td") => <Tag key={j} style={{ textAlign: c.align ?? undefined }}>{inline(c.tokens)}</Tag>;
      return <div key={k} className="scroll-x"><table>
        <thead><tr>{t.header.map((c: Tokens.TableCell, j: number) => cell(c, j, "th"))}</tr></thead>
        <tbody>{t.rows.map((r: Tokens.TableCell[], j: number) => <tr key={j}>{r.map((c, n) => cell(c, n, "td"))}</tr>)}</tbody>
      </table></div>;
    }
    default: return <p key={k}>{t.raw}</p>; // HTML and anything else: as written
  }
}

function inline(tokens: Token[] = []): ReactNode[] {
  return tokens.map((t, k) => {
    switch (t.type) {
      case "strong": return <strong key={k}>{inline(t.tokens)}</strong>;
      case "em": return <em key={k}>{inline(t.tokens)}</em>;
      case "del": return <del key={k}>{inline(t.tokens)}</del>;
      case "codespan": return <code key={k}>{t.text}</code>;
      case "br": return <br key={k} />;
      case "text": return <Fragment key={k}>{t.tokens ? inline(t.tokens) : t.text}</Fragment>;
      case "escape": return <Fragment key={k}>{t.text}</Fragment>;
      // a web link opens outside the app; an image is a link too (loading it would tell its server who read the message)
      case "link": case "image": return /^https?:\/\//i.test(t.href) ? <Link key={k} href={t.href}>{t.type === "link" ? inline(t.tokens) : t.text || t.href}</Link> : <Fragment key={k}>{t.raw}</Fragment>;
      default: return <Fragment key={k}>{t.raw}</Fragment>;
    }
  });
}
