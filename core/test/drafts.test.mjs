// Drafts: per account and chat, an empty text clears one, other chats' drafts survive a write, orphan commits on
// their own branch, and no commit when nothing changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, Watcher } from "../src/index.ts";

function fakeRepo() {
  const repo = { head: null, files: {}, commits: 0, opts: null };
  const bus = () => {
    const b = new Bus({ repo: "x/y", token: "t" });
    const seen = { head: undefined };
    Object.assign(b, {
      drafts: async (me) => repo.files[me] ?? {},
      headIfChanged: async (branch) => { assert.equal(branch, "drafts"); if (repo.head === seen.head) return null; seen.head = repo.head; return repo.head; },
      commit: async (files, _m, opts) => {
        repo.opts = opts;
        const out = await files(repo.head);
        for (const [path, text] of Object.entries(out)) repo.files[path.slice(7, -5)] = JSON.parse(text).drafts;
        repo.commits++; repo.head = `c${repo.commits}`;
        return repo.head;
      },
    });
    return b;
  };
  return { repo, bus };
}

test("save, keep the other chats, clear", async () => {
  const { repo, bus } = fakeRepo();
  const b = bus(), me = { id: "1111", nick: "me" };
  let d = await b.setDrafts(me, { all: "half a thought" });
  assert.deepEqual(Object.keys(d), ["all"]);
  assert.deepEqual(repo.opts, { branch: "drafts", orphan: true }, "own branch, no history");
  d = await b.setDrafts(me, { "dm-1111-2222": "see you" });
  assert.deepEqual(Object.keys(d).sort(), ["all", "dm-1111-2222"], "a draft in another chat stays");
  assert.equal(d.all.text, "half a thought");
  await b.setDrafts(me, { all: "half a thought" });
  assert.equal(repo.commits, 2, "the same text again makes no commit");
  d = await b.setDrafts(me, { all: "  " });
  assert.deepEqual(Object.keys(d), ["dm-1111-2222"], "an empty text clears the draft");
  await b.setDrafts(me, { all: "" });
  assert.equal(repo.commits, 3, "clearing a draft that is not there makes no commit");
  assert.ok(Date.parse(d["dm-1111-2222"].at));
});

test("a draft typed on the phone shows on the desktop of the same account only", async () => {
  const { bus } = fakeRepo();
  const me = { id: "1111", nick: "me", kind: "person", joinedAt: "" };
  const desktop = new Watcher(bus(), me), other = new Watcher(bus(), { ...me, id: "2222" });
  await bus().setDrafts(me, { all: "from the phone" });
  assert.equal(await desktop.tickDrafts(), true);
  assert.equal(desktop.drafts.all.text, "from the phone");
  assert.equal(await desktop.tickDrafts(), false);
  await other.tickDrafts();
  assert.deepEqual(other.drafts, {}, "another account does not see them");
});
