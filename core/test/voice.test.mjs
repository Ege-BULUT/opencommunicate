// Reading aloud: each run of a message goes to a voice of its language, English terms inside Turkish included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseLang, speechRuns } from "../src/voice.ts";

const fmt = (text) => speechRuns(text).map((r) => `${r.lang}:${r.text}`).join(" | ");

test("English terms inside Turkish keep English, a Turkish suffix stays Turkish", () => {
  assert.equal(fmt("vercel'e deploy ettim, claude ile GPT'yi karşılaştırdım"), "en:vercel | tr:e | en:deploy | tr:ettim, | en:claude | tr:ile | en:GPT | tr:yi karşılaştırdım");
  assert.equal(fmt("Tamam, push ettim"), "tr:Tamam, | en:push | tr:ettim");
  assert.equal(fmt("`npm run build` çalıştır, sonra OpenCommunicate açılır"), "en:npm run build | tr:çalıştır, sonra | en:OpenCommunicate | tr:açılır");
});

test("one language throughout", () => {
  assert.equal(fmt("Did you push the commit?"), "en:Did you push the commit?");
  assert.equal(fmt("Bugün hava çok güzel"), "tr:Bugün hava çok güzel");
  assert.equal(fmt("Saat 10.30'da toplantı var"), "tr:Saat 10.30'da toplantı var", "a plain number is read in Turkish");
  assert.equal(baseLang("The momentum is popular"), "en", "English words with Turkish-looking endings");
  assert.equal(baseLang("tamam gidiyorum"), "tr", "Turkish without Turkish letters");
});

test("links are read as their site, code blocks are named", () => {
  assert.equal(fmt("Bak: https://opencommunicate.vercel.app/docs/changelog.html güzel olmuş"), "tr:Bak: | en:opencommunicate.vercel.app | tr:güzel olmuş");
  assert.equal(fmt("Şunu çalıştır:\n```\nnpm test\n```\nsonra söyle"), "tr:Şunu çalıştır: kod bloğu sonra söyle");
  assert.equal(fmt("Run this:\n```\nnpm test\n```"), "en:Run this: code block");
  assert.equal(fmt("README.md dosyasına bak"), "en:README.md | tr:dosyasına bak");
});

test("nothing to say is no runs", () => {
  assert.deepEqual(speechRuns("👍 ..."), []);
});
