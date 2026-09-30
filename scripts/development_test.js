const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} = require("node:fs");
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

function previewBrowser(watch = true) {
  const handlers = {};
  const requests = [];
  const scheduled = [];
  const controls = { disabled: false };
  const source = { value: "body { color: red; }", defaultValue: "body { color: red; }" };
  const status = { textContent: "Parsed without errors" };
  const updates = { textContent: "" };
  const elements = {
    ".preview": { dataset: { revision: "current", watch: String(watch) } },
    "#preview-form": {
      querySelector: () => controls,
      setAttribute: () => {},
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      }
    },
    "#preview-source": source,
    "#preview-reset": {
      addEventListener: (_name, handler) => {
        handlers.reset = handler;
      }
    },
    "#preview-status": status,
    "#preview-updates": updates,
    "#preview-highlight": { innerHTML: "original preview" },
    "#preview-diagnostics": { textContent: "original tree" },
    ".preview-path": { textContent: "sample.scss" },
    "#preview-style": { textContent: "" }
  };
  let reloads = 0;
  const document = { body: {}, querySelector: selector => elements[selector] };
  const button = {
    focus: () => {
      document.activeElement = button;
    }
  };
  document.activeElement = button;
  runInNewContext(readFileSync(join(__dirname, "preview-client.js"), "utf8"), {
    document,
    location: { reload: () => reloads++ },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    setTimeout: callback => scheduled.push(callback)
  });
  return {
    handlers,
    requests,
    scheduled,
    controls,
    source,
    status,
    updates,
    elements,
    document,
    reloads: () => reloads
  };
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

