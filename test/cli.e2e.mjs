// The command line against the fake GitHub: asks and answers, watch --to-me, send --wait and approve.
//   npm run build -w cli && node test/cli.e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { answerFor, dmChannel } from "../core/src/index.ts";
import { checks, sleep, world } from "./harness.mjs";

const w = await world();
const { check, done } = checks();
const A = (args, stdin) => w.run("2082", args, stdin); // claude-oc#2082, the agent
const E = (args, stdin) => w.run("7779", args, stdin); // ege-bulut#7779
const { bus, ege } = w;
const dm = dmChannel("2082", "7779");
// the newest message from the agent whose text starts with `start`, once it is there
const asked = async (start) => { for (;;) { const m = (await bus.history(dm, 10)).reverse().find((x) => x.from === "2082" && x.text.startsWith(start)); if (m) return m; await sleep(300); } };
const answer = (ask, text) => bus.send(dm, ege, text, [], { replyTo: ask.id, answer: answerFor(ask, text) });

// asks in a group: the answer wakes the asker's watch --once --to-me, with the choice
{ const sent = await A(["send", "Team", "Deploy 0.8.5?", "--choice", "Yes, deploy", "--choice", "Not yet"]);
  check("send with choices", sent.code === 0 && sent.out === "sent to #Team", JSON.stringify(sent));
  const bad = await A(["send", "Team", "bad", "--choice", "a", "--choice", "A"]);
  check("two choices alike are refused", bad.code === 1 && /same/.test(bad.err), bad.err);
  const watching = A(["watch", "--once", "--to-me", "--interval", "2", "--json"]);
  await sleep(2500);
  const history = await E(["history", "Team"]);
  const id = history.out.match(/opencom answer <chat> (\S+?);?\]/)?.[1] ?? history.out.match(/opencom answer <chat> (\S+) /)?.[1];
  check("history shows the choices and how to answer", /\[choices: 1 Yes, deploy \| 2 Not yet; answer: opencom answer <chat> \S+ <text>\]/.test(history.out), history.out);
  const picked = await E(["answer", "Team", id, "  not YET "]);
  check("typing a choice picks it", /answered choice 2 "Not yet"/.test(picked.out), JSON.stringify(picked));
  const woke = (await watching).out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  check("the asker's watch --to-me wakes with the choice", woke.some((m) => m.text === "Not yet" && m.toMe && m.answer?.choice === 1), JSON.stringify(woke));
  const written = await E(["answer", "Team", id, "after lunch"]);
  check("other text is a written answer", /answered \(written\)/.test(written.out), written.out);
  check("history marks both answers", /\(answer: choice 2\)/.test((await A(["history", "Team", "-n", "5"])).out) && /\(answer: written\)/.test((await A(["history", "Team", "-n", "5"])).out)); }

{ const run = A(["send", "7779", "Deploy?", "--choice", "Yes, deploy", "--choice", "Not yet", "--wait", "--timeout", "60"]);
  await answer(await asked("Deploy?"), "  not YET ");
  const r = await run;
  check("a picked choice prints the choice as written", r.out === "Not yet" && r.code === 0, JSON.stringify(r));
  check("the sent line goes to stderr", r.err === "sent to @ege-bulut#7779", r.err); }

{ const run = A(["send", "7779", "Which day?", "--choice", "Mon", "--choice", "Tue", "--wait", "--json", "--timeout", "60"]);
  const ask = await asked("Which day?");
  await sleep(4000);
  await bus.send(dm, ege, "an unrelated message", []);
  await sleep(4000);
  await answer(ask, "after lunch on Wed");
  const d = JSON.parse((await run).out);
  check("a written answer, in --json, after an unrelated message", d.text === "after lunch on Wed" && d.choice === null && d.from === "7779" && d.fromNick === "ege-bulut", JSON.stringify(d)); }

{ const run = A(["send", "7779", "Ping me back", "--wait", "--timeout", "60"]);
  const m = await asked("Ping me back");
  await bus.send(dm, ege, "pong", [], { replyTo: m.id });
  check("any reply ends a plain wait", (await run).out === "pong"); }

{ const run = A(["send", "7779", "Old app?", "--choice", "Yes", "--choice", "No", "--wait", "--timeout", "60"]);
  const m = await asked("Old app?");
  await bus.send(dm, ege, "no", [], { replyTo: m.id }); // no answer field
  check("a reply that spells out a choice picks it", (await run).out === "No"); }

{ const r = await A(["send", "7779", "Anyone?", "--wait", "--timeout", "4"]);
  check("no answer in time: exit 1", r.code === 1 && r.err.endsWith("opencom: No answer within 4 s."), JSON.stringify(r)); }

