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
