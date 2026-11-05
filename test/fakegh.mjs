// In-memory GitHub (git data API subset, and the GraphQL the core uses: blobs by oid, files and folders by
// expression, a commit's history, createCommitOnBranch) for the
// end-to-end tests. handle() is shared by the browser (Playwright route) and node Buses (fetch option), so both see one
// repository. Answers carry GitHub's quota headers; `quota` sets where they stand.
import crypto from "node:crypto";

export function fakeGitHub({ login = "ege", delay = () => 0 } = {}) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), refs = new Map();
  const sha = () => crypto.randomBytes(20).toString("hex");
  const log = [], tokens = new Set(), refreshes = [];
  // GitHub Apps (the agents' own quota): codes the manifest page would get, the app made from one, its install
  const app = { codes: new Set(), made: null, installed: false, key: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }) };
  const asApp = (h) => {
    const [head, payload, sig] = (h ?? "").replace("Bearer ", "").split(".");
    if (!sig || !app.made) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return crypto.verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), app.key.publicKey, Buffer.from(sig, "base64url")) && claims.iss === String(app.made.id) && claims.exp > Date.now() / 1000;
  };
  // ntfy (invites, the app's setup): topic → messages, as ntfy's JSON poll gives them
  const ntfy = new Map();
  let refreshToken = "r1";
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const quota = { core: { used: 0, limit: 5000, reset }, graphql: { used: 0, limit: 5000, reset } };
  let resource = "core";
  const res = (status, body, headers = {}) => {
    const q = quota[resource];
    if (status !== 304) q.used++;
    return { status, headers: { "content-type": "application/json", "x-ratelimit-resource": resource, "x-ratelimit-limit": String(q.limit), "x-ratelimit-used": String(q.used), "x-ratelimit-remaining": String(q.limit - q.used), "x-ratelimit-reset": String(q.reset), ...headers }, body: body === undefined ? "" : JSON.stringify(body) };
  };
  const listing = (t) => [...(trees.get(t) ?? new Map())].map(([path, s]) => ({ path, sha: s, type: "blob", mode: "100644", size: Buffer.from(blobs.get(s) ?? "", "base64").length }));
  const ancestors = (c) => { const out = new Set(); const walk = (x) => { if (!x || out.has(x)) return; out.add(x); for (const p of commits.get(x)?.parents ?? []) walk(p); }; walk(c); return out; };

  async function handle(method, url, headers = {}, bodyText = "") {
    let m0;
    const u = new URL(url);
    const p = u.pathname;
    let body = {}; try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { /* a form */ }
    const hdr = (k) => headers[k] ?? headers[k.toLowerCase()];
    log.push(`${method} ${p}`);
    const wait = delay(method, p, body);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    tokens.add((hdr("Authorization") ?? "").replace("Bearer ", ""));
    resource = p === "/graphql" ? "graphql" : "core";
    if (p === "/graphql") return graphql(body.query ?? "", body.variables ?? {});
    if (p === "/user") return res(200, { login });
    if ((m0 = p.match(/^\/ntfy\/([\w-]+)(\/json)?$/))) {
      const list = ntfy.get(m0[1]) ?? ntfy.set(m0[1], []).get(m0[1]);
      if (method === "POST") { list.push({ time: Math.floor(Date.now() / 1000), event: "message", message: bodyText }); return { status: 200, headers: {}, body: "{}" }; }
      const since = Number(u.searchParams.get("since")) || 0;
      return { status: 200, headers: {}, body: list.filter((x) => x.time >= since).map((x) => JSON.stringify(x)).join("\n") };
    }
    if ((m0 = p.match(/^\/app-manifests\/([\w-]+)\/conversions$/)) && method === "POST") {
      if (!app.codes.delete(m0[1])) return res(404, { message: "Not Found" });
      app.made = { id: 4242, slug: "opencommunicate-agents-test", owner: { login }, pem: app.key.privateKey.export({ type: "pkcs8", format: "pem" }) };
      return res(201, app.made);
    }
    if ((m0 = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && method === "POST") {
      if (!asApp(hdr("Authorization")) || !app.installed || m0[1] !== "99") return res(401, { message: "A JSON web token could not be decoded" });
      app.tokens = (app.tokens ?? 0) + 1;
      return res(201, { token: `inst-${app.tokens}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), repositories: body.repositories });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/installation$/.test(p) && asApp(hdr("Authorization"))) return app.installed ? res(200, { id: 99 }) : res(404, { message: "Not Found" });
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
    m0 = m[1];
    if (!rest) return res(200, { full_name: m[1], private: true, permissions: { admin: false, push: true, pull: true } });
    const R = (b) => `${m0}#${b}`;
    if ((m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const s = refs.get(R(m[1]));
      if (!s) return res(404, { message: "Not Found" });
      const etag = `"${s}"`;
      if (hdr("If-None-Match") === etag) return res(304, undefined, { etag });
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
      for (const e of body.tree) {
        if (e.sha === null) t.delete(e.path);
        else if (typeof e.content === "string") { const content = Buffer.from(e.content).toString("base64"), b = crypto.createHash("sha1").update(content).digest("hex"); blobs.set(b, content); t.set(e.path, b); }
        else t.set(e.path, e.sha);
      }
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
      if (!commits.has(m[1]) || !commits.has(m[2])) return res(404, { message: "Not Found" });
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

  function graphql(query, v) {
    const failed = (type, message) => res(200, { data: null, errors: [{ type, message }] });
    if (query.includes("createCommitOnBranch")) {
      const i = v.input, key = `${i.branch.repositoryNameWithOwner}#${i.branch.branchName}`, cur = refs.get(key);
      if (!cur) return failed("NOT_FOUND", `Could not resolve to a ref named ${i.branch.branchName}`);
      if (cur !== i.expectedHeadOid) return failed("STALE_DATA", `Expected branch to point to "${i.expectedHeadOid}" but it did not.  Pull and try again.`);
      const t = new Map(trees.get(commits.get(cur).tree));
      for (const d of i.fileChanges?.deletions ?? []) { if (!t.delete(d.path)) return failed("NOT_FOUND", `A path was requested for deletion which does not exist as of commit oid \`${cur}\``); }
      for (const a of i.fileChanges?.additions ?? []) { const b = crypto.createHash("sha1").update(a.contents).digest("hex"); blobs.set(b, a.contents); t.set(a.path, b); }
      const ts = sha(), cs = sha();
      trees.set(ts, t); commits.set(cs, { tree: ts, parents: [cur], message: i.message.body ? `${i.message.headline}\n\n${i.message.body}` : i.message.headline }); refs.set(key, cs);
      return res(200, { data: { createCommitOnBranch: { commit: { oid: cs } } } });
    }
    const repository = {};
    const blob = (oid) => ({ oid, text: Buffer.from(blobs.get(oid), "base64").toString("utf8"), isBinary: false, isTruncated: false });
    for (const [, alias, oid] of query.matchAll(/(\w+): object\(oid: "([0-9a-f]+)"\)/g)) repository[alias] = blobs.has(oid) ? blob(oid) : null;
    // "<commit>:<path>": a file, or a folder's files
    const at = (expr) => {
      const [c, path] = [expr.slice(0, expr.indexOf(":")), expr.slice(expr.indexOf(":") + 1)];
      const t = trees.get(commits.get(c)?.tree);
      if (!t) return null;
      if (t.has(path)) return blob(t.get(path));
      const entries = [...t].filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/")).map(([p, oid]) => ({ name: p.slice(path.length + 1), oid, type: "blob", object: blob(oid) }));
      return entries.length ? { oid: sha(), entries } : null;
    };
    for (const [, alias, expr] of query.matchAll(/(\w+): object\(expression: ("(?:[^"\\]|\\.)*")\)/g)) repository[alias] = at(JSON.parse(expr));
    if (query.includes("object(expression: $e)")) repository.object = at(v.e);
    if (query.includes("history(")) {
      const nodes = [];
      for (let c = v.to; c && nodes.length < 50; c = commits.get(c)?.parents[0]) nodes.push({ oid: c, message: commits.get(c)?.message ?? "" });
      repository.object = commits.has(v.to) ? { history: { nodes } } : null;
    }
    return res(200, { data: { repository } });
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
  return { handle, fetch, files, ref, log, tokens, refreshes, quota, app, ntfy };
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
