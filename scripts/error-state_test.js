const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { extractErrorState, compareErrorState } = require("./error-state.js");

const source = `#define STATE_COUNT 3
#define LARGE_STATE_COUNT 2
static const char * const ts_symbol_names[] = {
  [ts_builtin_sym_end] = "end",
  [anon_sym_BANG] = "raw_text",
  [sym_other] = "raw_text",
  [sym_external] = "external",
};
static const TSSymbol ts_external_scanner_symbol_map[] = {
  [ts_external_token_external] = sym_external,
};
static const TSLexMode ts_lex_modes[STATE_COUNT] = {
  [0] = {.lex_state = 0, .external_lex_state = 1},
  [1] = {.lex_state = 12, .external_lex_state = 1},
  [2] = {.lex_state = 0},
};
static const uint16_t ts_parse_table[LARGE_STATE_COUNT][SYMBOL_COUNT] = {
  [STATE(0)] = {
    [ts_builtin_sym_end] = ACTIONS(1),
    [anon_sym_BANG] = ACTIONS(3),
    [sym_external] = ACTIONS(1),
  },
  [STATE(1)] = {
    [sym_other] = ACTIONS(5),
    [sym_rule] = STATE(2),
  },
};
`;

test("error-state extraction retains enum identity, display names and internal/external roles", () => {
  const state = extractErrorState(source);
  assert.equal(state.states, 3);
  assert.equal(state.largeStates, 2);
  assert.equal(state.lexState0, 2);
  assert.deepEqual(state.tokens, [
    { name: "anon_sym_BANG", display: "raw_text", isExternal: false },
    { name: "sym_external", display: "external", isExternal: true },
    { name: "ts_builtin_sym_end", display: "end", isExternal: false }
  ]);
  assert.deepEqual(compareErrorState(state, extractErrorState(source)), []);
  assert.deepEqual(compareErrorState(state, { ...state, states: 4, largeStates: 1 }), []);
  const changed = extractErrorState(source.replace("[anon_sym_BANG] = ACTIONS(3)", "[sym_other] = ACTIONS(3)"));
  assert.deepEqual(compareErrorState(state, changed), [
    '- anon_sym_BANG "raw_text" (internal)',
    '+ sym_other "raw_text" (internal)'
  ]);
});

test("error-state extraction fails on missing generated sections or incomplete lex modes", () => {
  for (const name of ["ts_symbol_names", "ts_external_scanner_symbol_map", "ts_parse_table", "ts_lex_modes"]) {
    assert.throws(() => extractErrorState(source.replaceAll(name, "missing")), new RegExp(`${name} is missing`));
  }
  assert.throws(
    () => extractErrorState(source.replace("STATE_COUNT 3", "STATE_COUNT 4")),
    /expected 4 lex modes, got 3/
  );
  assert.throws(() => extractErrorState(source.replace("[STATE(0)]", "[STATE(2)]")), /parse state 0 is missing/);
  assert.throws(
    () => extractErrorState(source.replace('[anon_sym_BANG] = "raw_text",', "")),
    /display name for anon_sym_BANG is missing/
  );
});

test("error-state CLI records candidates and fails with actionable token and lex-state differences", t => {
  const directory = mkdtempSync(join(tmpdir(), "scss-error-state-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const parser = join(directory, "parser.c");
  const expectation = join(directory, "expectation.json");
  const invoke = (...args) =>
    spawnSync(process.execPath, [join(__dirname, "error-state.js"), "--parser", parser, ...args], { encoding: "utf8" });
  writeFileSync(parser, source);
  let result = invoke("--record", expectation);
  assert.equal(result.status, 0, result.stderr);
  const expected = extractErrorState(source);
  delete expected.states;
  delete expected.largeStates;
  assert.deepEqual(JSON.parse(readFileSync(expectation, "utf8")), expected);
  result = invoke("--expect", expectation);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^Error state: 3 parse states, 2 large states; 3 tokens \(2 internal\); 2 parse states use lex state 0\.\n$/
  );
  writeFileSync(
    parser,
    source
      .replace("STATE_COUNT 3", "STATE_COUNT 4")
      .replace("LARGE_STATE_COUNT 2", "LARGE_STATE_COUNT 1")
      .replace("[2] = {.lex_state = 0},", "[2] = {.lex_state = 0},\n  [3] = {.lex_state = 7},")
  );
  result = invoke("--expect", expectation);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Error state: 4 parse states, 1 large states;/);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  writeFileSync(
    parser,
    source
      .replace("[anon_sym_BANG] = ACTIONS(3)", "[sym_other] = ACTIONS(3)")
      .replace("[2] = {.lex_state = 0}", "[2] = {.lex_state = 7}")
  );
  result = invoke("--expect", expectation);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /- anon_sym_BANG "raw_text"/);
  assert.match(result.stderr, /\+ sym_other "raw_text"/);
  assert.match(result.stderr, /lex-state-0 sharing: 2 -> 1/);
  assert.equal(result.stderr.match(/2 -> 1/g).length, 1);
  assert.doesNotMatch(result.stderr, /sym_external|ts_builtin_sym_end/);
  assert.match(result.stderr, /ARCHITECTURE.md#error-state-gate/);
  assert.match(result.stderr, /--record <file>/);
});
