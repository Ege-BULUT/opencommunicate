// Reactions: one of four per account and message, kept on their own branch; reacting again replaces, null removes,
// and nothing changing makes no commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, Watcher, reactionsOn } from "../src/index.ts";

const m = { channel: "all", id: "20261014T080000000Z-2222-aaaaaa" };

/** A bus whose "reactions" branch is a map of stored files; counts commits. */
function fakeRepo() {
  const repo = { head: null, files: {}, commits: 0 };
  const bus = () => {
    const b = new Bus({ repo: "x/y", token: "t" });
    const seen = { head: undefined };
    Object.assign(b, {
      reactions: async () => ({ ...repo.files }),
      headIfChanged: async (branch) => { assert.equal(branch, "reactions"); if (repo.head === seen.head) return null; seen.head = repo.head; return repo.head; },
      commit: async (files, _msg, opts) => {
        assert.equal(opts.branch, "reactions", "reactions live on their own branch, not main");
        const out = await files(repo.head);
        for (const [path, text] of Object.entries(out)) repo.files[path.slice(10, -5)] = JSON.parse(text).reactions;
        repo.commits++; repo.head = `c${repo.commits}`;
        return repo.head;
      },
    });
    return b;
  };
  return { repo, bus };
}

test("react, replace, take back", async () => {
  const { repo, bus } = fakeRepo();
  const b = bus();
  const me = { id: "1111", nick: "me" }, you = { id: "2222", nick: "you" };
  assert.equal(await b.react(me, m, "👍"), true);
  assert.equal(await b.react(me, m, "👍"), false, "the same reaction again changes nothing");
  assert.equal(repo.commits, 1, "and makes no commit");
  await b.react(you, m, "👍");
  assert.deepEqual(reactionsOn(m, repo.files), [{ emoji: "👍", ids: ["1111", "2222"] }]);
  await b.react(me, m, "❤️");
  assert.deepEqual(reactionsOn(m, repo.files), [{ emoji: "👍", ids: ["2222"] }, { emoji: "❤️", ids: ["1111"] }], "one per account: a new one replaces the old");
  await b.react(me, m, null);
  assert.deepEqual(reactionsOn(m, repo.files), [{ emoji: "👍", ids: ["2222"] }]);
  assert.equal(await b.react(me, m, null), false, "taking back a reaction that is not there makes no commit");
  await assert.rejects(b.react(me, m, "🔥"), /one of/);
  assert.deepEqual(reactionsOn({ ...m, channel: "dm-1111-2222" }, repo.files), [], "the same id in another chat is another message");
});

test("a reaction reaches the other devices", async () => {
  const { bus } = fakeRepo();
  const me = { id: "1111", nick: "me", kind: "person", joinedAt: "" };
  const other = new Watcher(bus(), { ...me, id: "2222" });
  await bus().react(me, m, "🙂");
  assert.equal(await other.tickReactions(), true);
  assert.deepEqual(reactionsOn(m, other.reactions), [{ emoji: "🙂", ids: ["1111"] }]);
  assert.equal(await other.tickReactions(), false, "nothing to read while the branch has not moved");
});
