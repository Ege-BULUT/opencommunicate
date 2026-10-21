// In-memory GitHub (git data API subset) for the end-to-end tests. handle() is shared by the browser
// (Playwright route) and node Buses (fetch option), so both see one repository.
import crypto from "node:crypto";

export function fakeGitHub({ login = "ege", delay = () => 0 } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), refs = new Map();
  const sha = () => crypto.randomBytes(20).toString("hex");
  const log = [], tokens = new Set(), refreshes = [];
  let refreshToken = "r1";
  const res = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? "" : JSON.stringify(body) });
  const listing = (t) => [...(trees.get(t) ?? new Map())].map(([path, s]) => ({ path, sha: s, type: "blob", mode: "100644", size: Buffer.from(blobs.get(s) ?? "", "base64").length }));
  const ancestors = (c) => { const out = new Set(); const walk = (x) => { if (!x || out.has(x)) return; out.add(x); for (const p of commits.get(x)?.parents ?? []) walk(p); }; walk(c); return out; };

  async function handle(method, url, headers = {}, bodyText = "") {
    const u = new URL(url);
    const p = u.pathname;
    let body = {}; try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { /* a form */ }
    const hdr = (k) => headers[k] ?? headers[k.toLowerCase()];
    log.push(`${method} ${p}`);
    const wait = delay(method, p, body);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    tokens.add((hdr("Authorization") ?? "").replace("Bearer ", ""));
    if (p === "/user") return res(200, { login });
    if (p === "/login/oauth/access_token") {
      const f = new URLSearchParams(bodyText);
      refreshes.push(Object.fromEntries(f));
      if (f.get("refresh_token") !== refreshToken) return res(200, { error: "bad_refresh_token" });
      refreshToken = `r${refreshes.length + 1}`;
      return res(200, { access_token: `t${refreshes.length + 1}`, refresh_token: refreshToken, expires_in: 28800, refresh_token_expires_in: 15724800 });
    }
    let m = p.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!m) return res(404, { message: "Not Found" });
    const rest = m[2] ?? "";
    const m0 = m[1];
    if (!rest) return res(200, { full_name: m[1], private: true, permissions: { admin: false, push: true, pull: true } });
    const R = (b) => `${m0}#${b}`;
    if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const s = refs.get(R(m[1]));
      if (!s) return res(404, { message: "Not Found" });
      const etag = `"${s}"`;
      if (hdr("If-None-Match") === etag) return { status: 304, headers: { etag }, body: "" };
      return res(200, { ref: `refs/heads/${m[1]}`, object: { sha: s, type: "commit" } }, { etag, "cache-control": "private, max-age=60" });
    }
    if ((m = rest.match(/^\/git\/trees\/([0-9a-f]+)$/))) { const t = commits.get(m[1])?.tree ?? m[1]; return trees.has(t) ? res(200, { sha: t, tree: listing(t), truncated: false }) : res(404, { message: "Not Found" }); }
    if ((m = rest.match(/^\/git\/blobs\/([0-9a-f]+)$/))) return blobs.has(m[1]) ? res(200, { sha: m[1], content: blobs.get(m[1]), encoding: "base64" }) : res(404, { message: "Not Found" });
    if (rest === "/git/blobs" && method === "POST") {
      const content = body.encoding === "base64" ? body.content : Buffer.from(body.content).toString("base64");
      const s = crypto.createHash("sha1").update(content).digest("hex");
      blobs.set(s, content);
      return res(201, { sha: s });
    }
    if ((m = rest.match(/^\/git\/commits\/([0-9a-f]+)$/))) { const c = commits.get(m[1]); return c ? res(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((x) => ({ sha: x })) }) : res(404, { message: "Not Found" }); }
    if (rest === "/git/trees" && method === "POST") {
      const t = new Map(body.base_tree ? trees.get(body.base_tree) : []);
      for (const e of body.tree) { if (e.sha === null) t.delete(e.path); else t.set(e.path, e.sha); }
      const s = sha(); trees.set(s, t);
      return res(201, { sha: s });
    }
    if (rest === "/git/commits" && method === "POST") { const s = sha(); commits.set(s, { tree: body.tree, parents: body.parents ?? [], message: body.message }); return res(201, { sha: s }); }
    if ((m = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "PATCH") {
      const cur = refs.get(R(m[1]));
      if (!cur) return res(422, { message: "Reference does not exist" });
      if (!body.force && !ancestors(body.sha).has(cur)) return res(422, { message: "Update is not a fast forward" });
      refs.set(R(m[1]), body.sha);
      return res(200, { object: { sha: body.sha } });
    }
    if (rest === "/git/refs" && method === "POST") {
      const b = body.ref.replace("refs/heads/", "");
      if (refs.has(R(b))) return res(422, { message: "Reference already exists" });
      refs.set(R(b), body.sha);
      return res(201, { object: { sha: body.sha } });
    }
    if ((m = rest.match(/^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/))) {
      const a = trees.get(commits.get(m[1])?.tree) ?? new Map(), b = trees.get(commits.get(m[2])?.tree) ?? new Map();
      const files = [];
      for (const [path, s] of b) if (a.get(path) !== s) files.push({ filename: path, sha: s, status: a.has(path) ? "modified" : "added" });
      for (const [path, s] of a) if (!b.has(path)) files.push({ filename: path, sha: s, status: "removed" });
      return res(200, { files });
    }
    if ((m = rest.match(/^\/contents\/(.+)$/))) {
      const ref = u.searchParams.get("ref") ?? refs.get(R("main"));
      const t = trees.get(commits.get(ref)?.tree);
      const path = decodeURIComponent(m[1]);
      const s = t?.get(path);
      return s ? res(200, { path, sha: s, content: blobs.get(s), encoding: "base64" }) : res(404, { message: "Not Found" });
    }
    if (rest.startsWith("/releases")) return res(404, { message: "Not Found" });
    return res(404, { message: `Not Found (fake): ${method} ${rest}` });
  }

  /** A fetch for node Buses. */
  const fetch = async (url, init = {}) => {
    const r = await handle(init.method ?? "GET", String(url), init.headers ?? {}, init.body ?? "");
    return new Response(r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
  };
  /** Files at a branch head, as { path: text }. */
  const ref = (branch = "main", repo = [...refs.keys()][0]?.split("#")[0]) => refs.get(`${repo}#${branch}`);
  const files = (branch = "main", repo) => {
    const t = trees.get(commits.get(ref(branch, repo ?? [...refs.keys()].find((k) => k.endsWith(`#${branch}`))?.split("#")[0]))?.tree) ?? new Map();
    return Object.fromEntries([...t].map(([path, s]) => [path, Buffer.from(blobs.get(s), "base64").toString("utf8")]));
  };
  return { handle, fetch, files, ref, log, tokens, refreshes };
}

/** The fake as an HTTP server on 127.0.0.1 (a free port), for the CLI and the Android emulator. */
export async function serve(gh, port = 0) {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const r = await gh.handle(req.method, `https://api.github.com${req.url}`, req.headers, body);
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** A chat repository with ege-bulut#7779 (a person), claude-oc#2082 (an agent) and their group "Team". */
export async function seeded(gh, { Bus }) {
  const bus = new Bus({ repo: "ege/team-chat", token: "t", fetch: gh.fetch });
  const ege = { id: "7779", nick: "ege-bulut", kind: "person", login: "ege", joinedAt: "2026-10-01T00:00:00.000Z" };
  const agent = { id: "2082", nick: "claude-oc", kind: "agent", login: "ege", joinedAt: "2026-10-01T00:00:00.000Z" };
  await bus.commit({ "opencommunicate.json": JSON.stringify({ protocol: 1, name: "team-chat", createdAt: "2026-10-01T00:00:00.000Z" }), "devices/7779.json": JSON.stringify(ege), "devices/2082.json": JSON.stringify(agent), "channels/all/.keep": "" }, "setup");
  const team = await bus.createGroup("Team", ["2082"], ege);
  return { bus, ege, agent, team };
}
