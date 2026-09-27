const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { generatedDifferences, root } = require("./grammar.js");
const { escapeHtml, page, renderPreview } = require("./preview.js");

function temporaryDirectory(t) {
  const path = mkdtempSync(join(tmpdir(), "scss-development-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("generated-file verification detects missing and stale files without modifying them", t => {
  const directory = temporaryDirectory(t);
  const expected = join(directory, "expected");
  const actual = join(directory, "actual");
  mkdirSync(join(expected, "tree_sitter"), { recursive: true });
  mkdirSync(actual);
  writeFileSync(join(expected, "parser.c"), "new parser");
  writeFileSync(join(expected, "tree_sitter/parser.h"), "header");
  writeFileSync(join(actual, "parser.c"), "old parser");
  assert.deepEqual(generatedDifferences(expected, actual).sort(), ["parser.c", join("tree_sitter", "parser.h")].sort());
  assert.equal(readFileSync(join(actual, "parser.c"), "utf8"), "old parser");
});

test("preview renders real captures and exposes parse errors", t => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "sample & test.scss");
  writeFileSync(source, 'body { content: "</script>"; color: red; }');
  const result = renderPreview(source);
  assert.equal(result.valid, true);
  assert.match(result.highlight, /color/);
  assert.match(result.highlight, /&lt;\/script&gt;/);
  const html = page(source, result, 0, false);
  assert.match(html, /sample &amp; test.scss/);
  assert.doesNotMatch(html, /setInterval/);
  assert.equal(escapeHtml("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
  writeFileSync(source, "body { color: ; }");
  const invalid = renderPreview(source);
  assert.equal(invalid.valid, false);
  assert.match(invalid.diagnostics, /ERROR|MISSING/);
});

test("live preview reloads, recovers from invalid input, and shuts down", { timeout: 20_000 }, async t => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "watched.scss");
  writeFileSync(source, "body { color: red; }");
  const child = spawn(process.execPath, [join(__dirname, "preview.js"), "--watch", "--port", "0", source], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", data => {
    output += data;
  });
  child.stderr.on("data", data => {
    output += data;
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    const result = await Promise.race([exited, delay(3000, null, { ref: false })]);
    if (!result) {
      child.kill("SIGKILL");
      await exited;
      assert.fail("Preview did not shut down after SIGTERM");
    }
    assert.equal(result[0], 0, output);
  });
  const until = async predicate => {
    const deadline = Date.now() + 7000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, `Preview timed out: ${output}`);
      assert.equal(child.exitCode, null, output);
      await delay(50);
    }
  };
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output));
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const revision = () => fetch(`${url}/revision`).then(response => response.text());
  const initial = await revision();
  assert.match(await (await fetch(url)).text(), /Parsed without errors/);
  assert.equal((await fetch(`${url}/package.json`)).status, 404);
  writeFileSync(source, "body { color: ; }");
  await until(async () => (await revision()) !== initial);
  assert.match(await (await fetch(url)).text(), /Parse or build errors/);
  const failed = await revision();
  writeFileSync(source, "body { width: 2px; }");
  await until(async () => (await revision()) !== failed);
  const restored = await (await fetch(url)).text();
  assert.match(restored, /Parsed without errors/);
  assert.match(restored, /width/);
});
