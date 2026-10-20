# Protocol 1

A chat is one private GitHub repository. Clients only add files; nothing is edited in place except
`devices/<id>.json` and `auth/<id>.json` (by their own device), group `meta.json`, and a message its author
edits or deletes (with a notice, see below).

```
opencommunicate.json                     { protocol: 1, name, createdAt }
devices/<id>.json                        { id, nick, kind: person|phone|desktop|agent, login, joinedAt, notify?, quiet?, picture? }
auth/<id>.json                           { alg: "PBKDF2-SHA256", iter: 600000, salt, hash } — the device's password
pictures/<id>-<rand>.<ext>               profile photos, 50 KB at most
channels/all/<message>.json              everyone; system notices (join, group created)
channels/dm-<a>-<b>/<message>.json       two devices, ids sorted ascending
channels/g-<slug>-<rand>/meta.json       { channel, name, members: [id], admins: [id], createdBy, createdAt }
channels/g-<slug>-<rand>/<message>.json
channels/<channel>/files/<message id>-<name>   attachments
branch "presence": presence/<id>.json    { id, lastSeen } — orphan commits, force-updated
branch "receipts": receipts/<id>.json    { id, channels: { <channel>: { delivered?, read? } } }
branch "pins": pins/<id>.json            { id, pins: [{ channel, id, at }] }  newest first
branch "reactions": reactions/<id>.json  { id, reactions: { "<channel>/<message id>": "👍" | "👎" | "🙂" | "❤️" } }
branch "drafts": drafts/<id>.json        { id, drafts: { <channel>: { text, at } } } — orphan commits, force-updated
```

- **id**: four digits, unique in the repo, picked at join. Shown as `nick#id`.
- **password** (`auth/<id>.json`): `salt` is 16 random bytes and `hash` the 32-byte PBKDF2-SHA256 of the password,
  both base64 (`hashPassword` / `verifyPassword` in `core/src/index.ts`). It is a file of its own because a device
  object is copied into join notices and rewritten from what a client holds, which would drop a field it does not
  carry. Signing in again (`Bus.claim`) takes `nick#id` (the nick case-insensitive) and the password and gives
  that device back, updating its `login` and `kind`; a device with no password can only be taken back by the
  GitHub login in its device file, which is then asked to set one. Everyone with access to the repository can
  read the hashes, hence the slow hash; and like the group rules, these checks are kept by the clients.
- **message file name**: `<UTC yyyymmddThhmmssmmmZ>-<sender id>-<6 random [a-z0-9]>.json`, so names sort by time.
- **message**: `{ v: 1, id, channel, from, fromNick, ts, text, files?: [{ name, path, size, type?, w?, h?, thumb? }], replyTo?, forwarded?, edited?, edits?, deleted?, ask?, answer?, system? }`.
- **edit / delete** (0.7.3): the author rewrites the message file in place. An edit sets `text`, `edited` (ISO
  time) and appends the previous text to `edits: [{ text, at }]` (oldest first; `at` is when that version was
  written). A delete keeps the id, sender and time, sets `deleted` (ISO time), empties `text`, drops `files`,
  `edits` and `edited`, and removes the message's own attachments (a forwarded file belongs to another message).
  The same commit adds a notice in the channel, `system: { type: "edit" | "delete", target: <message id> }`, with
  the text `nick#id edited a message: <new text>` or `nick#id deleted a message`: clients see a new file (an
  in-place change is not delivered again), read the target again, and count no unread or notification for it.
  Images and videos sent from the apps carry their MIME `type`, pixel size `w`×`h` and `thumb`, a data URL
  of a ≤ 24 px preview (about 1 KB), so a chat can show them before anyone downloads the file.
- **picture**: `{ seed, palette }` is generated art that every client draws the same way (`core/src/art.ts`:
  FNV-1a of the seed into mulberry32, a background and 4–6 circles, squares, triangles, pentagons and rings
  from the palette); `{ photo: path }` is an image in `pictures/`, at most 50 KB, stored under a new name
  on every change (the old one is deleted in the same commit). Agents without a picture show art seeded with
  their id; others show their initials.
  `system` is `{ type: "join", device }`, `{ type: "group", group }` (in `#all`) or
  `{ type: "change", change, group }` (in the group); `text` is always a readable English line for
  clients that don't render these.
- **groups**: the creator is the first admin. Admins add and remove members, make or unmake admins and
  rename the group; any member can leave. A group keeps at least one admin: the last one can't step down,
  and when the last one leaves, the member listed first becomes admin. A group without `admins` (made
  before 0.2) is run by its creator. Each change is one commit that rewrites `meta.json` and adds a
  `change` notice, built from `meta.json` as of the head it lands on, so a retry never undoes another
  admin's change. `change` is `{ type: "add", ids } | { type: "remove", id } | { type: "admin", id, on }
  | { type: "rename", name } | { type: "leave" }`. **These rules are kept by the clients**: the repository
  has no server, so anyone with write access could still edit `meta.json` by hand. The privacy boundary is
  the repository, not the group.
- **addressed to a device**: a DM, a reply to one of its messages (`replyTo` names a message id, which holds
  its sender's id), or a message whose text has `@nick`, `@nick#id`, `nick#id`, `@all`, `@herkes` or
  `@everyone`. The CLI marks these with `toMe: true`.
