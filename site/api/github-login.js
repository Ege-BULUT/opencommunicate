// GitHub's device sign-in endpoints refuse browser (CORS) requests, so the web app (/app/, e.g. on an iPhone)
// makes those two calls through here. Only these two, only for OpenCommunicate's OAuth app; no secrets.
const CLIENT_ID = "Ov23liPuqrEbse9N4sDQ";
const FIELDS = { "device/code": ["scope"], "oauth/access_token": ["device_code", "grant_type"] };

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { endpoint, body = {} } = req.body ?? {};
  const fields = FIELDS[endpoint];
  if (!fields) return res.status(400).json({ error: "unknown endpoint" });
  const form = new URLSearchParams({ client_id: CLIENT_ID });
  for (const k of fields) if (typeof body[k] === "string") form.set(k, body[k].slice(0, 200));
  const r = await fetch(`https://github.com/login/${endpoint}`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  res.status(r.status).json(await r.json().catch(() => ({ error: "GitHub answered with something other than JSON." })));
};
