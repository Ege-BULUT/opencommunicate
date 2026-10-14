// Picking a chat repository: likely chat repositories first, and new ones always named "…-chat".
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatRepoName, chatReposFirst } from "../src/index.ts";

test("new chat repositories end in -chat exactly once", () => {
  assert.equal(chatRepoName("opencommunicate"), "opencommunicate-chat");
  assert.equal(chatRepoName("team-chat"), "team-chat");
  assert.equal(chatRepoName("Team Chat"), "Team-chat");
  assert.equal(chatRepoName("  aile / sohbet "), "aile-sohbet-chat");
  assert.equal(chatRepoName(""), "chat");
});

test("chat-looking repositories come first, the rest keep their order", () => {
  assert.deepEqual(chatReposFirst(["a/site", "a/opencommunicate-chat", "a/notes", "b/Team-Chat", "chat/tools"]),
    ["a/opencommunicate-chat", "b/Team-Chat", "a/site", "a/notes", "chat/tools"]);
});
