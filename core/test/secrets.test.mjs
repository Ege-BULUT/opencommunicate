// Permission prompts go to the phone and stay in the chat's history: what looks like a secret is hidden first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hideSecrets } from "../src/index.ts";

test("secrets are hidden", () => {
  const cases = [
    ["GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh pr list", "GITHUB_TOKEN=•••• gh pr list"],
    ["OPENCOM_PASSWORD='hunter2' opencom send 7779 hi", "OPENCOM_PASSWORD='••••' opencom send 7779 hi"],
    ["export AWS_SECRET_ACCESS_KEY=\"wJalr/XUtnFEMI\" && aws s3 ls", "export AWS_SECRET_ACCESS_KEY=\"••••\" && aws s3 ls"],
    ["tool --password s3cret --verbose", "tool --password •••• --verbose"],
    ["tool --api-key=abc123 run", "tool --api-key=•••• run"],
    ['curl -H "Authorization: Bearer abc.def" https://api.x.com', 'curl -H "Authorization: ••••" https://api.x.com'],
    ["curl -H 'Cookie: a=1; b=2' https://x.com", "curl -H 'Cookie: ••••' https://x.com"],
    ["git clone https://ege:pa55word@github.com/a/b", "git clone https://ege:••••@github.com/a/b"],
    ["curl -u ege:pa55 https://x.com", "curl -u ege:•••• https://x.com"],
    ["echo sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA | pbcopy", "echo sk-•••• | pbcopy"],
    ["git push https://x-access-token:ghs_AAAAAAAAAAAAAAAAAAAAAAAA@github.com/a/b", "git push https://x-access-token:••••@github.com/a/b"],
    ["aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE", "aws configure set aws_access_key_id AKIA••••"],
    ["curl https://x.com/cb?access_token=abc123&page=2", "curl https://x.com/cb?access_token=••••&page=2"],
    ["echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part", "echo ••••"],
    ['{"query":"q","api_key":"a\\"b","headers":{"Authorization":"Bearer x"}}', '{"query":"q","api_key":"••••","headers":{"Authorization":"••••"}}'],
    ["cat > k <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----\nEOF", "cat > k <<EOF\n-----BEGIN OPENSSH PRIVATE KEY----- ••••\nEOF"],
  ];
  for (const [s, want] of cases) assert.equal(hideSecrets(s), want, s);
});

test("ordinary commands are left alone", () => {
  for (const s of [
    "git push origin main",
    "rm -rf build",
    "git log --pretty=oneline --author \"Ege BULUT\"",
    "gh auth login --with-token < token.txt",
    "TOKEN_FILE=~/t npm run build -- --keyboard us",
    "git show 32001df4c80e0dffc75879c226cc5dfad110c319",
    "curl -s https://api.github.com/repos/a/b",
    "/x/y.ts",
  ]) assert.equal(hideSecrets(s), s);
});
