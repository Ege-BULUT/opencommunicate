// Editing and deleting: only the author, old text kept on an edit, content and own attachments gone on a delete,
// and a notice in the same commit naming the message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, isEditNotice, msgPath } from "../src/index.ts";

const me = { id: "1111", nick: "me", kind: "person", joinedAt: "" };
const you = { ...me, id: "2222", nick: "you" };
const ch = "dm-1111-2222";

/** A bus over a map of files; commit runs the change function against it, like one GitHub head. */
function fakeBus(files) {
  const bus = new Bus({ repo: "x/y", token: "t" });
  const commits = [];
  Object.assign(bus, {
    readJson: async (path) => (path in files ? JSON.parse(files[path]) : null),
    commit: async (change, message) => {
      const out = await change("head");
      for (const [p, c] of Object.entries(out)) { if (c === null) delete files[p]; else files[p] = c; }
      commits.push({ message, paths: Object.keys(out) });
      return "c";
    },
  });
  return { bus, commits };
}

const original = { v: 1, id: "20261014T100000000Z-1111-aaaaaa", channel: ch, from: "1111", fromNick: "me", ts: "2026-10-14T10:00:00.000Z", text: "helo",
  files: [{ name: "a.png", path: `channels/${ch}/files/20261014T100000000Z-1111-aaaaaa-a.png`, size: 3 }, { name: "fwd.png", path: "channels/all/files/OTHER-fwd.png", size: 3 }] };

test("an edit keeps the old text and adds a notice in the same commit", async () => {
  const files = { [msgPath(original)]: JSON.stringify(original) };
  const { bus, commits } = fakeBus(files);
  const { message, notice } = await bus.amend(me, original, "hello");
  assert.equal(message.text, "hello");
  assert.deepEqual(message.edits, [{ text: "helo", at: original.ts }]);
  assert.ok(Date.parse(message.edited));
  assert.equal(commits.length, 1, "one commit");
  assert.deepEqual(commits[0].paths.sort(), [msgPath(original), msgPath(notice)].sort());
  assert.deepEqual(notice.system, { type: "edit", target: original.id });
  assert.equal(notice.channel, ch);
  assert.match(notice.text, /edited a message: hello$/, "the notice carries the new text, so a watching agent reads it");
  assert.ok(isEditNotice(notice));
  const again = await bus.amend(me, original, "hello!");
  assert.deepEqual(again.message.edits.map((e) => e.text), ["helo", "hello"], "every earlier version, oldest first");
  assert.equal(again.message.edits[1].at, message.edited);
  await assert.rejects(bus.amend(me, original, "hello!"), /Nothing changed/);
  await assert.rejects(bus.amend(me, original, "  "), /needs some text/);
});

test("a delete drops text, edits and its own attachments; a forwarded file stays", async () => {
  const files = { [msgPath(original)]: JSON.stringify({ ...original, edits: [{ text: "x", at: original.ts }], edited: original.ts }), [original.files[0].path]: "png", [original.files[1].path]: "png" };
  const { bus } = fakeBus(files);
  const { message, notice } = await bus.amend(me, original, null);
  assert.equal(message.text, "");
  assert.equal(message.files, undefined);
  assert.equal(message.edits, undefined);
  assert.equal(message.edited, undefined);
  assert.ok(Date.parse(message.deleted));
  assert.equal(message.id, original.id, "the message keeps its place in the chat");
  assert.ok(!(original.files[0].path in files), "its attachment is removed");
  assert.ok(original.files[1].path in files, "a file it only forwarded belongs to another message");
  assert.deepEqual(notice.system, { type: "delete", target: original.id });
  assert.doesNotMatch(notice.text, /helo/, "the notice does not repeat what was deleted");
  await assert.rejects(bus.amend(me, original, "back"), /deleted/);
});

test("only the author", async () => {
  const files = { [msgPath(original)]: JSON.stringify(original) };
  const { bus, commits } = fakeBus(files);
  await assert.rejects(bus.amend(you, original, "mine now"), /Only its author/);
  await assert.rejects(bus.amend(you, original, null), /Only its author/);
  await assert.rejects(bus.amend(me, { channel: ch, id: "nope" }, "x"), /No such message/);
  assert.equal(commits.length, 0);
});
