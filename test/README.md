# Tests

| Command | What it covers | Needs |
|---|---|---|
| `npm test` | core: the protocol, drafts, asks, presence, the watcher, language runs for read aloud | nothing |
| `npm run test:e2e` | the CLI (`cli.e2e.mjs`), `opencom mcp` (`mcp.e2e.mjs`) and the app in Chromium (`app.e2e.mjs`) | `npm run build` |
| `node test/app.e2e.mjs dictate` | dictation with Whisper, fed a recording through Chromium's fake microphone | `WHISPER_DIR`, `VOICE_WAV` (see the file) |
| `node test/android/background.mjs <apk>` | Android's background check on an emulator | a cleartext test APK (see the file) |
| `node test/android/voice.mjs` | the read-aloud and dictation plugins on an emulator or phone | the app open, no chat stored |
| `node test/android/paste.mjs` | pasting a copied image on an emulator, in a chat against the fake (its requests caught through DevTools) | the debug APK installed, Chrome past its first-run screens |

Every end-to-end test runs against `fakegh.mjs`, an in-memory GitHub (the git data API subset the apps use, plus
sign-in renewal), so no test reaches GitHub or a real chat. The browser tests route `api.github.com` to it; the CLI
runs with `--import test/preload.mjs`, which points it at the fake served over HTTP. `CHROMIUM=<path>` runs the
browser tests in a local Chromium instead of Playwright's (`npx playwright install chromium`).

GitHub Actions (`.github/workflows/test.yml`) runs the first two rows on every pull request and push to main.
