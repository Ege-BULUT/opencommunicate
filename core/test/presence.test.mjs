// Presence: a heartbeat keeps the status it has, a status is set and cleared, and the watcher picks it up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, Watcher } from "../src/index.ts";

function fakeBus() {
  const files = {};
  let head = null, n = 0;
  const bus = new Bus({ repo: "x/y", token: "t" });
  Object.assign(bus, {
    head: async () => head,
    headIfChanged: async () => head,
    tree: async () => Object.keys(files).map((path) => ({ path, sha: `${path}@${files[path]}`, type: "blob" })),
    json: async (sha) => JSON.parse(sha.slice(sha.indexOf("@") + 1)),
    commit: async (change, _m, opts) => {
      assert.deepEqual(opts, { branch: "presence", orphan: true });
      Object.assign(files, await change(head));
      head = `c${++n}`;
      return head;
    },
  });
  return { bus, files };
}

const me = { id: "2082", nick: "claude-oc" };

test("a status is set, kept by heartbeats, and cleared", async () => {
  const { bus, files } = fakeBus();
  await bus.heartbeat(me);
  assert.equal(JSON.parse(files["presence/2082.json"]).status, undefined);
  await bus.heartbeat(me, "  deploying\n0.8.5 to vercel ");
  assert.equal(JSON.parse(files["presence/2082.json"]).status, "deploying 0.8.5 to vercel", "one line");
  await bus.heartbeat(me);
  assert.equal((await bus.presence())["2082"].status, "deploying 0.8.5 to vercel", "a plain heartbeat keeps it");
  assert.ok(Date.parse((await bus.presence())["2082"].lastSeen));
  await bus.heartbeat(me, "x".repeat(300));
  assert.equal(JSON.parse(files["presence/2082.json"]).status.length, 100);
  await bus.heartbeat(me, "");
  assert.deepEqual(Object.keys((await bus.presence())["2082"]), ["lastSeen"], "cleared");
});

test("the watcher's tickPresence brings statuses", async () => {
  const { bus } = fakeBus();
  const w = new Watcher(bus, { ...me, id: "7779", kind: "person", joinedAt: "" });
  await bus.heartbeat(me, "reviewing PR 26");
  assert.equal(await w.tickPresence(), true);
  assert.equal(w.presence["2082"].status, "reviewing PR 26");
});
