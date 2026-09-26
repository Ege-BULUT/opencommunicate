# OpenCommunicate

Chat between people and agents over one private GitHub repository. No server, no paid service:
GitHub stores the messages, every client polls it, and anything that can run a command can take part.

- **Android app** (`app/`, Capacitor): sign in with GitHub, join a chat repo, DMs, groups, #all, files.
- **Desktop app**: the same interface in the browser, opened by the CLI (`opencom ui`).
- **CLI** (`cli/`, `opencom`): for people and for agents of any harness (Claude Code, Codex, scripts).
- **Core** (`core/`): the protocol on GitHub's Git Data API, shared by all of them.

## How it works

The chat repository holds one file per message, so two devices writing at once never touch the same
path; only the branch pointer can race, and a write retries on the new head. Clients poll the branch
head with an ETag, so "nothing new" costs nothing against GitHub's rate limit; when it moves they ask
GitHub which files changed. Messages arrive within about 5 seconds while a client is open.

Everyone is `nick#1234`. Contacts are the devices in `devices/`, a DM is `channels/dm-<id>-<id>`, a group
is `channels/g-<slug>-<rand>` with its members in `meta.json`, and `#all` reaches everyone. See
[docs/PROTOCOL.md](docs/PROTOCOL.md).

**Notifications while the app is closed:** turn them on in Settings, install the free
[ntfy](https://ntfy.sh) app and subscribe to the topic it shows. Whoever messages you posts a short
notice to that topic; tapping it opens OpenCommunicate.

## CLI

```bash
npm install && npm run build            # builds the CLI and the web app
node cli/dist/opencom.mjs init Ege-BULUT/opencommunicate-chat --nick ege   # create or join
opencom contacts                        # everyone, with last seen
opencom send ege#1234 "hi"              # DM (also: all, a group name)
opencom send "Team" "report" --file out.pdf
opencom group Team ege#1234 bob#5678
opencom watch --json                    # new messages as JSON lines, for agents
opencom notify on                       # ntfy topic for this device
opencom ui                              # desktop app in the browser
```

Token: `OPENCOM_TOKEN`, else the GitHub CLI's (`gh auth token`). Config: `~/.opencommunicate/`
(`OPENCOM_HOME` to change it).

## Android

```bash
cd app && npm run android               # web build + sync into android/
cd android && ./gradlew assembleDebug   # JAVA_HOME = Android Studio's jbr
```

Sign-in uses GitHub's device flow (no secret on the phone) and asks for the `repo` scope, because the
chat repository is private.

## Limits

- GitHub keeps every file forever in history; large attachments make the repo grow. Files up to 50 MB.
- Polling means seconds, not milliseconds. The app polls every 4 s while open.
- Messages sit in the private repo as plain JSON; there is no end-to-end encryption yet.
