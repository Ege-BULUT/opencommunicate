// An expired token is renewed once through the Bus's token source, and the request is sent again with the new one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, GitHubError } from "../src/index.ts";

function fakeFetch(valid) {
  const seen = [];
  const f = async (url, init) => {
    const t = init.headers.Authorization.replace("Bearer ", "");
    seen.push(t);
    return valid.has(t) ? new Response(JSON.stringify({ login: "ege" }), { status: 200 }) : new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
  };
  return { f, seen };
}

test("a 401 renews the token once and retries with the new one", async () => {
  const { f, seen } = fakeFetch(new Set(["new"]));
  let renewed = 0;
  const bus = new Bus({ repo: "o/r", fetch: f, token: { current: () => "old", renew: async (r) => { renewed++; assert.equal(r, "old"); return "new"; } } });
  assert.equal((await bus.gh("/user")).data.login, "ege");
  assert.deepEqual(seen, ["old", "new"]);
  assert.equal(renewed, 1);
});

test("a token that can't be renewed is a 401, and it is asked only once", async () => {
  const { f, seen } = fakeFetch(new Set());
  let renewed = 0;
  const bus = new Bus({ repo: "o/r", fetch: f, token: { current: () => "old", renew: async () => { renewed++; return null; } } });
  await assert.rejects(bus.gh("/user"), (e) => e instanceof GitHubError && e.status === 401);
  assert.deepEqual(seen, ["old"]);
  assert.equal(renewed, 1);
});

test("a renewal that can't reach GitHub is passing trouble, not a 401", async () => {
  const { f } = fakeFetch(new Set());
  const bus = new Bus({ repo: "o/r", fetch: f, token: { current: () => "old", renew: async () => { throw new TypeError("Failed to fetch"); } } });
  await assert.rejects(bus.gh("/user"), (e) => !(e instanceof GitHubError) && /Failed to fetch/.test(e.message));
});

test("a plain string token still works, and a 401 is not retried", async () => {
  const { f, seen } = fakeFetch(new Set());
  await assert.rejects(new Bus({ repo: "o/r", fetch: f, token: "old" }).gh("/user"), (e) => e.status === 401);
  assert.deepEqual(seen, ["old"]);
});

// GitHub sends refs with max-age=60: a head read from the browser's cache made every commit retry fail.
test("the branch head is read past the HTTP cache", async () => {
  let init;
  const f = async (url, i) => { init = i; return new Response(JSON.stringify({ object: { sha: "abc" } }), { status: 200 }); };
  assert.equal(await new Bus({ repo: "o/r", fetch: f, token: "t" }).head(), "abc");
  assert.equal(init.cache, "no-store");
});
