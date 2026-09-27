// Invitations: the code round-trips, a right secret admits once, a wrong one is refused, the owner counts as in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/index.ts";
import { acceptInvitation, createInvite, decodeInvite, encodeInvite, processInvites, sha256 } from "../src/invite.ts";

const me = { id: "7779", nick: "ege", kind: "phone", joinedAt: "" };

/** A bus whose repo is a map of files, plus a fake ntfy and GitHub collaborator API behind one fetch. */
function world() {
  const files = {}, topics = {}, calls = [];
  const bus = new Bus({ repo: "ege/chat", token: "t", fetch: async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    if (/collaborators\/ege$/i.test(url)) return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }); // what GitHub says for the owner
    if (/collaborators\/nobody-here$/.test(url)) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    if (/collaborators\//.test(url)) return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    return new Response("{}", { status: 404 });
  } });
  bus.commit = async (f) => { Object.assign(files, f); return "sha"; };
  bus.head = async () => "h";
  bus.tree = async () => Object.keys(files).map((p) => ({ path: p, sha: p }));
  bus.json = async (p) => JSON.parse(files[p]);
  const ntfy = async (url, init = {}) => {
    const topic = url.split("/")[3].split("?")[0];
    if (init.method === "POST") { (topics[topic] ??= []).push(init.body); return new Response("{}"); }
    return new Response((topics[topic] ?? []).map((m) => JSON.stringify({ event: "message", message: m })).join("\n"));
  };
  return { bus, files, topics, calls, ntfy };
}

test("an invite code survives the trip through a link and a pasted fragment", () => {
  const c = { r: "Ege-BULUT/opencommunicate-chat", i: "abc123defg", s: "s".repeat(24), t: "opencom-inv-xyz", n: "ege#7779" };
  const code = encodeInvite(c);
  assert.deepEqual(decodeInvite(`https://opencommunicate.vercel.app/app/#invite=${code}`), c);
  assert.deepEqual(decodeInvite(code), c);
  assert.equal(decodeInvite("https://example.com/#invite=garbage"), null);
  for (const r of ["../etc", "a/..", "a/.", "-x/y", "a/b/c"]) assert.equal(decodeInvite(encodeInvite({ ...c, r })), null, r);
  assert.equal(decodeInvite(encodeInvite({ ...c, t: "evil/topic" })), null);
});

test("the right secret admits the login once; a wrong secret is refused; the invite is then used up", async () => {
  const w = world();
  const { invite, link } = await createInvite(w.bus, me, { base: "https://x/app/" });
  const code = decodeInvite(link);
  assert.equal(invite.hash, await sha256(code.s));
  assert.ok(!JSON.stringify(w.files).includes(code.s), "the secret itself is not stored");
  await w.ntfy(`https://ntfy.sh/${code.t}`, { method: "POST", body: JSON.stringify({ kind: "claim", id: code.i, secret: "wrong", login: "mallory" }) });
  await w.ntfy(`https://ntfy.sh/${code.t}`, { method: "POST", body: JSON.stringify({ kind: "claim", id: code.i, secret: code.s, login: "ayse" }) });
  await w.ntfy(`https://ntfy.sh/${code.t}`, { method: "POST", body: JSON.stringify({ kind: "claim", id: code.i, secret: code.s, login: "someone-else" }) });
  assert.deepEqual(await processInvites(w.bus, me, w.ntfy), ["ayse"]);
  assert.ok(w.calls.some((c) => c.endsWith("/collaborators/ayse")) && !w.calls.some((c) => /mallory|someone-else/.test(c)));
  assert.equal(JSON.parse(w.files[`invites/${invite.id}.json`]).used.login, "ayse");
  const notes = w.topics[code.t].map((m) => JSON.parse(m));
  assert.ok(notes.some((n) => n.kind === "refused" && n.login === "mallory") && notes.some((n) => n.kind === "added" && n.login === "ayse"));
  assert.deepEqual(await processInvites(w.bus, me, w.ntfy), [], "used up");
});

test("the owner claiming an invite counts as admitted without asking GitHub; an unknown login is refused, not stuck", async () => {
  const w = world();
  const { link } = await createInvite(w.bus, me, { base: "https://x/app/" });
  const code = decodeInvite(link);
  const claim = (login) => w.ntfy(`https://ntfy.sh/${code.t}`, { method: "POST", body: JSON.stringify({ kind: "claim", id: code.i, secret: code.s, login }) });
  await claim("nobody-here");
  await claim("Ege");
  assert.deepEqual(await processInvites(w.bus, me, w.ntfy), ["Ege"]);
  assert.ok(!w.calls.some((c) => /collaborators\/Ege$/.test(c)), "no PUT for the owner");
  assert.ok(w.topics[code.t].map((m) => JSON.parse(m)).some((n) => n.kind === "refused" && n.login === "nobody-here" && /kullanıcı yok/.test(n.reason)));
});

test("the invitee accepts GitHub's pending invitation for that repo", async () => {
  const calls = [];
  let accepted = false;
  const f = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url.replace("https://api.github.com", "")}`);
    if (url.endsWith("/repos/ege/chat")) return new Response(accepted ? "{}" : JSON.stringify({ message: "Not Found" }), { status: accepted ? 200 : 404 });
    if (url.endsWith("/user/repository_invitations")) return new Response(JSON.stringify([{ id: 5, repository: { full_name: "other/repo" } }, { id: 9, repository: { full_name: "ege/chat" } }]));
    if (url.endsWith("/user/repository_invitations/9") && init.method === "PATCH") { accepted = true; return new Response(null, { status: 204 }); }
    return new Response("{}", { status: 404 });
  };
  assert.equal(await acceptInvitation("t", "ege/chat", f), true);
  assert.deepEqual(calls, ["GET /repos/ege/chat", "GET /user/repository_invitations", "PATCH /user/repository_invitations/9"]);
  assert.equal(await acceptInvitation("t", "ege/chat", f), true, "already in");
});

test("WhatsApp links take the number as people write it", async () => {
  const { whatsappLink } = await import("../src/invite.ts");
  for (const p of ["+90 507 526 25 27", "0507 526 2527", "905075262527", "0090 507 526 25 27"]) assert.ok(whatsappLink(p, "a b").startsWith("https://wa.me/905075262527?text=a%20b"), p);
});
