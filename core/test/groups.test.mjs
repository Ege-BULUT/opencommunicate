// Who may change a group, and which messages count as addressed to a device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressedTo, applyGroupChange, groupAdmins } from "../src/index.ts";

const g = { channel: "g-team-abcd", name: "Team", members: ["1111", "2222", "3333"], admins: ["1111"], createdBy: "1111", createdAt: "" };

test("admins add, remove, promote and rename; members can't", () => {
  assert.deepEqual(applyGroupChange(g, { type: "add", ids: ["4444", "2222"] }, "1111").members, ["1111", "2222", "3333", "4444"]);
  assert.deepEqual(applyGroupChange(g, { type: "remove", id: "3333" }, "1111").members, ["1111", "2222"]);
  assert.deepEqual(applyGroupChange(g, { type: "admin", id: "2222", on: true }, "1111").admins, ["1111", "2222"]);
  assert.equal(applyGroupChange(g, { type: "rename", name: "  Core team " }, "1111").name, "Core team");
  for (const change of [{ type: "add", ids: ["4444"] }, { type: "remove", id: "3333" }, { type: "admin", id: "2222", on: true }, { type: "rename", name: "x" }])
    assert.throws(() => applyGroupChange(g, change, "2222"), /Only group admins/);
  assert.throws(() => applyGroupChange(g, { type: "add", ids: ["4444"] }, "9999"), /Only members/);
});

test("a removed admin loses admin rights; the last admin can't step down but can leave", () => {
  const two = applyGroupChange(g, { type: "admin", id: "2222", on: true }, "1111");
  assert.deepEqual(applyGroupChange(two, { type: "remove", id: "2222" }, "1111").admins, ["1111"]);
  assert.throws(() => applyGroupChange(g, { type: "admin", id: "1111", on: false }, "1111"), /at least one admin/);
  assert.throws(() => applyGroupChange(g, { type: "remove", id: "1111" }, "1111"), /leave/);
  const left = applyGroupChange(g, { type: "leave" }, "1111");
  assert.deepEqual([left.members, left.admins], [["2222", "3333"], ["2222"]]);
  assert.deepEqual(applyGroupChange(g, { type: "leave" }, "3333").admins, ["1111"]);
});

test("groups from before admins are run by their creator, or the first member once the creator is gone", () => {
  const old = { ...g, admins: undefined };
  assert.deepEqual(groupAdmins(old), ["1111"]);
  assert.deepEqual(groupAdmins({ ...old, members: ["2222", "3333"] }), ["2222"]);
});

test("addressedTo: DMs, @nick, nick#id, @all; not a longer nick or another id", () => {
  const me = { nick: "claude", id: "9153" };
  const m = (channel, text) => ({ channel, text });
  assert.ok(addressedTo(m("dm-1111-9153", "hi"), me));
  for (const t of ["@claude status?", "hey @Claude#9153", "claude#9153 please", "@all durum?", "@herkes"]) assert.ok(addressedTo(m("g-team-abcd", t), me), t);
  for (const t of ["@claudette hi", "claude#91530", "mail claude@x.com", "status please", "@alls"]) assert.ok(!addressedTo(m("g-team-abcd", t), me), t);
});

test("wantsNotice follows the channel setting until it runs out", async () => {
  const { wantsNotice } = await import("../src/index.ts");
  const now = Date.parse("2026-09-27T12:00:00Z");
  const d = (q) => ({ nick: "ege", id: "7779", quiet: q && { "g-team-abcd": q } });
  const m = (text) => ({ channel: "g-team-abcd", text });
  assert.ok(wantsNotice(d(), m("hi"), now));
  assert.ok(!wantsNotice(d({ mode: "off" }), m("@ege hi"), now));
  assert.ok(!wantsNotice(d({ mode: "off", until: "2026-09-27T20:00:00Z" }), m("hi"), now));
  assert.ok(wantsNotice(d({ mode: "off", until: "2026-09-27T11:00:00Z" }), m("hi"), now));
  assert.ok(!wantsNotice(d({ mode: "mentions" }), m("hi all"), now));
  assert.ok(wantsNotice(d({ mode: "mentions" }), m("@ege bak"), now));
  assert.ok(wantsNotice(d({ mode: "off" }), { channel: "all", text: "hi" }, now)); // other channels untouched
});

test("ntfy notices skip recipients who muted the channel or want only mentions", async () => {
  const { notifyRecipients } = await import("../src/notify.ts");
  const topic = (id) => `https://ntfy.sh/opencom-topic-${id}xxxxxx`;
  const from = { id: "1111", nick: "lead", kind: "person" };
  const devices = [from,
    { id: "2222", nick: "a", kind: "agent", notify: topic(2222) },
    { id: "3333", nick: "b", kind: "phone", notify: topic(3333), quiet: { "g-team-abcd": { mode: "off" } } },
    { id: "4444", nick: "c", kind: "phone", notify: topic(4444), quiet: { "g-team-abcd": { mode: "mentions" } } }];
  const groups = [{ channel: "g-team-abcd", name: "Team", members: ["1111", "2222", "3333", "4444"], createdBy: "1111", createdAt: "" }];
  const hit = async (text) => { const urls = []; await notifyRecipients({ channel: "g-team-abcd", from: "1111", text }, from, devices, groups, async (u) => { urls.push(String(u).split("?")[0].slice(-10, -6)); return new Response(""); }); return urls.sort(); };
  assert.deepEqual(await hit("status?"), ["2222"]);
  assert.deepEqual(await hit("@c status?"), ["2222", "4444"]);
});