const hook = (tool_name, tool_input) => JSON.stringify({ session_id: "s1", cwd: "/home/someone/opencommunicate", hook_event_name: "PermissionRequest", tool_name, tool_input });
const decision = (r) => { try { return JSON.parse(r.out).hookSpecificOutput; } catch { return null; } };
{ const run = A(["approve", "7779"], hook("Bash", { command: "git push origin main", description: "Push to GitHub" }));
  const m = await asked("opencommunicate: allow Bash?");
  check("approve asks with the command", m.text === "opencommunicate: allow Bash?\ngit push origin main\n(Push to GitHub)" && m.ask.join() === "Allow,Deny", JSON.stringify(m.text));
  await answer(m, "Allow");
  const d = decision(await run);
  check("Allow allows", d?.hookEventName === "PermissionRequest" && d.decision.behavior === "allow", JSON.stringify(d)); }

{ const run = A(["approve", "7779", "--lang", "tr"], hook("Write", { file_path: "/x/y.ts", content: "..." }));
  const m = await asked("opencommunicate: Write için");
  check("Turkish choices, and the file for a Write", m.ask.join() === "İzin ver,Reddet" && m.text.endsWith("\n/x/y.ts"), m.text);
  await answer(m, "Reddet");
  const d = decision(await run);
  check("Deny denies", d?.decision.behavior === "deny" && d.decision.message === "ege-bulut#7779 denied this.", JSON.stringify(d)); }

{ const run = A(["approve", "7779"], hook("Bash", { command: "vercel deploy --prod" }));
  await answer(await asked("opencommunicate: allow Bash?\nvercel"), "not yet, run the tests first");
  const d = decision(await run);
  check("a written answer denies with its text", d?.decision.behavior === "deny" && d.decision.message === "ege-bulut#7779: not yet, run the tests first", JSON.stringify(d)); }

{ const r = await A(["approve", "7779", "--timeout", "4"], hook("Bash", { command: "rm -rf build" }));
  const m = await asked("opencommunicate: allow Bash?\nrm -rf build");
  check("no answer in time: no decision, exit 0, the question closed", r.out === "" && r.code === 0 && (await bus.message(dm, m.id))?.closed?.note === "no answer in time; asked in the terminal", JSON.stringify(r)); }

// answered in the terminal: the call gets its result in the session's transcript, and the question on the phone closes
{ const t = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "opencom-transcript-")), "session.jsonl");
  const input = { command: "git push origin main", description: "Push" };
  const line = (o) => JSON.stringify(o) + "\n";
  const call = (id) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
  const result = (id) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  fs.writeFileSync(t, call("toolu_before") + result("toolu_before") + call("toolu_now"));
  const run = A(["approve", "7779"], JSON.stringify({ session_id: "s1", transcript_path: t, cwd: "/home/someone/site", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: input }));
  const m = await asked("site: allow Bash?");
  await sleep(4000);
  check("an earlier call's result does not close it", !(await bus.message(dm, m.id))?.closed);
  fs.appendFileSync(t, result("toolu_other") + result("toolu_now"));
  const r = await run;
  const closed = (await bus.message(dm, m.id))?.closed;
  check("an answer in the terminal closes the question, with no decision", r.out === "" && r.code === 0 && closed?.note === "answered in the terminal", JSON.stringify({ r, closed }));
  check("history shows it closed", (await E(["history", "2082", "-n", "3"])).out.includes("[closed: answered in the terminal]"));
  const late = await E(["answer", "2082", m.id, "Allow"]);
  check("a closed question takes no answer", late.code === 1 && /closed/.test(late.err), late.err); }

{ const one = await bus.send(dm, ege, "one", []), two = await bus.send(dm, ege, "two", []);
  await A(["send", "7779", "about both", "--reply", one.id, "--reply", two.id]);
  const m = await asked("about both");
  check("--reply twice quotes both", m.replyTo === one.id && JSON.stringify(m.quotes) === JSON.stringify([two.id]), JSON.stringify(m));
  check("history shows both quotes", /↩ ege-bulut: one\s+↩ ege-bulut: two/.test((await E(["history", "2082", "-n", "5"])).out)); }

{ const run = A(["send", "7779", "--wait", "Flags first?", "--timeout", "60"]);
  const m = await asked("Flags first?");
  await bus.send(dm, ege, "yes", [], { replyTo: m.id });
  check("--wait before the text takes no value", (await run).out === "yes"); }

{ const r = await A(["approve", "7779"], "");
  check("approve without hook input: an error, nothing sent", r.code === 1 && r.err.includes("stdin") && !(await bus.history(dm, 3)).some((m) => m.text.startsWith("?")), JSON.stringify(r)); }

{ const r = await A(["send", "7779", "never sent", "--wait", "--timeout", "soon"]);
  check("a bad --timeout fails before sending", r.code === 1 && r.err.includes("--timeout") && !(await bus.history(dm, 3)).some((m) => m.text === "never sent"), JSON.stringify(r)); }

w.close();
done();
