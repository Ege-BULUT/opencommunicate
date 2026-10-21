// Asks: choices travel as a field (never parsed from the text), an answer names the choice by index, a reply to
// my message is addressed to me, and edits and deletes keep the answer honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, addressedTo, answerFor, answersTo, checkChoices, isEditNotice, msgPath, quotedIds } from "../src/index.ts";

const agent = { id: "2082", nick: "claude-oc", kind: "agent", joinedAt: "" };
const ege = { id: "7779", nick: "ege-bulut", kind: "person", joinedAt: "" };
const ch = "g-team-abcd";

function fakeBus() {
  const files = {};
  const bus = new Bus({ repo: "x/y", token: "t" });
  Object.assign(bus, {
    readJson: async (path) => (path in files ? JSON.parse(files[path]) : null),
    commit: async (change) => {
      const out = typeof change === "function" ? await change("head") : change;
      for (const [p, c] of Object.entries(out)) { if (c === null) delete files[p]; else files[p] = c; }
      return "c";
    },
  });
  return { bus, files };
}

test("choices are checked, not cleaned up", () => {
  assert.deepEqual(checkChoices(["Yes, push", "No"]), ["Yes, push", "No"]);
  assert.throws(() => checkChoices([]), /1 to 10/);
  assert.throws(() => checkChoices(Array.from({ length: 11 }, (_, i) => `c${i}`)), /1 to 10/);
  assert.throws(() => checkChoices(["Yes", " yes "]), /same/);
  assert.throws(() => checkChoices(["Yes", "  "]), /one line/);
  assert.throws(() => checkChoices(["two\nlines"]), /one line/);
  assert.throws(() => checkChoices(["x".repeat(81)]), /one line/);
});

test("an ask and its answers, picked and written", async () => {
  const { bus, files } = fakeBus();
  const ask = await bus.send(ch, agent, "Push 0.8.5?", [], { ask: ["Yes", "Not yet"] });
  assert.deepEqual(JSON.parse(files[msgPath(ask)]).ask, ["Yes", "Not yet"]);
  const picked = await bus.send(ch, ege, "Not yet", [], { replyTo: ask.id, answer: answerFor(ask, "Not yet") });
  assert.deepEqual(picked.answer, { choice: 1 });
  assert.deepEqual(answerFor(ask, "  not YET "), { choice: 1 }, "typing a choice counts as picking it");
  assert.deepEqual(answerFor(ask, "push after lunch"), { choice: null });
  assert.ok(addressedTo(picked, agent), "a reply to the agent's message wakes it in a group");
  assert.ok(!addressedTo(picked, { id: "1234", nick: "other" }));
  await assert.rejects(bus.send(ch, ege, "Yes", [], { answer: { choice: 0 } }), /replies/);
  await assert.rejects(bus.send(ch, agent, "?", [], { ask: ["a", "A"] }), /same/);
});

test("the newest answer per person counts; a deleted one is taken back; an edited one is written", async () => {
  const { bus } = fakeBus();
  const ask = await bus.send(ch, agent, "Which?", [], { ask: ["A", "B"] });
  const first = await bus.send(ch, ege, "A", [], { replyTo: ask.id, answer: { choice: 0 } });
  await new Promise((r) => setTimeout(r, 2)); // ids sort by time
  const second = await bus.send(ch, ege, "B", [], { replyTo: ask.id, answer: { choice: 1 } });
  const plain = await bus.send(ch, agent, "noted", [], { replyTo: ask.id });
  assert.deepEqual(answersTo(ask, [ask, second, first, plain]), { 7779: 1 }, "a reply without an answer is not one");
  const { message: gone } = await bus.amend(ege, second, null);
  assert.deepEqual(answersTo(ask, [ask, first, gone]), {});
  const { message: edited } = await bus.amend(ege, first, "A, but tomorrow");
  assert.deepEqual(edited.answer, { choice: null });
  const { message: askGone } = await bus.amend(agent, ask, null);
  assert.equal(askGone.ask, undefined, "a deleted ask shows no buttons");
});

test("an ask its author closes takes no more answers, with a note and a notice", async () => {
  const { bus, files } = fakeBus();
  const ask = await bus.send(ch, agent, "Allow Bash?", [], { ask: ["Allow", "Deny"] });
  await assert.rejects(bus.closeAsk(ege, ask, "x"), /author/);
  const closed = await bus.closeAsk(agent, ask, "  answered in\nthe terminal ");
  assert.deepEqual(JSON.parse(files[msgPath(ask)]).closed.note, "answered in the terminal");
  assert.deepEqual(closed.ask, ["Allow", "Deny"], "the choices stay, for the record");
  const notices = Object.values(files).map((t) => JSON.parse(t)).filter((m) => m.system?.type === "close");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].system.target, ask.id);
  assert.ok(isEditNotice(notices[0]), "the apps read the question again");
  await bus.closeAsk(agent, ask, "again");
  assert.equal(Object.values(files).map((t) => JSON.parse(t)).filter((m) => m.system?.type === "close").length, 1, "closing twice changes nothing");
});

test("a message quotes several: replyTo first, then quotes; a quote of mine is addressed to me", async () => {
  const { bus, files } = fakeBus();
  const a = await bus.send(ch, agent, "first", []);
  const b = await bus.send(ch, ege, "second", []);
  const m = await bus.send(ch, ege, "about both", [], { replyTo: b.id, quotes: [a.id, b.id, a.id] });
  assert.deepEqual(JSON.parse(files[msgPath(m)]).quotes, [a.id], "deduplicated, replyTo left out");
  assert.deepEqual(quotedIds(m), [b.id, a.id]);
  assert.ok(addressedTo(m, agent), "quoting the agent's message (not the first) addresses it");
  await assert.rejects(bus.send(ch, ege, "x", [], { quotes: [a.id] }), /replyTo/);
  await assert.rejects(bus.send(ch, ege, "x", [], { replyTo: a.id, quotes: Array.from({ length: 10 }, (_, i) => `${i}`) }), /10/);
});
