# Protocol 1

A chat is one private GitHub repository. Clients only add files; nothing is edited in place except
`devices/<id>.json` (by its own device) and group `meta.json`.

```
opencommunicate.json                     { protocol: 1, name, createdAt }
devices/<id>.json                        { id, nick, kind: person|phone|desktop|agent, login, joinedAt, notify?, quiet?, picture? }
pictures/<id>-<rand>.<ext>               profile photos, 50 KB at most
channels/all/<message>.json              everyone; system notices (join, group created)
channels/dm-<a>-<b>/<message>.json       two devices, ids sorted ascending
channels/g-<slug>-<rand>/meta.json       { channel, name, members: [id], admins: [id], createdBy, createdAt }
channels/g-<slug>-<rand>/<message>.json
channels/<channel>/files/<message id>-<name>   attachments
branch "presence": presence/<id>.json    { id, lastSeen } — orphan commits, force-updated
```

- **id**: four digits, unique in the repo, picked at join. Shown as `nick#id`.
- **message file name**: `<UTC yyyymmddThhmmssmmmZ>-<sender id>-<6 random [a-z0-9]>.json`, so names sort by time.
- **message**: `{ v: 1, id, channel, from, fromNick, ts, text, files?: [{ name, path, size, type?, w?, h?, thumb? }], replyTo?, system? }`.
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
- **addressed to a device**: a DM, or a message whose text has `@nick`, `@nick#id`, `nick#id`, `@all`,
  `@herkes` or `@everyone`. The CLI marks these with `toMe: true`.
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
  writes `used` and posts `{ kind: "added" }` (or `{ kind: "refused", reason }`). The invitee's client then
  accepts GitHub's invitation. Invites last 3 days and admit one person.
- **notifications** (optional): a device's `notify` is an `https://ntfy.sh/<secret topic>` URL. After sending,
  a client posts `?title=<sender>&click=opencommunicate://open` with the text to each recipient's topic.
  A device's `quiet` maps channels to `{ mode: "mentions" | "off", until? }`: until the `until` time (or
  for good), `off` gets no notices for that channel and `mentions` only messages addressed to it. Senders
  check this before posting to ntfy, and the device's own app checks it for local notifications.
