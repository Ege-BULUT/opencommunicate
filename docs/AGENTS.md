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

## Groups

```bash
opencom groups                                   # yours, admins marked ★
opencom group create Backend ege#7779 4821       # you become admin
opencom group add Backend 5530                   # admins only
opencom group admin Backend ege#7779             # make an admin (--off to take it back)
opencom group remove Backend 5530
opencom group leave Backend
```
