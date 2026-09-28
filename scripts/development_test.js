const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { checkLargeStates, generatedDifferences, root } = require("./grammar.js");
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

test("generated parsers stay within the large parse state budget", t => {
  const directory = temporaryDirectory(t);
  writeFileSync(join(directory, "parser.c"), "#define STATE_COUNT 900\n#define LARGE_STATE_COUNT 12\n");
  assert.equal(checkLargeStates(directory, 12), 12);
  assert.throws(() => checkLargeStates(directory, 11), /12 large parse states, over the budget of 11/);
  writeFileSync(join(directory, "parser.c"), "#define STATE_COUNT 900\n");
  assert.throws(() => checkLargeStates(directory, 12), /LARGE_STATE_COUNT is missing/);
  assert.ok(checkLargeStates(join(root, "src")) > 0, "The committed parser must satisfy the default budget");
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
  writeFileSync(source, "body { color: red;");
  const invalid = renderPreview(source);
  assert.equal(invalid.valid, false);
  assert.match(invalid.diagnostics, /ERROR|MISSING/);
});

test("the stress preview styles every non-whitespace character in real CLI HTML", () => {
  const result = renderPreview(join(root, "examples/highlight-stress.scss"));
  assert.equal(result.valid, true);
  let spanDepth = 0;
  const unstyled = [];
  for (const token of result.highlight.match(/<[^>]*>|[^<]+/g)) {
    if (token.startsWith("<span ")) spanDepth++;
    else if (token === "</span>") spanDepth--;
    else if (!token.startsWith("<") && spanDepth === 0 && /\S/.test(token)) unstyled.push(token);
  }
  assert.equal(spanDepth, 0);
  assert.deepEqual(unstyled, []);
});

test("preview polling waits for each response and restores status after reconnecting", async () => {
  const result = { valid: true, diagnostics: "", highlight: "" };
  const script = page("sample.scss", result, "current", true).match(/<script>([\s\S]*?)<\/script>/)[1];
  const status = { textContent: "Parsed without errors" };
  const scheduled = [];
  let respond;
  let reloads = 0;
  runInNewContext(script, {
    document: { querySelector: () => status },
    location: { reload: () => reloads++ },
    fetch: () => new Promise(resolve => (respond = resolve)),
    setTimeout: callback => scheduled.push(callback)
  });
  let pending = scheduled.shift()();
  assert.equal(scheduled.length, 0, "An unresolved request must not start another poll");
  respond({ ok: false });
  await pending;
  assert.match(status.textContent, /disconnected/);
  assert.equal(scheduled.length, 1);
  pending = scheduled.shift()();
  respond({ ok: true, text: async () => "current" });
  await pending;
  assert.equal(status.textContent, "Parsed without errors");
  assert.equal(reloads, 0);
  pending = scheduled.shift()();
  respond({ ok: true, text: async () => "restarted" });
  await pending;
  assert.equal(reloads, 1);
});

test("live preview reloads, recovers from invalid input, and shuts down", { timeout: 60_000 }, async t => {
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
  const request = (path = "", timeout = 7000) =>
    fetch(`${url}${path}`, { signal: globalThis.AbortSignal.timeout(timeout) });
  const revision = () => request("/revision").then(response => response.text());
  // Cold startup compiles both bindings; it must not consume the reload budget.
  const initial = await (await request("/revision", 30_000)).text();
  await t.test("source edits and error recovery finish within the reload budget", { timeout: 20_000 }, async () => {
    const nativePath = require("node-gyp-build").path(root);
    const compiledAt = statSync(nativePath).mtimeMs;
    const cliDirectory = join(root, "build/tree-sitter");
    const cliLibraries = readdirSync(cliDirectory).map(file => [file, statSync(join(cliDirectory, file)).mtimeMs]);
    assert.ok(cliLibraries.length, "The CLI must compile into the project's own build directory");
    assert.match(await (await request()).text(), /Parsed without errors/);
    assert.equal((await request("/package.json")).status, 404);
    writeFileSync(source, "body { color: red;");
    await until(async () => (await revision()) !== initial);
    assert.match(await (await request()).text(), /Parse or build errors/);
    const failed = await revision();
    writeFileSync(source, "body { width: 2px; }");
    await until(async () => (await revision()) !== failed);
    const restored = await (await request()).text();
    assert.match(restored, /Parsed without errors/);
    assert.match(restored, /width/);
    assert.equal(statSync(nativePath).mtimeMs, compiledAt, "Source edits must not rebuild the native parser");
    assert.deepEqual(
      readdirSync(cliDirectory).map(file => [file, statSync(join(cliDirectory, file)).mtimeMs]),
      cliLibraries,
      "Source edits must not rebuild the CLI parser either"
    );
  });
});
