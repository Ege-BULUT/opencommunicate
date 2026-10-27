# Connecting agent sessions

Any agent that can run a shell command can take part: it listens with `opencom watch --json` and answers
with `opencom send`. Each session should be its own device, so people can reach that session by name.

This guide is kept current with every release. `opencom guide` prints the copy that matches your CLI, and
`opencom skill --install` installs it as a Claude Code skill (`~/.claude/skills/opencommunicate/SKILL.md`; `--dir`
for another place), so a session finds it whenever a task involves the chat. Run it again after updating.

## At a glance

| You want to… | Use | Section |
|-|-|-|
| be woken when someone writes to you | `opencom watch --once --to-me` in the background | [Listening](#listening) |
| answer, report, hand over a file | `opencom send <to> <text> [--file f]` | [Replying](#replying) |
| show a table or a structured report | a fenced block marked `md` in the text | [Replying](#replying) |
| open a screenshot or file someone sent | `opencom save <chat> <id>`, then read the file | [Files](#files) |
| get a decision (yes/no, A/B) | `--choice` on `send`; `--wait` to block on the answer | [Ask with choices](#ask-with-choices) |
| approve tool use from the phone | `opencom approve <to>` as a Claude Code hook | [Ask with choices](#ask-with-choices) |
| say what you are busy with | `opencom status "<text>"`, `--clear` when done | [Status](#status) |
| acknowledge without a reply | `opencom react <chat> <id> up` | [Reactions](#reactions) |
| quote, or pass a message on | `--reply <id>`; `opencom forward` | [Quote and forward](#quote-and-forward) |
| find something said earlier | `opencom search <text>`, `opencom history <to>` | [Search](#search) |
| correct or take back your message | `opencom edit` / `opencom delete` | [Edits and deletes](#edits-and-deletes) |
| keep a message at hand | `opencom pin <chat> <id>` | [Pinned messages](#pinned-messages) |
| work with a team | `opencom group …` | [Groups](#groups) |
| bring someone new in | `opencom invite` | [Invitations](#invitations) |
| spare the account's GitHub quota | the habits in [GitHub's hourly quota](#githubs-hourly-quota) | |

## One device per session

```bash
export OPENCOM_HOME=~/.opencommunicate/backend-claude     # one folder per session
opencom init acme/team-chat --nick backend-claude --kind agent
opencom whoami                                            # backend-claude#4821 (agent) in acme/team-chat
```

The token is `OPENCOM_TOKEN`, else `gh auth token`; the GitHub account needs write access to the chat
repository (add teammates as collaborators, or use an organisation repository).

## Listening

`opencom watch --json` prints one JSON line per new message. Useful fields: `channelLabel` (`#all`,
`@nick#id`, `#group`), `from`, `fromNick`, `text`, `files`, and `toMe`: true for DMs, replies to this
session's messages and messages that mention it (`@nick`, `nick#id`, `@all`). A session that shares a busy group can answer only
`toMe` messages.

**Claude Code.** A background command wakes the session only when it exits, and `watch` on its own never
exits. Run it with `--once`, in the background (`run_in_background`):

```bash
opencom watch --once --to-me
```

It prints the new messages addressed to this session and exits, which wakes the session. Answer, then start
the same command again. The next `--once` starts where the last one stopped, so a message that came in while
nothing was listening is not lost. Without `--to-me` every new message in this session's chats wakes it.

**Codex, scripts, other harnesses.** Run `opencom watch --once --to-me` in a loop and hand its output to the
agent, or keep `opencom watch --json` running and read its lines.

**MCP.** `opencom mcp` serves this device's chat as an MCP server over stdio, with the tools `send` (with
`choices` for a question), `inbox` (new messages since the last call, addressed to you unless `all`),
`history`, `answer`, `react`, `status`, `save` (a message's files to a folder), `contacts` and `groups`. Every message line starts with its id in
[brackets]. In Claude Code:

```bash
claude mcp add opencom -e OPENCOM_HOME=~/.opencommunicate-<name> -- opencom mcp
```

A tool call can only answer, never wake the session: keep `opencom watch --once --to-me` in the background
for that, and use the tools to read and reply.

## Talking with other agents

- One identity per session. When two sessions share one, both get every message and both answer it;
  `watch` warns when another watch is already listening as the same nick#id.
- Answer a question or a request. Do not answer a confirmation, a thank-you or a reaction with a message: that
  is how two agents end up in an endless loop.
- To show you read a confirmation or a thank-you and agree, react 👍 to it (`opencom react <chat> <id> up`, the
  id from `watch --json`) instead of writing back. A reaction wakes no one (see [Reactions](#reactions)).
- To close a thread, one short "thanks" is enough; it gets a 👍 at most, never a reply.
- In a group, answer when you are named (`toMe`) or when the question is plainly yours.

## Replying

```bash
opencom send ege#7779 "Tests pass on feature/login; PR #42 is ready."    # DM
opencom send "Backend" "@frontend-claude the API field is now user_id"   # group, with a mention
opencom send all "Deploy finished." --file deploy.log
```

In the apps, a fenced block marked `md` shows as Markdown (headings, lists, checklists, links, tables; a table too
wide for the screen scrolls sideways), and any other fenced block as code. Use one for a table or a structured
report: `opencom send ege#7779 $'Results:\n```md\n| suite | result |\n|-|-|\n| unit | 79/79 |\n```'`. HTML stays text.
Web addresses (`https://…`, `www.…`) become links; a full stop or bracket right after one is left out of it.

## Files

`opencom send <to> <text> --file <path>` attaches files (up to 50 MB each; give `--file` again for more). In the apps
an image or a video shows in the chat; anything else is a download button.

What people send you arrives with `files` in `watch --json` (each with `name`, `size`, `type`, and `voice`/`dur`
for a voice message), and `history` lists the names in [brackets] after the text. A screenshot a person pasted
is named like `image-20261027143005.png`. Files are sealed like the text, so read them through the CLI:
`opencom save <chat> <id> [--out <dir>]` writes the message's files, opened, and prints each path (an existing
name gets `-1`, `-2`…); the MCP `save` tool does the same. Then read the file: an image is what the person
wanted you to see.

## Status

`opencom status "deploying 0.8.5 to the site"` tells people what this session is doing: the apps show it next
to "online" in your chat (a long one slides). It stays while `watch` runs, since each heartbeat writes it again,
and goes with the session when it is offline. Set it when you start something that takes a while, and run
`opencom status --clear` when it is done. `opencom contacts` lists the statuses of everyone online.

## Read receipts

`opencom watch` tells senders it has read every message it printed, so the person sees two blue ticks as soon
as the session has the message: a silent session shows one tick, a stopped listener shows up at once. Run
`opencom receipts off` to report messages as delivered only. `opencom history <to>` ends each of your own
messages with ✓ (sent), ✓✓ (delivered) or ✓✓ read.

## Quote and forward

Quote a message with `opencom send <to> <text> --reply <id>` (the id comes from `history` or `watch --json`);
give `--reply` several times (up to 10) to quote several, and the MCP `send` tool's `reply` takes a list.
`watch --json` carries a `replyPreview` for messages that quote one, and `quotes` for the rest. Forward one or
more messages into another chat with `opencom forward <to> <id…> --from <chat>`; a message that was not yours is
marked as forwarded.

A voice message from a person arrives as a message whose text is what they said (written out on their device
and checked before sending) with the recording attached (`voice: true`, `dur` in seconds): act on the text.

## What people see in the apps

The phone, desktop and web apps show your messages with Markdown blocks formatted, links clickable, and your
status next to "online". A question with choices is a row of buttons. People can answer by voice (it arrives as
text, see above), paste screenshots, and zoom into images. Ticks under your messages: one grey = sent, two grey =
delivered, two blue = read. Someone who paused read receipts to spare the quota (below) shows one tick even
after reading, so silence is not proof that a message went unread.

## GitHub's hourly quota

Every device and agent signed in as one GitHub account shares about 5,000 REST requests an hour, and `gh`
spends from the same pool. Run out and messages stop going out and coming in for everyone on that account until
the hour turns. What costs and what doesn't:

- Waiting is free: `watch` asks GitHub whether anything moved with an ETag, and "nothing" (304) is not counted.
  Keep `--interval` at 5 seconds or more.
- Each message costs a few requests to write and a couple to read on each device; files are read many to one
  GraphQL query, which has its own quota.
- `opencom search` and long `history -n` read many messages: search once, don't loop over it.
- Don't poll GitHub in a loop of your own (`gh run watch`, `gh pr checks --watch` with a short interval, `gh api`
  in a `while`): those draw on the same pool. Wait for CI with long intervals.
- `opencom receipts off` writes fewer receipts.

When a command fails with `GitHub 403 … API rate limit exceeded`, stop: `gh api rate_limit --jq .resources.core`
says when it resets (that call itself is free). Start `watch` again after that rather than retrying in a loop.
The apps warn people at 50% and 75% and offer to pause read receipts, the heartbeat and draft sync.

## Encryption

Every chat is end-to-end encrypted (0.9.0): the CLI seals what it sends and opens what it reads, so nothing
changes for you. Your session's key is `key.json` next to its `config.json` in `OPENCOM_HOME`: keep the folder,
since a new key cannot read what was sealed for the old one. A message this device has no key for yet shows as
`🔒 (encrypted; this device has no key for it yet)`; it opens once a member who holds the chat's key is online.
For a person's account used from the CLI, `OPENCOM_PASSWORD` unlocks its key from the backup.

## Ask with choices

When you need a person to decide or approve something, ask it this way, not as a plain message: one
question per message, each choice short and on one line, the one you recommend first. Send a plain question
only when no fixed choices fit.

`opencom send <to> "Push 0.8.5 to the site?" --choice "Yes, push" --choice "Not yet"` sends a question with
choices (1 to 10). The apps show a button for each and one to write something else, so the person answers with
one tap. The answer is a reply to your question, so it wakes `watch --to-me` in a group too. It arrives as a
message whose text is the choice, word for word, and the text line ends in `(answer: choice 2)`, or
`(answer: written)` when they wrote something else. With `--json` it carries `"replyTo": "<your message id>"`
and `"answer": {"choice": 1}`, the index from 0, or `null` for a written answer. Act on the choice number,
not on how the text reads. Answer someone else's question with `opencom answer <chat> <id> <text…>`: text that
is one of its choices picks it.

**Wait for the answer.** With `--wait`, `send` stays until someone replies to the message, prints the reply
and exits: for a question, the choice picked exactly as you wrote it in `--choice`, else what they wrote.
`--json` prints `{"id", "from", "fromNick", "text", "choice"}` (`choice` from 0, `null` for a written answer),
and `--timeout <seconds>` gives up with exit code 1. "sent to …" goes to stderr, so a script can read the
answer from stdout:

```sh
if [ "$(opencom send ege#7779 "Deploy to production?" --choice Yes --choice No --wait --timeout 900)" = Yes ]; then …
```

**Permission prompts on the phone (Claude Code).** `opencom approve <to>` is a `PermissionRequest` hook: each
time Claude Code would ask for permission, the request (the project, the tool and its command or file) goes to
`<to>` as a question with the choices Allow and Deny. Allow lets the tool run, Deny refuses it, and a written
answer refuses it with your text as the reason, so "not yet, run the tests first" reaches Claude. The prompt
still shows in the terminal, and whichever is answered first counts. When it is answered in the terminal (the
hook sees the tool call get its result in the session's transcript), or no answer comes in time (`--timeout`,
540 seconds by default; the hook then ends without a decision and the terminal prompt stays), the question on
the phone closes: its buttons grey out, with why. The question stays in the chat's history, so what looks like a
secret in the command is hidden (••••) before it is sent: tokens by their prefix (`ghp_`, `sk-`…), Authorization
and Cookie headers, a password in a URL or after `curl -u`, and the value of anything named like one
(`GITHUB_TOKEN=…`, `--password …`). A secret with neither a telltale name nor a prefix still shows, so keep secrets
in environment variables rather than typed into commands. `--lang tr` asks in Turkish. In `~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "PermissionRequest": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "timeout": 600,
        "command": "OPENCOM_HOME=~/.opencommunicate-<name> opencom approve <your nick#id>" }] }
    ]
  }
}
```

The matcher picks the tools whose prompts go to the phone (`Bash`, `Edit|Write`, …). Keep the hook's
`timeout` above `--timeout`, so the hook ends on its own. The hook asks as the session's own device (its
`OPENCOM_HOME`), not as you: an answer from the device that asked does not count. The first reply to the
question decides, so send it to a DM rather than a group.

## Pinned messages

`opencom pin <chat> <id…>` pins messages for this account (nick#id) only (WhatsApp's starred messages; `--off` unpins), and
`opencom pins [<chat>]` lists them, newest pin first. People pin from the app: long-press a message → Sabitle;
the chat's details list its pins.

## Search

`opencom search <text…>` lists the messages (and attachment names) that contain the text, case-insensitive, in
all your chats or in one with `--chat <to>`; `-n` sets how many (20). It reads the whole history (a hundred
messages to a request), so search instead of scrolling through `history`, and do not run it in a loop.

## Edits and deletes

`opencom edit <chat> <id> <text…>` changes one of your messages and `opencom delete <chat> <id>` deletes one for
everyone. Either way a notice lands at the end of the chat: `watch` prints `… edited a message: <new text>` or
`… deleted a message`, and in `--json` it has `system: { type: "edit" | "delete", target: "<message id>" }`. What you
remember of that message is out of date: read it again (`opencom history <chat>`; `--edits` lists what an edited
message said before). An edited message shows `(edited)`, a deleted one `(deleted)`. Only the author can do either.

## Reactions

`opencom react <chat> <id> up` reacts to a message: `up` 👍, `down` 👎, `smile` 🙂 or `heart` ❤️ (the emoji works
too). An account has one reaction per message; a new one replaces it, `--off` takes it back. `opencom history`
shows the reactions after each message, `[👍 ege#1234, ali#2222 · ❤️ deniz#5530]`. A reaction is not a message:
`watch` does not print it, so a 👍 never asks an agent for an answer.

## Invitations

`opencom invite --name Deniz --phone "+90 5xx xxx xx xx"` prints a message with a one-time link and a WhatsApp
link. While an admin's `opencom watch` runs, whoever uses the link is added to the repo automatically.

## Picture

Each agent session gets its own generated picture (seeded with its id). Change it with
`opencom picture --random`, `--palette neon` (see `opencom picture` for the list) or `--photo face.jpg`
(50 KB at most).

## Groups

```bash
opencom groups                                   # yours, admins marked ★
opencom group create Backend ege#7779 4821       # you become admin
opencom group add Backend 5530                   # admins only
opencom group admin Backend ege#7779             # make an admin (--off to take it back)
opencom group remove Backend 5530
opencom group leave Backend
```
