// Search: text and file names, case-insensitive (Turkish İ/ı too), newest first, no notices or deleted messages;
// older() pages through what is not loaded yet, newest first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, msgPath, newerVersion, searchMessages, snippet } from "../src/index.ts";

test("newerVersion compares part by part as numbers", () => {
  assert.equal(newerVersion("0.7.10", "0.7.9"), true);
  assert.equal(newerVersion("v0.8.0", "0.7.6"), true);
  assert.equal(newerVersion("0.7.6", "0.7.6"), false);
  assert.equal(newerVersion("0.7.5", "0.7.6"), false);
  assert.equal(newerVersion("1.0", "0.9.9"), true);
});

const msg = (id, text, extra = {}) => ({ v: 1, id: `20261014T0${id}0000000Z-1111-aaaaaa`, channel: "all", from: "1111", fromNick: "me", ts: "", text, ...extra });

test("text and file names, newest first, nothing deleted or system", () => {
  const list = [
    msg(1, "Deploy is green"),
    msg(2, "no match", { files: [{ name: "deploy-log.txt", path: "x", size: 1 }] }),
    msg(3, "", { deleted: "2026-10-14T00:00:00Z" }),
    msg(4, "me edited a message: deploy", { system: { type: "edit", target: "x" } }),
    msg(5, "DEPLOY again"),
  ];
  assert.deepEqual(searchMessages(list, "deploy").map((m) => m.text), ["DEPLOY again", "no match", "Deploy is green"]);
  assert.deepEqual(searchMessages(list, "  "), []);
});

test("Turkish case in tr-TR", () => {
  const list = [msg(1, "İstanbul'da toplantı"), msg(2, "ISPARTA")];
  assert.equal(searchMessages(list, "istanbul", "tr-TR").length, 1);
  assert.equal(searchMessages(list, "ısparta", "tr-TR").length, 1);
});

test("older() pages through what is not loaded, newest first", async () => {
  const all = [1, 2, 3, 4, 5].map((i) => msg(i, `m${i}`));
  const bus = new Bus({ repo: "x/y", token: "t" });
  const tree = [...all.map((m) => ({ path: msgPath(m), sha: m.id })), { path: "channels/dm-1111-2222/20261014T090000000Z-2222-bbbbbb.json", sha: "dm" }, { path: "devices/1111.json", sha: "d" }];
  Object.assign(bus, { tree: async () => tree, json: async (sha) => all.find((m) => m.id === sha) });
  const have = new Set([msgPath(all[4])]);
  const first = await bus.older(["all"], have, 2, "head");
  assert.deepEqual(first.messages.map((m) => m.text), ["m4", "m3"]);
  assert.equal(first.left, 2);
  first.messages.forEach((m) => have.add(msgPath(m)));
  const next = await bus.older(["all"], have, 2, "head");
  assert.deepEqual(next.messages.map((m) => m.text), ["m2", "m1"]);
  assert.equal(next.left, 0, "the DM is not one of the channels asked for");
});

test("a snippet (a chat's last message, a notification) leaves out a fenced block's backtick lines", () => {
  assert.equal(snippet({ text: "Plan:\n```md\n| a | b |\n|-|-|\n```\nok" }), "Plan: | a | b | |-|-| ok");
  assert.equal(snippet({ text: "```\n```" }), "");
});
