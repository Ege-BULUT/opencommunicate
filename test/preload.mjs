// `node --import ./test/preload.mjs …`: the CLI talks to the fake GitHub at OPENCOM_TEST_API instead of api.github.com,
// and to its /ntfy instead of ntfy.sh (invites, the agents' app setup).
const real = globalThis.fetch;
globalThis.fetch = (url, init) => real(String(url).replace("https://api.github.com", process.env.OPENCOM_TEST_API).replace("https://ntfy.sh", `${process.env.OPENCOM_TEST_API}/ntfy`), init);