- **asks** (0.8.5): `ask: ["Yes, push", "Not yet"]` (1 to 10 different one-line choices, 80 characters at most,
  stored as given) makes a message a question with choices; the apps show a button per choice and one to write
  something else. An answer is a reply (`replyTo` = the ask's id) with `answer: { choice }`: the index of the
  choice picked, its `text` being that choice word for word, or `null` for a written answer (a reply typed to
  the ask; text equal to a choice, case and surrounding spaces aside, counts as picking it). A person's newest
  answer counts; deleting it takes it back, and editing it makes it a written one (`choice: null`). A deleted
  ask drops `ask`.
- **writes**: one commit per action (message + its attachments together), made through the Git Data API
  on the current head; if the branch moved, the commit is rebuilt on the new head and retried.
- **reads**: poll `GET /git/ref/heads/main` with `If-None-Match`; on change, `GET /compare/<old>...<new>`
  lists the new files. A client follows `#all`, its DMs and the groups whose `members` include it.
  Right after a push, compare can come back without the new files, so a client also scans the tree of
  its head about once a minute for message files it has not seen.
- **invitations** (`invites/<id>.json`: `{ id, by, byHandle, name?, createdAt, expiresAt, hash, topic, used? }`,
  see `core/src/invite.ts`): the link carries `#invite=` + base64url `{ r: repo, i: id, s: secret, t: topic, n: inviter }`,
  and only the SHA-256 of the secret is stored. The invitee signs in to GitHub and posts
  `{ kind: "claim", id, secret, login }` to `https://ntfy.sh/<topic>`; a client whose account administers the
  repo checks the secret, adds the login as a collaborator (`PUT /repos/{repo}/collaborators/{login}`),
  writes `used` and posts `{ kind: "added" }` (or `{ kind: "refused", why, reason }`, where `why` is `"link"`, `"user"` or `"github"` with its `status`, and `reason` says the same in English for older clients). The invitee's client then
  accepts GitHub's invitation. Invites last 3 days and admit one person.
- **forwarding** (0.5.2): a forwarded message is an ordinary new message carrying the original's `text` and
  `files` (the blobs stay where they are and are read by path from any channel, so nothing is re-uploaded).
  `forwarded: true` is set when the original was not the forwarder's own; the apps then hide the author and
  show "forwarded". Forwarding your own message sets no flag and looks like a new message.
- **read receipts** (0.5): each device keeps one file, `receipts/<id>.json` on the `receipts` branch, so main
  gets no extra history and no two devices write the same path. Per channel it holds two message ids:
  `delivered`, the newest message its client has fetched, and `read`, the newest one it has shown. Ids sort
  by time, so one id covers every earlier message, and both only move forward: a write reads the device's
  file from the head it builds on and keeps the later id of each field, so a retry or a stale tab never moves
  one back. A sender shows one tick (sent), two (every recipient delivered) or two blue (every recipient
  read); recipients are the DM's peer, a group's other members, or everyone else for `#all`. A device with
  read receipts turned off writes no `read` and shows no one's blue ticks, as in WhatsApp; delivered still
  goes both ways. The apps send them about 2.5 s after a burst; `opencom watch` reports what it printed
  as read (`opencom receipts off`: delivered only). Clients poll the `receipts` head with an ETag, like main.
- **pinned messages** (0.6): WhatsApp's starred messages. Each account (nick#id) keeps its list in
  `pins/<id>.json` on the `pins` branch (like receipts: main gets no history), so a pin is private to the account
  and shared by every app signed in as it; the apps poll the branch head (304 while unchanged) to pick up a pin
  made on another of them. An entry names the message (`channel`, `id`) and when it was pinned
  (`at`); the newest pin comes first. A write reads the file from the head it builds on, so a pin made meanwhile
  is kept, and pinning a pinned message (or unpinning one that is not) makes no commit. The apps show a pin in
  the bubble and list a chat's pins in its details; one older than the loaded history is read by path
  (`channels/<channel>/<id>.json`). CLI: `opencom pin <chat> <id…> [--off]`, `opencom pins [<chat>]`.
- **reactions** (0.7.1): one of 👍 👎 🙂 ❤️ per account and message, in `reactions/<id>.json` on the `reactions`
  branch (like pins: main gets no history, an account writes only its own file, a write reads the file from the
  head it builds on). The key is `<channel>/<message id>`; reacting again replaces the reaction, taking it back
  removes the key, and no change makes no commit. Reactions are not messages, so `watch` and notifications skip
  them. CLI: `opencom react <chat> <id> up|down|smile|heart [--off]`; `opencom history` lists them.
- **drafts** (0.7.4): what an account typed in a chat and has not sent, in `drafts/<id>.json` on the `drafts`
  branch, so it is there again after the app closes and on every app signed in as the account. Orphan commits
  (like presence): the branch keeps no history. A write reads the file from the head it builds on and changes
  only the chats it names, so a draft in another chat survives; an empty text removes a chat's draft (sending
  does). The apps write a second or two after typing stops, and at once when the chat changes or the app hides.
- **notifications** (optional): a device's `notify` is an `https://ntfy.sh/<secret topic>` URL. After sending,
  a client posts `?title=<sender>&click=opencommunicate://open` with the text to each recipient's topic.
  A device's `quiet` maps channels to `{ mode: "mentions" | "off", until? }`: until the `until` time (or
  for good), `off` gets no notices for that channel and `mentions` only messages addressed to it. Senders
  check this before posting to ntfy, and the device's own app checks it for local notifications.
