// The REST quota every device of an account shares: a commit is one GraphQL call, files read together are one GraphQL
// query, REST takes over whatever GraphQL can't do, and the quota GitHub reports is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGitHub, seeded } from "../../test/fakegh.mjs";
import { Bus, dmChannel } from "../src/index.ts";

const setUp = async () => {
  const gh = fakeGitHub();
  let down = false;
  const fetch = (u, i) => (down && String(u).endsWith("/graphql") ? Promise.resolve(new Response("", { status: 502 })) : gh.fetch(u, i));
  const { ege, agent } = await seeded(gh, { Bus });
  const bus = new Bus({ repo: "ege/team-chat", token: "t", fetch });
  gh.log.length = 0;
  return { gh, bus, ege, agent, dm: dmChannel(ege.id, agent.id), graphqlDown: (d) => { down = d; } };
};
const calls = (gh) => { const c = [...gh.log]; gh.log.length = 0; return c; };

test("a message is one GraphQL commit, and two at once both land", async () => {
  const { gh, bus, ege, agent, dm } = await setUp();
  await bus.send(dm, ege, "hello", []);
  const c = calls(gh);
  assert.equal(c.filter((x) => x === "POST /graphql").length, 1, c.join(", "));
  assert.ok(!c.some((x) => x.startsWith("POST /repos")), c.join(", "));
  await Promise.all([bus.send(dm, ege, "one", []), bus.send(dm, agent, "two", [])]);
  assert.deepEqual((await bus.history(dm)).map((m) => m.text).sort(), ["hello", "one", "two"]);
});

test("messages read together are one GraphQL query", async () => {
  const { gh, bus, ege, dm } = await setUp();
  for (let i = 0; i < 5; i++) await bus.send(dm, ege, `m${i}`, []);
  const reader = new Bus({ repo: "ege/team-chat", token: "t", fetch: gh.fetch });
  gh.log.length = 0;
  const all = await reader.history(dm);
  const c = calls(gh);
  assert.deepEqual(all.map((m) => m.text).sort(), ["m0", "m1", "m2", "m3", "m4"]);
  assert.equal(c.filter((x) => x === "POST /graphql").length, 1, c.join(", "));
  assert.ok(!c.some((x) => x.includes("/git/blobs/")), c.join(", "));
});

test("without GraphQL, REST does it all", async () => {
  const { gh, bus, ege, dm, graphqlDown } = await setUp();
  graphqlDown(true);
  await bus.send(dm, ege, "still sent", []);
  const reader = new Bus({ repo: "ege/team-chat", token: "t", fetch: (u, i) => (String(u).endsWith("/graphql") ? Promise.resolve(new Response("", { status: 502 })) : gh.fetch(u, i)) });
  assert.deepEqual((await reader.history(dm)).map((m) => m.text), ["still sent"]);
  assert.ok(calls(gh).some((x) => x.startsWith("GET /repos/ege/team-chat/git/blobs/")));
});

test("force pushes, new branches and big uploads go the REST way", async () => {
  const { gh, bus, ege } = await setUp();
  await bus.heartbeat(ege);
  assert.ok(!calls(gh).includes("POST /graphql"), "presence is rewritten (orphan)");
  await bus.commit({ "big.bin": new Uint8Array(3_000_000) }, "big");
  const c = calls(gh);
  assert.ok(!c.includes("POST /graphql") && c.includes("POST /repos/ege/team-chat/git/blobs"), c.join(", "));
});

test("the quota GitHub reports is kept, and each change is heard", async () => {
  const { gh, bus, ege, dm } = await setUp();
  const heard = [];
  bus.onQuota = (q) => heard.push(q.resource);
  gh.quota.core.used = 2600;
  await bus.send(dm, ege, "hi", []);
  assert.equal(bus.quota.core.limit, 5000);
  assert.ok(bus.quota.core.used > 2600);
  assert.ok(bus.quota.graphql.used >= 1);
  assert.ok(heard.includes("core") && heard.includes("graphql"));
  const n = heard.length;
  await bus.headIfChanged(); await bus.headIfChanged(); // the second is a 304: no change, nothing heard
  assert.equal(heard.length, n + 1);
});

// 0.9.8: what an hour of chatting costs. A branch that has not moved costs nothing to look at (304), a client
// following main reads new messages from GraphQL, and the side branches are read without REST trees.
import { Watcher, HEARTBEAT_MS } from "../src/index.ts";
import { processInvites } from "../src/invite.ts";
const rest = (c) => c.filter((x) => x !== "POST /graphql");

test("a head asked again with its ETag is free while the branch has not moved", async () => {
  const { gh, bus } = await setUp();
  const at = await bus.head();
  const used = gh.quota.core.used;
  assert.equal(await bus.head(), at);
  assert.equal(gh.quota.core.used, used, "the second answer is a 304");
});

