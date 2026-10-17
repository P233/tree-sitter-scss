const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const Scss = require("./index.js");
const { effectiveCaptures } = require("./highlight_roles.js");

function captures(source, language) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, source);
  return effectiveCaptures(new Parser.Query(language, Scss.HIGHLIGHTS_QUERY), tree.rootNode);
}

function assertRole(captures, text, expected, excluded = []) {
  const roles = captures.filter(({ node }) => node.text === text).map(({ name }) => name);
  assert.ok(roles.includes(expected), `${text}: expected ${expected}, got ${roles}`);
  for (const role of excluded) assert.ok(!roles.includes(role), `${text}: unexpected ${role}`);
}

// CSS Values 4, sections 10.1-10.6: https://www.w3.org/TR/css-values-4/#math
const mathFunctions = [
  "calc",
  "min",
  "max",
  "clamp",
  "round",
  "mod",
  "rem",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "pow",
  "sqrt",
  "hypot",
  "log",
  "exp",
  "abs",
  "sign"
];

test("math functions are ordinary calls whose constants are plain values in both dialects", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of mathFunctions) {
      for (const spelling of [name, name.toUpperCase()]) {
        const result = captures(`.sample { width: ${spelling}(pi); }`, language);
        assertRole(result, spelling, "function");
        assertRole(result, "pi", "constant", ["constant.builtin"]);
      }
    }
  }
});

test("math-named Sass functions retain named arguments and complete list syntax", () => {
  for (const [name, argument] of [
    ["min", "$value: 1px"],
    ["abs", "[1, 2]"],
    ["sqrt", "(1, 2)"]
  ]) {
    const result = captures(
      `@function ${name}($value) { @return $value; } .sample { width: ${name}(${argument}); }`,
      Scss
    );
    assertRole(result, name, "function");
  }
});

test("conditional named arguments share parameter roles without changing configuration variables", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const result = captures(
      '@use "theme" with ($configured: $value); @forward "theme" with ($forwarded: $value); ' +
        "$x: if($condition: $value, $if-true: 1, $if-false: 2); $y: foo($ordinary: $value);",
      language
    );
    for (const name of ["$condition", "$if-true", "$if-false", "$ordinary"]) {
      assertRole(result, name, "variable.parameter", ["variable"]);
    }
    for (const name of ["$configured", "$forwarded", "$value"]) {
      assertRole(result, name, "variable", ["variable.parameter"]);
    }
  }
});

test("literal value pseudos retain value roles while escaped names use generic selector arguments", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [pseudo, argument] of [
      [":LANG", "en"],
      [":DiR", "rtl"],
      ["::PART", "label"],
      ["::HIGHLIGHT", "search"],
      ["::VIEW-TRANSITION-OLD", "root"],
      [String.raw`:l\61 ng`, "en"],
      [String.raw`:d\69 r`, "rtl"],
      [String.raw`::p\61 rt`, "label"],
      [String.raw`::h\69 ghlight`, "search"],
      [String.raw`::view-transit\69 on-new`, "root"]
    ]) {
      assertRole(
        captures(`.sample${pseudo}(${argument}) {}`, language),
        argument,
        pseudo.includes("\\") ? "tag" : "constant"
      );
    }
  }
});

test("selector-taking pseudo arguments remain selectors across case and CSS escapes", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const pseudo of [":NOT", ":IS", ":WHERE", ":HAS", String.raw`:\6e ot`, String.raw`:\69 s`]) {
      assertRole(captures(`.sample${pseudo}(button) {}`, language), "button", "tag", ["constant", "constant.builtin"]);
    }
  }
});

test("view-transition value arguments cover wildcards and group-children names", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const pseudo of ["group", "group-children", "image-pair", "old", "new"]) {
      assertRole(captures(`::view-transition-${pseudo}(*) {}`, language), "*", "constant", [
        "operator",
        "operator.expression"
      ]);
      assertRole(captures(`::view-transition-${pseudo}(card) {}`, language), "card", "constant", ["tag"]);
    }
  }
});

test("An+B formulas accept either letter case without losing their selector boundary", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const formula of ["2N+1", "-n + 3", "+5", "-2N+3"]) {
      const result = captures(`.a:nth-child(${formula} of .b) {} .after {}`, language);
      assertRole(result, formula, "number");
      assertRole(result, ".b", "attribute");
      assertRole(result, ".after", "attribute");
    }
  }
});

test("Sass keyword prefixes remain inside complete interpolated names", () => {
  for (const word of ["true", "false", "null", "not", "and", "or", String.raw`tr\75 e`]) {
    const name = `${word}#{$suffix}`;
    const result = captures(`.a { value: ${name}; }`, Scss);
    assertRole(result, name, "constant", ["constant.builtin", "operator", "operator.expression"]);
    assertRole(result, "$suffix", "variable");
    assert.ok(!result.some(({ name }) => ["constant.builtin", "operator", "operator.expression"].includes(name)));
  }
});

test("Sass operators retain grouped operands and CRLF retains value-item boundaries", () => {
  const result = captures(".a { a: not(false); b: 1 and(2); c: 1 or(2); d: foo\\61\r\nbar; }", Scss);
  for (const word of ["not", "and", "or"]) assertRole(result, word, "operator.expression", ["function"]);
  assertRole(result, "foo\\61\r", "constant");
  assertRole(result, "bar", "constant");
  // A legacy if() argument may start with a Sass word operator, which a CSS if() condition shares.
  for (const source of [
    "$x: if(not $a, 1, 2);",
    "@function f($v) { @return if(not index($l, $v), null, $v); }",
    "$x: if((not $a), 1, 2);"
  ]) {
    assertRole(captures(source, Scss), "not", "operator.expression", ["operator"]);
  }
});

test("custom names are variables and raw payload tokens keep CSS roles in both dialects", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    const result = captures(
      ":root { --brand: oklch(60% 0.2 250); --gap: calc(4px * 2), $ink; } .a { color: var(--brand); } @property --gap {}",
      language
    );
    assertRole(result, "--brand", "variable", ["property", "constant"]);
    assertRole(result, "--gap", "variable", ["property", "constant"]);
    assertRole(result, "oklch", "function", ["string"]);
    assertRole(result, "0.2", "number", ["string"]);
    assertRole(result, "*", "operator.expression", ["string"]);
    assertRole(result, "$ink", "string", ["variable"]);
  }
});

test("dashed names still serve as module namespaces and dotted words", () => {
  const result = captures('@use "x" as --a; $x: --a.$b, --a.fn(1), --a.b;', Scss);
  assert.deepEqual(
    result.filter(({ name }) => name === "module").map(({ node }) => node.text),
    ["--a", "--a", "--a"]
  );
  assertRole(result, "--a.b", "constant");
});
