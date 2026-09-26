# Protocol 1

A chat is one private GitHub repository. Clients only add files; nothing is edited in place except
`devices/<id>.json` (by its own device) and group `meta.json`.

```
opencommunicate.json                     { protocol: 1, name, createdAt }
devices/<id>.json                        { id, nick, kind: person|phone|desktop|agent, login, joinedAt, notify? }
channels/all/<message>.json              everyone; system notices (join, group created)
channels/dm-<a>-<b>/<message>.json       two devices, ids sorted ascending
channels/g-<slug>-<rand>/meta.json       { channel, name, members: [id], createdBy, createdAt }
channels/g-<slug>-<rand>/<message>.json
channels/<channel>/files/<message id>-<name>   attachments
branch "presence": presence/<id>.json    { id, lastSeen } — orphan commits, force-updated
```

- **id**: four digits, unique in the repo, picked at join. Shown as `nick#id`.
- **message file name**: `<UTC yyyymmddThhmmssmmmZ>-<sender id>-<6 random [a-z0-9]>.json`, so names sort by time.
- **message**: `{ v: 1, id, channel, from, fromNick, ts, text, files?: [{ name, path, size }], replyTo?, system? }`.
- **writes**: one commit per action (message + its attachments together), made through the Git Data API
  on the current head; if the branch moved, the commit is rebuilt on the new head and retried.
- **reads**: poll `GET /git/ref/heads/main` with `If-None-Match`; on change, `GET /compare/<old>...<new>`
  lists the new files. A client follows `#all`, its DMs and the groups whose `members` include it.
- **notifications** (optional): a device's `notify` is an `https://ntfy.sh/<secret topic>` URL. After sending,
  a client posts `?title=<sender>&click=opencommunicate://open` with the text to each recipient's topic.
