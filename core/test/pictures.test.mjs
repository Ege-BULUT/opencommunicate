// Generated profile art is deterministic and varied; photos are capped; agents get art by default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, PALETTES, PHOTO_MAX, artSvg, paletteFor, pictureOf } from "../src/index.ts";

test("the same seed and palette always draw the same picture; other seeds draw others", () => {
  const a = artSvg({ seed: "4821", palette: "neon" });
  assert.equal(a, artSvg({ seed: "4821", palette: "neon" }));
  const many = new Set(Array.from({ length: 200 }, (_, i) => artSvg({ seed: String(i), palette: "neon" })));
  assert.equal(many.size, 200);
  assert.notEqual(a, artSvg({ seed: "4821", palette: "kum" }));
});

test("every picture is a 100×100 svg with a background and 4–6 shapes in its palette's colours", () => {
  for (const p of PALETTES) for (let i = 0; i < 50; i++) {
    const svg = artSvg({ seed: `s${i}`, palette: p.id });
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#[0-9a-f]{6}"\/>/);
    const shapes = svg.match(/<(circle|rect x|polygon)/g).length;
    assert.ok(shapes >= 4 && shapes <= 6, `${shapes} shapes`);
    for (const c of svg.match(/#[0-9a-f]{6}/g)) assert.ok(p.colors.includes(c), `${c} not in ${p.id}`);
    assert.doesNotMatch(svg, /NaN|undefined/);
  }
});

test("agents get art from their id by default, people keep initials until they pick", () => {
  assert.deepEqual(pictureOf({ id: "4821", kind: "agent" }), { seed: "4821", palette: paletteFor("4821") });
  assert.equal(pictureOf({ id: "7779", kind: "phone" }), null);
  assert.deepEqual(pictureOf({ id: "7779", kind: "phone", picture: { photo: "pictures/7779-abc.webp" } }), { photo: "pictures/7779-abc.webp" });
});

test("setPicture stores a photo under a new name, removes the old one, and refuses photos over 50 KB", async () => {
  const bus = new Bus({ repo: "x/y", token: "t" });
  const commits = [];
  bus.commit = async (files) => { commits.push(files); return "sha"; };
  const me = { id: "7779", nick: "ege", kind: "phone", joinedAt: "", picture: { photo: "pictures/7779-old.webp" } };
  const d = await bus.setPicture(me, { photo: new Uint8Array(1000), ext: "webp" });
  const paths = Object.keys(commits[0]);
  assert.match(d.picture.photo, /^pictures\/7779-[a-z0-9]{6}\.webp$/);
  assert.ok(paths.includes(d.picture.photo) && commits[0]["pictures/7779-old.webp"] === null && paths.includes("devices/7779.json"));
  await assert.rejects(bus.setPicture(me, { photo: new Uint8Array(PHOTO_MAX + 1), ext: "webp" }), /50 KB/);
  const art = await bus.setPicture(d, { seed: "abc", palette: "orman" });
  assert.deepEqual(art.picture, { seed: "abc", palette: "orman" });
  assert.equal(commits[1][d.picture.photo], null);
  assert.equal((await bus.setPicture(art, null)).picture, undefined);
});
