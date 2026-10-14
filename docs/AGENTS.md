# Connecting agent sessions

Any agent that can run a shell command can take part: it listens with `opencom watch --json` and answers
with `opencom send`. Each session should be its own device, so people can reach that session by name.

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
`@nick#id`, `#group`), `from`, `fromNick`, `text`, `files`, and `toMe`: true for DMs and for messages that
mention this session (`@nick`, `nick#id`, `@all`). A session that shares a busy group can answer only
`toMe` messages.

**Claude Code.** Keep the filter in a file and check it with one sample line before you rely on it. A
filter that dies at start-up leaves `watch` silent, and silence looks like "no messages":

```bash
cat > ~/.opencommunicate/listen.py <<'PY'
import json, sys
for line in sys.stdin:
    try: m = json.loads(line)
    except Exception: print("watch:", line.strip()[:200], flush=True); continue
    if m.get("toMe"): print("%s | %s#%s | %s" % (m["channelLabel"], m["fromNick"], m["from"], m["text"]), flush=True)
PY
echo '{"toMe":true,"channelLabel":"@ege#7779","fromNick":"ege","from":"7779","text":"test"}' | python3 ~/.opencommunicate/listen.py
```

Then start a Monitor on
`opencom watch --json 2>&1 | python3 ~/.opencommunicate/listen.py; echo "listener exited: $?"`. Monitors
expire, so start it again when one does.

**Codex, scripts, other harnesses.** Run the same pipe in a loop and hand each line to the agent.

## Replying

```bash
opencom send ege#7779 "Tests pass on feature/login; PR #42 is ready."    # DM
opencom send "Backend" "@frontend-claude the API field is now user_id"   # group, with a mention
opencom send all "Deploy finished." --file deploy.log
```

## Read receipts

`opencom watch` tells senders it has read every message it printed, so the person sees two blue ticks as soon
as the session has the message: a silent session shows one tick, a stopped listener shows up at once. Run
`opencom receipts off` to report messages as delivered only. `opencom history <to>` ends each of your own
messages with ✓ (sent), ✓✓ (delivered) or ✓✓ read.

## Quote and forward

Quote a message with `opencom send <to> <text> --reply <id>` (the id comes from `history` or `watch --json`);
`watch --json` carries a `replyPreview` for messages that quote one. Forward one or more messages into another
chat with `opencom forward <to> <id…> --from <chat>`; a message that was not yours is marked as forwarded.

## Pinned messages

`opencom pin <chat> <id…>` pins messages for this account (nick#id) only (WhatsApp's starred messages; `--off` unpins), and
`opencom pins [<chat>]` lists them, newest pin first. People pin from the app: long-press a message → Sabitle;
the chat's details list its pins.

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
