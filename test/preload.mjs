// `node --import ./test/preload.mjs …`: the CLI talks to the fake GitHub at OPENCOM_TEST_API instead of api.github.com.
const real = globalThis.fetch;
globalThis.fetch = (url, init) => real(String(url).replace("https://api.github.com", process.env.OPENCOM_TEST_API), init);