test("a watcher reads a new message with no REST call but the head check", async () => {
  const { gh, bus, ege, agent, dm } = await setUp();
  const reader = new Bus({ repo: "ege/team-chat", token: "t", fetch: gh.fetch });
  const w = new Watcher(reader, agent);
  await w.start();
  calls(gh);
  const used = gh.quota.core.used;
  assert.deepEqual(await w.tick(), []);
  assert.equal(gh.quota.core.used, used, "nothing moved: free");
  await bus.send(dm, ege, "hello", []);
  calls(gh);
  assert.deepEqual((await w.tick()).map((m) => m.text), ["hello"]);
  assert.deepEqual(rest(calls(gh)), ["GET /repos/ege/team-chat/git/ref/heads/main"]);
});

test("a commit with no list of its files (an older client's) is read from the compare view", async () => {
  const { gh, bus, ege, agent, dm } = await setUp();
  const reader = new Bus({ repo: "ege/team-chat", token: "t", fetch: gh.fetch });
  const w = new Watcher(reader, agent);
  await w.start();
  const m = bus.newMessage(dm, ege, "from 0.9.7");
  const parent = gh.ref();
  const tree = await gh.fetch(`https://api.github.com/repos/ege/team-chat/git/commits/${parent}`).then((r) => r.json());
  const t = await gh.fetch("https://api.github.com/repos/ege/team-chat/git/trees", { method: "POST", body: JSON.stringify({ base_tree: tree.tree.sha, tree: [{ path: `channels/${dm}/${m.id}.json`, mode: "100644", type: "blob", content: JSON.stringify(m) }] }) }).then((r) => r.json());
  const c = await gh.fetch("https://api.github.com/repos/ege/team-chat/git/commits", { method: "POST", body: JSON.stringify({ message: "msg", tree: t.sha, parents: [parent] }) }).then((r) => r.json());
  await gh.fetch("https://api.github.com/repos/ege/team-chat/git/refs/heads/main", { method: "PATCH", body: JSON.stringify({ sha: c.sha }) });
  calls(gh);
  assert.deepEqual((await w.tick()).map((x) => x.text), ["from 0.9.7"]);
  assert.ok(calls(gh).some((x) => x.startsWith("GET /repos/ege/team-chat/compare/")));
});

test("receipts are written and read with no REST tree, and a heartbeat sends no blob", async () => {
  const { gh, bus, ege, agent, dm } = await setUp();
  await bus.markReceipts(agent, { [dm]: { read: "20261105T000000000Z-2082-aaaaaa" } });
  const w = new Watcher(new Bus({ repo: "ege/team-chat", token: "t", fetch: gh.fetch }), ege);
  calls(gh);
  await bus.markReceipts(agent, { [dm]: { read: "20261105T000000001Z-2082-aaaaaa" } });
  assert.deepEqual(rest(calls(gh)), ["GET /repos/ege/team-chat/git/ref/heads/receipts"]);
  assert.equal(await w.tickReceipts(), true);
  assert.equal(w.receipts["2082"][dm].read, "20261105T000000001Z-2082-aaaaaa");
  assert.deepEqual(rest(calls(gh)), ["GET /repos/ege/team-chat/git/ref/heads/receipts"]);
  await bus.heartbeat(agent, "testing");
  await bus.heartbeat(agent);
  const c = calls(gh);
  assert.ok(!c.includes("POST /repos/ege/team-chat/git/blobs"), c.join(", "));
  assert.ok(HEARTBEAT_MS < 10 * 60_000, "under the 10 minutes older apps count as online");
});

test("checking invites every 15 seconds costs nothing while none is open", async () => {
  const { gh, bus, ege } = await setUp();
  const head = await bus.head();
  const ntfy = () => { throw new Error("no invite is open: nothing to ask ntfy"); };
  await processInvites(bus, ege, ntfy, head);
  calls(gh);
  assert.deepEqual(await processInvites(bus, ege, ntfy, head), []);
  assert.deepEqual(calls(gh), []);
});

test("a program that starts often keeps heads and trees between runs", async () => {
  const { gh } = await setUp();
  const kept = new Map();
  const store = { get: (k) => kept.get(k) ?? null, set: (k, v) => kept.set(k, v) };
  const first = new Bus({ repo: "ege/team-chat", token: "t", fetch: gh.fetch, store });
  await first.tree(await first.head());
  const used = gh.quota.core.used;
  const next = new Bus({ repo: "ege/team-chat", token: "t", fetch: gh.fetch, store });
  await next.tree(await next.head());
  assert.equal(gh.quota.core.used, used, "a 304 and a kept tree");
});
