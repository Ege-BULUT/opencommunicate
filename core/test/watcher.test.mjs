// The watcher must not lose a message when GitHub's compare view comes back without it (seen after a push).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, Watcher } from "../src/index.ts";

const me = { id: "1111", nick: "me", kind: "agent" };
const peer = { id: "2222", nick: "peer", kind: "person" };
const msg = (id, text) => ({ id, channel: "dm-1111-2222", from: "2222", fromNick: "peer", text });
const old = msg("20260927T090000000Z-2222-aaaaaa", "old");
const lost = msg("20260927T090625000Z-2222-bbbbbb", "lost by compare");
const path = (m) => `channels/${m.channel}/${m.id}.json`;

function fakeBus(files) {
  const bus = new Bus({ repo: "x/y", token: "t" });
  let head = "c1";
  Object.assign(bus, {
    head: async () => head,
    headIfChanged: async () => head,
    devices: async () => [me, peer],
    groups: async () => [],
    tree: async () => Object.keys(files).map((p) => ({ path: p, sha: p })),
    json: async (sha) => files[sha],
    changes: async () => ({ messages: [], metaChanged: false, devicesChanged: false }), // compare lagging behind
    push: (m) => { files[path(m)] = m; head = `c${Object.keys(files).length}`; },
  });
  return bus;
}

test("a message compare missed arrives on the next reconcile, once", async () => {
  const bus = fakeBus({ [path(old)]: old });
  const w = new Watcher(bus, me);
  await w.start();
  bus.push(lost);
  const got = [];
  for (let i = 0; i < 24; i++) got.push(...(await w.tick()));
  assert.deepEqual(got.map((m) => m.text), ["lost by compare"]);
});

// `watch --once` exits and starts again: what arrived in between must be delivered by the next start.
function snapshotBus() {
  const bus = new Bus({ repo: "x/y", token: "t" });
  const snaps = { c1: { [path(old)]: old } };
  let head = "c1", etag = null;
  Object.assign(bus, {
    head: async () => head,
    headIfChanged: async () => (etag === head ? null : (etag = head)),
    devices: async () => [me, peer],
    groups: async () => [],
    tree: async (sha) => { if (!snaps[sha]) throw new Error("404"); return Object.keys(snaps[sha]).map((p) => ({ path: p, sha: p })); },
    json: async (sha) => Object.values(snaps).find((s) => s[sha])[sha],
    changes: async (from, to, _ch, seen) => ({ messages: Object.entries(snaps[to]).filter(([p]) => !snaps[from][p] && !seen.has(p)).map(([p, m]) => (seen.add(p), m)), metaChanged: false, devicesChanged: false }),
    push: (m) => { const next = `c${Object.keys(snaps).length + 1}`; snaps[next] = { ...snaps[head], [path(m)]: m }; head = next; },
  });
  return bus;
}

test("a watcher started from where the last one stopped delivers what came in between, once", async () => {
  const bus = snapshotBus();
  bus.push(lost);
  const w = new Watcher(bus, me);
  await w.start("c1");
  assert.deepEqual((await w.tick()).map((m) => m.text), ["lost by compare"]);
  assert.deepEqual(await w.tick(), []);
  assert.equal(w.head, "c2");
});

test("a head that is gone starts from now, without replaying history", async () => {
  const bus = snapshotBus();
  const w = new Watcher(bus, me);
  await w.start("gone");
  assert.equal(w.head, "c1");
  assert.deepEqual(await w.tick(), []);
});

// A notification arrives the moment the message is pushed, which is when compare can still miss it: the tick that
// sees the branch move reads the commit's tree instead of leaving it to the once-a-minute scan.
test("a message compare missed arrives on the tick that saw the branch move", async () => {
  const bus = fakeBus({ [path(old)]: old });
  const w = new Watcher(bus, me);
  await w.start();
  bus.push(lost);
  assert.deepEqual((await w.tick()).map((m) => m.text), ["lost by compare"]);
  assert.deepEqual(await w.tick(), []);
});

test("a full tick (pull to refresh) scans the tree even when the branch did not move", async () => {
  const files = { [path(old)]: old };
  const bus = fakeBus(files);
  const w = new Watcher(bus, me);
  await w.start();
  files[path(lost)] = lost; // in the tree, but the head reads the same
  assert.deepEqual(await w.tick(), []);
  assert.deepEqual((await w.tick(true)).map((m) => m.text), ["lost by compare"]);
});