test("CLI commands compile each checkout independently and retain failed parse diagnostics", { timeout: 30_000 }, t => {
  const directory = temporaryDirectory(t);
  const checkouts = [join(directory, "first"), join(directory, "second")];
  for (const checkout of checkouts) {
    for (const path of ["scripts", "test", "examples"]) mkdirSync(join(checkout, path), { recursive: true });
    for (const path of [
      "src",
      "grammar.js",
      "tree-sitter.json",
      "package.json",
      "scripts/grammar.js",
      "test/config.json"
    ]) {
      cpSync(join(root, path), join(checkout, path), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(checkout, "node_modules"), "junction");
    writeFileSync(join(checkout, "examples/highlight-stress.scss"), ".sample { color: red; }");
  }
  // The second generated fixture has the same grammar name, but a distinguishable root node.
  const secondParser = join(checkouts[1], "src/parser.c");
  writeFileSync(secondParser, readFileSync(secondParser, "utf8").replace('"stylesheet"', '"alternate_stylesheet"'));
  // Execute the package script without pnpm's unrelated install-on-run policy in disposable fixtures.
  const command = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.parse.split(" ");
  assert.equal(command.shift(), "node");
  const run = (checkout, args = []) =>
    spawnSync(process.execPath, [...command, ...args], {
      cwd: checkout,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, TREE_SITTER_LIBDIR: join(directory, "shared-cache") }
    });
  for (const index of [0, 1, 0]) {
    const result = run(checkouts[index]);
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, index === 0 ? /\(stylesheet / : /\(alternate_stylesheet /);
    assert.ok(readdirSync(join(checkouts[index], "build/tree-sitter")).length);
  }
  const broken = join(checkouts[0], "broken.scss");
  writeFileSync(broken, ".broken {");
  const result = run(checkouts[0], [broken]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /ERROR|MISSING/);
});

test("preview renders real captures and exposes parse errors", t => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "sample & test.scss");
  writeFileSync(source, 'body { content: "</script>"; color: red; }');
  const result = renderPreview(source);
  assert.equal(result.valid, true);
  assert.match(result.highlight, /color/);
  assert.match(result.highlight, /&lt;\/script&gt;/);
  assert.match(result.diagnostics, /^\(stylesheet\n  \(rule_set\n    selectors: \(selectors\n      \(tag_selector\)\)/);
  assert.match(result.diagnostics, /\n        name: \(property_name\)\n        value: \(plain_value\)/);
  const html = page(source, result);
  assert.match(html, /sample &amp; test.scss/);
  assert.ok(html.includes(`>${escapeHtml(result.diagnostics)}</pre>`));
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /<form|<script/);
  const draft = 'body { content: "</textarea><script>alert(1)</script>"; }';
  const editable = page(source, result, { sourceText: draft, revision: "current", watch: true });
  assert.ok(editable.includes(`${escapeHtml(draft)}</textarea>`));
  assert.match(editable, /<script src="\/preview-client.js" defer><\/script>/);
  assert.doesNotMatch(editable, /<script>alert/);
  assert.equal(escapeHtml("<>&\"'"), "&lt;&gt;&amp;&quot;&#39;");
  writeFileSync(source, "body { color: red;");
  const invalid = renderPreview(source);
  assert.equal(invalid.valid, false);
  assert.match(invalid.diagnostics, /^Tree contains ERROR or MISSING nodes\.\n\(stylesheet\n  \(ERROR\n/);
  writeFileSync(source, ".card { color: rgb(1, 2; width: 3px; }");
  const missing = renderPreview(source);
  assert.equal(missing.valid, false);
  assert.match(missing.diagnostics, /\n            \(MISSING "\)"\)/);
  assert.match(missing.diagnostics, /\(MISSING "\)"\)\)+\n      \(property_declaration\n/);
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

test("preview polling serializes requests, recovers, and preserves drafts and pending generation", async () => {
  const browser = previewBrowser();
  const { scheduled, requests, status, updates, source, controls } = browser;
  let pending = scheduled.shift()();
  assert.equal(scheduled.length, 0, "An unresolved request must not start another poll");
  requests.shift().resolve({ ok: false });
  await pending;
  assert.match(updates.textContent, /disconnected/);
  assert.equal(status.textContent, "Parsed without errors");
  assert.equal(scheduled.length, 1);
  pending = scheduled.shift()();
  requests.shift().resolve({ ok: true, text: async () => "current" });
  await pending;
  assert.equal(updates.textContent, "");
  assert.equal(browser.reloads(), 0);
  source.value = ".draft { color: blue; }";
  pending = scheduled.shift()();
  requests.shift().resolve({ ok: true, text: async () => "restarted" });
  await pending;
  assert.equal(browser.reloads(), 0);
  assert.match(updates.textContent, /Generate to update/);
  source.value = source.defaultValue;
  controls.disabled = true;
  pending = scheduled.shift()();
  requests.shift().resolve({ ok: true, text: async () => "restarted" });
  await pending;
  assert.equal(browser.reloads(), 0);
  controls.disabled = false;
  pending = scheduled.shift()();
  requests.shift().resolve({ ok: true, text: async () => "restarted" });
  await pending;
  assert.equal(browser.reloads(), 1);
});

test("the editor generates drafts, restores the example, and keeps input after request failures", async () => {
  const { handlers, requests, scheduled, controls, source, status, elements, document } = previewBrowser(false);
  assert.equal(scheduled.length, 0, "Preview mode must not poll for file changes");
  source.value = ".draft {";
  let pending = handlers.submit({ preventDefault() {} });
  assert.equal(controls.disabled, true);
  const focused = document.activeElement;
  document.activeElement = document.body;
  const request = requests.shift();
  assert.equal(request.url, "/preview");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { source: ".draft {" });
  const result = {
    valid: false,
    highlight: "draft highlight",
    diagnostics: "(ERROR)",
    revision: "current",
    css: "body {}"
  };
  request.resolve({ ok: true, json: async () => result });
  await pending;
  assert.equal(controls.disabled, false);
  assert.equal(document.activeElement, focused, "Restore keyboard focus after disabling the controls");
  assert.equal(elements["#preview-highlight"].innerHTML, result.highlight);
  assert.equal(elements["#preview-diagnostics"].textContent, result.diagnostics);
  assert.equal(status.className, "preview-error");
  pending = handlers.reset();
  assert.equal(source.value, ".draft {", "Keep the draft until the example is available");
  const reset = requests.shift();
  assert.equal(reset.url, "/example");
  reset.resolve({ ok: true, json: async () => ({ ...result, valid: true, source: ".stress {}" }) });
  await pending;
  assert.equal(source.value, ".stress {}");
  assert.equal(elements[".preview-path"].textContent, "examples/highlight-stress.scss");
  assert.equal(status.textContent, "Parsed without errors");
  assert.equal(status.className, "preview-status");
  source.value = ".keep-me {}";
  pending = handlers.submit({ preventDefault() {} });
  requests.shift().reject(new Error("Connection lost"));
  await pending;
  assert.equal(source.value, ".keep-me {}");
  assert.equal(controls.disabled, false);
  assert.equal(elements["#preview-diagnostics"].textContent, "Connection lost");
  assert.equal(status.className, "preview-error");
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
  await t.test("editor requests render isolated drafts and restore Highlight stress", async () => {
    const original = readFileSync(source, "utf8");
    const stressPath = join(root, "examples/highlight-stress.scss");
    const stress = readFileSync(stressPath, "utf8");
    const nativePath = require("node-gyp-build").path(root);
    const compiledAt = statSync(nativePath).mtimeMs;
    const submit = value =>
      fetch(`${url}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: value })
      });
    assert.match(await (await request()).text(), /id="preview-source"/);
    assert.equal((await request("/preview-client.js")).status, 200);
    const rendered = await submit('.draft { content: "</script>☃"; color: blue; }');
    assert.equal(rendered.status, 200);
    const result = await rendered.json();
    assert.equal(result.valid, true);
    assert.match(result.highlight, /&lt;\/script&gt;/);
    assert.match(result.highlight, /☃/);
    assert.match(result.diagnostics, /^\(stylesheet\n  /);
    assert.equal((await (await submit(".draft {")).json()).valid, false);
    assert.equal((await (await submit("")).json()).valid, true);
    assert.equal((await submit(null)).status, 400);
    assert.equal((await submit(" ".repeat(1024 * 1024))).status, 413);
    const crossOrigin = await fetch(`${url}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({ source: ".draft {}" })
    });
    assert.equal(crossOrigin.status, 403);
    const example = await (await request("/example")).json();
    assert.equal(example.source, stress);
    assert.equal(example.valid, true);
    assert.equal(readFileSync(source, "utf8"), original);
    assert.equal(readFileSync(stressPath, "utf8"), stress);
    assert.equal(await revision(), initial, "Browser drafts must not invalidate other tabs");
    assert.equal(statSync(nativePath).mtimeMs, compiledAt, "Browser drafts must not rebuild the parser");
  });
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
