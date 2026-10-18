const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const {
  externalSets,
  assertSameSets,
  recoveryInputs,
  replayInputs,
  replay,
  formatReplay
} = require("./scanner-replay.js");
const fixtures = require("./recovery-fixtures.js");

const table = [
  "enum {",
  "  ts_external_token_test = 0,",
  "};",
  "static const bool ts_external_scanner_states[2][EXTERNAL_TOKEN_COUNT] = {",
  "  [1] = {",
  "    [ts_external_token_test] = true,",
  "  },",
  "};",
  ""
].join("\n");
const directoryFor = t => {
  const path = mkdtempSync(join(tmpdir(), "scss-replay-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

test("scanner replay requires identical external enum order and valid sets", () => {
  const sets = externalSets(table);
  assert.deepEqual(sets, { tokens: ["ts_external_token_test"], sets: [[], ["ts_external_token_test"]] });
  assertSameSets(sets, externalSets(table));
  assert.throws(
    () => assertSameSets(sets, externalSets(table.replaceAll("token_test", "token_other"))),
    /External scanner sets differ/
  );
  assert.throws(() => externalSets(""), /are missing/);
  assert.throws(() => externalSets(table.replace("test = 0", "test = 1")), /not contiguous/);
  assert.throws(() => externalSets(table.replace("states[2]", "states[3]")), /nonempty subsequent/);
});

test("scanner replay covers recovery documents and paired/plain typed prefixes", () => {
  const inputs = recoveryInputs();
  const documents = inputs.map(input => input.text);
  for (const statement of [
    ...Object.values(fixtures.contractStatements).flat(),
    ...fixtures.typingStatements,
    ...fixtures.blockStatements,
    ...fixtures.headers,
    ...Object.values(fixtures.unfinishedLines).flat(),
    ...fixtures.unfinishedHeaders,
    ...Object.values(fixtures.typos)
  ]) {
    assert.ok(
      documents.some(text => text.includes(statement)),
      statement
    );
  }
  assert.ok(inputs.some(input => input.id.includes("/paired/") && input.text.includes("calc()")));
  assert.ok(inputs.some(input => input.id.includes("/plain/") && input.text.includes("calc(\n")));
  assert.deepEqual(recoveryInputs(), inputs);
  const statement = Object.values(fixtures.contractStatements)
    .flat()
    .find(text => text.includes('"'));
  const index = Object.values(fixtures.contractStatements).flat().indexOf(statement);
  const [layout, [before, after]] = Object.entries(fixtures.contractLayouts)[0];
  assert.deepEqual(
    inputs.filter(input => input.id.startsWith(`recovery/prefix/${index}/${layout}/paired/`)).map(input => input.text),
    [...fixtures.typingStates(before, after, statement, { "(": ")", "[": "]", "{": "}", '"': '"' }, true)].map(
      state => state.text
    )
  );
});

test("shared typing states retain edit positions and paired closer overtypes", () => {
  const states = [...fixtures.typingStates(".a {\n  x: ", ";\n}", 'fn("a")', { "(": ")", '"': '"' }, true)];
  assert.equal(states.length, 7);
  assert.equal(states[2].text, ".a {\n  x: fn();\n}");
  assert.deepEqual(states[2].edit.startPosition, { row: 1, column: 7 });
  assert.equal(states[3].text, '.a {\n  x: fn("");\n}');
  assert.deepEqual(states[5], { text: '.a {\n  x: fn("a");\n}' });
  assert.deepEqual(states[6], states[5]);
  assert.equal([...fixtures.typingStates("", "", 'fn("a")', { "(": ")", '"': '"' })].length, 5);
  assert.equal([...fixtures.typingStates("", "", 'fn("a")', {})].at(-1).text, 'fn("a")');
});

test("scanner replay corpus preserves raw bytes and hashes each unique input", t => {
  const directory = directoryFor(t);
  const file = join(directory, "bytes.scss");
  const list = join(directory, "corpus.txt");
  const bytes = Buffer.from([0, 255, 0xe2, 0x98, 0x83, 13, 10]);
  writeFileSync(file, bytes);
  writeFileSync(list, file + "\n" + file + "\n");
  const inputs = replayInputs(list);
  const matches = inputs.filter(input => input.id === file);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].bytes, bytes);
  assert.equal(matches[0].hash, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(inputs.some(input => input.id.startsWith("valid/")));
  assert.ok(inputs.some(input => input.id.startsWith("test/corpus/")));
});

test(
  "native replay compares observable fields, byte offsets, dialects and included-range starts",
  { timeout: 60_000 },
  t => {
    const directory = directoryFor(t);
    const base = join(directory, "base"),
      candidate = join(directory, "candidate");
    const parser = [
      '#include "tree_sitter/parser.h"',
      "#define EXTERNAL_TOKEN_COUNT 1",
      table,
      "void *tree_sitter_scss_external_scanner_create(void);",
      "void tree_sitter_scss_external_scanner_destroy(void *);",
      "unsigned tree_sitter_scss_external_scanner_serialize(void *, char *);",
      "void tree_sitter_scss_external_scanner_deserialize(void *, const char *, unsigned);",
      "bool tree_sitter_scss_external_scanner_scan(void *, TSLexer *, const bool *);",
      "const TSLanguage *tree_sitter_scss(void) {",
      "  static const TSLanguage language = {.external_scanner = {",
      "    .create = tree_sitter_scss_external_scanner_create,",
      "    .destroy = tree_sitter_scss_external_scanner_destroy,",
      "    .serialize = tree_sitter_scss_external_scanner_serialize,",
      "    .deserialize = tree_sitter_scss_external_scanner_deserialize,",
      "    .scan = tree_sitter_scss_external_scanner_scan,",
      "  }};",
      "  return &language;",
      "}"
    ].join("\n");
    const scanner = [
      '#include "tree_sitter/parser.h"',
      "const TSLanguage *tree_sitter_scss(void);",
      "static char css;",
      "static void *css_create(void) { return &css; }",
      "void *tree_sitter_scss_external_scanner_create(void) { return NULL; }",
      "void tree_sitter_scss_external_scanner_destroy(void *p) { (void)p; }",
      "unsigned tree_sitter_scss_external_scanner_serialize(void *p, char *b) { (void)p; (void)b; return 0; }",
      "void tree_sitter_scss_external_scanner_deserialize(void *p, const char *b, unsigned n) { (void)p; (void)b; (void)n; }",
      "const TSLanguage *tree_sitter_stylesheet_css(void) {",
      "  static TSLanguage language;",
      "  language = *tree_sitter_scss();",
      "  language.external_scanner.create = css_create;",
      "  return &language;",
      "}",
      "bool tree_sitter_scss_external_scanner_scan(void *p, TSLexer *l, const bool *v) {",
      "  (void)p; (void)v;",
      "  BODY",
      "  return false;",
      "}"
    ].join("\n");
    for (const path of [base, candidate]) {
      mkdirSync(join(path, "src/tree_sitter"), { recursive: true });
      writeFileSync(join(path, "package.json"), "{}");
      symlinkSync(join(__dirname, "../node_modules"), join(path, "node_modules"), "dir");
      cpSync(join(__dirname, "../src/tree_sitter/parser.h"), join(path, "src/tree_sitter/parser.h"));
      writeFileSync(join(path, "src/parser.c"), parser);
      writeFileSync(join(path, "src/scanner.c"), scanner.replace("BODY", ""));
    }
    const bytes = Buffer.from([0xc3, 0xa9, 13, 10, 255]);
    const inputs = [{ id: "synthetic", bytes, hash: createHash("sha256").update(bytes).digest("hex") }];
    assert.throws(() => replay({ base: "HEAD", baseDir: base, repo: candidate, inputs }), /Use either --base/);
    let result = replay({ baseDir: base, repo: candidate, inputs });
    assert.equal(result.summary.differences, 0);
    assert.equal(result.summary.calls, (bytes.length + 1) * 2 * 2 * 2);
    assert.deepEqual(result.base, { directory: base });
    const json = join(directory, "replay.json");
    const invoke = (...args) =>
      spawnSync(process.execPath, [join(__dirname, "scanner-replay.js"), "--repo", candidate, ...args], {
        encoding: "utf8",
        timeout: 30_000
      });
    let cli = invoke("--base-dir", base, "--json", json);
    assert.equal(cli.status, 0, cli.stderr);
    const recorded = JSON.parse(readFileSync(json, "utf8"));
    assert.equal(recorded.summary.differences, 0);
    assert.equal(cli.stdout.trim(), formatReplay(recorded));
    assert.ok(cli.stdout.length < 2000, cli.stdout);
    cli = invoke("--base", "HEAD", "--base-dir", base);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Use either --base/);
    cli = invoke("--base", base);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /not a git repository/);
    const changed = [
      "bool start = l->is_at_included_range_start(l);",
      "uint32_t column = l->get_column(l);",
      "if (!l->eof(l)) l->advance(l, false);",
      "l->mark_end(l);",
      "l->result_symbol = column == 0 ? 1 : 2;",
      "return p || start;"
    ].join("\n");
    writeFileSync(join(candidate, "src/scanner.c"), scanner.replace("BODY", changed));
    result = replay({ baseDir: base, repo: candidate, inputs });
    assert.equal(result.summary.differences, result.summary.calls);
    assert.deepEqual(result.differences[0].base, [0, 0, 0xffffffff, 0, 0, 0]);
    assert.deepEqual(result.differences[0].candidate, [0, 1, 2, 2, 1, 1]);
    assert.deepEqual(result.differences[1].candidate, [1, 1, 2, 2, 1, 1]);
    assert.equal(result.differences[2].dialect, "css");
    assert.equal(result.differences[2].candidate[0], 1);
    assert.equal(result.differences[8].offset, 1);
    assert.equal(result.differences[8].candidate[3], 2);
    assert.equal(result.differences.length, 10);
    const output = formatReplay(result);
    assert.match(output, /48 calls, 48 differences;/);
    assert.match(output, /input="synthetic" offset=0 set=1 dialect=scss includedRangeStart=false/);
    assert.match(output, /valid: ts_external_token_test/);
    assert.match(
      output,
      /base: return=false, symbol=ts_external_token_test \(0\), markEnd=unset, position=0, advances=0, usedColumn=false/
    );
    assert.match(
      output,
      /candidate: return=false, symbol=unknown \(1\), markEnd=2, position=2, advances=1, usedColumn=true/
    );
    assert.match(output, /context: "é\\r\\n/);
    cli = invoke("--base-dir", base);
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stdout, /Difference: input=/);
    assert.match(cli.stdout, /candidate: return=/);
    assert.doesNotMatch(cli.stdout, /"inputs":/);
    assert.equal(readFileSync(join(base, "src/scanner.c"), "utf8"), scanner.replace("BODY", ""));
    const setBody = (path, body) => writeFileSync(join(path, "src/scanner.c"), scanner.replace("BODY", body));
    const compare = (baseBody, candidateBody) => {
      setBody(base, baseBody);
      setBody(candidate, candidateBody);
      return replay({ baseDir: base, repo: candidate, inputs });
    };
    const token = "l->result_symbol = 1; l->mark_end(l);";
    result = compare("", token);
    assert.equal(result.summary.differences, 0, "failed scans discard symbol and token end");
    for (const change of ["l->result_symbol = 1;", "l->mark_end(l);"]) {
      result = compare("", change);
      assert.equal(result.summary.differences, 0, "failed scans discard each token field independently");
      result = compare("return true;", change + " return true;");
      assert.equal(result.summary.differences, result.summary.calls);
      assert.deepEqual(result.differences[0].differingFields, [change.includes("symbol") ? "symbol" : "markEnd"]);
    }
    writeFileSync(join(candidate, "src/scanner.c"), scanner.replace("BODY", "").replace("return 0; }", "return 1; }"));
    assert.throws(() => replay({ baseDir: base, repo: candidate, inputs }), /requires zero-byte serialization/);
  }
);
