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

for (const name of mathFunctions) {
  test(`numeric constants belong to ${name} calculations in both dialects`, () => {
    for (const language of [Scss, Scss.cssLanguage]) {
      for (const spelling of [name, name.toUpperCase()]) {
        const result = captures(`.sample { width: ${spelling}(pi); }`, language);
        assertRole(result, spelling, "function");
        assertRole(result, "pi", "constant.builtin");
      }
    }
  });
}

test("escaped numeric constants retain builtin roles inside literal calculation names", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [call, constant] of [
      [String.raw`calc(p\69)`, String.raw`p\69`],
      [String.raw`calc(\000070i)`, String.raw`\000070i`],
      [String.raw`sqrt(\pi)`, String.raw`\pi`],
      [String.raw`acos(\65)`, String.raw`\65`],
      [String.raw`calc(inf\69 nity)`, String.raw`inf\69 nity`],
      [String.raw`calc(N\61 N)`, String.raw`N\61 N`]
    ]) {
      assertRole(captures(`.sample { width: ${call}; }`, language), constant, "constant.builtin", ["constant"]);
    }
  }
});

test("escaped calculation names remain ordinary calls with complete escape boundaries", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of [
      String.raw`\63\61lc`,
      String.raw`\63\61\6c\63`,
      String.raw`\6D in`,
      String.raw`c\61 lc`,
      String.raw`\000063alc`,
      String.raw`\sqrt`,
      String.raw`a\63 os`,
      String.raw`\63alc`,
      String.raw`\6Dax`,
      String.raw`\61bs`,
      String.raw`c\61  lc`
    ]) {
      assertRole(captures(`.a { width: ${name}(pi); }`, language), "pi", "constant", ["constant.builtin"]);
    }
    for (const name of [String.raw`\65e`, String.raw`\000065extra`]) {
      assertRole(captures(`.a { width: calc(${name}); }`, language), name, "constant", ["constant.builtin"]);
    }
  }
});

test("nested calls and parenthesized math expressions retain numeric constant roles", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const [call, constants] of [
      ["calc(sqrt(pi) + min(e, max(infinity, 1)))", ["pi", "e", "infinity"]],
      ["calc((pi + e))", ["pi", "e"]],
      ["round(up, acos(pi / 4), 1)", ["pi"]]
    ]) {
      const result = captures(`.sample { width: ${call}; }`, language);
      for (const constant of constants) assertRole(result, constant, "constant.builtin");
    }
  }
});

test("ordinary and module-qualified functions do not acquire calculation constants", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const call of [
      "ordinary(pi)",
      "calc(ordinary(pi))",
      "theme.calc(pi)",
      "calc(theme.calc(pi))",
      "calc(var(--value, pi))",
      String.raw`theme.c\61 lc(pi)`,
      String.raw`c\61 lcx(pi)`
    ]) {
      assertRole(captures(`.sample { width: ${call}; }`, language), "pi", "constant", ["constant.builtin"]);
    }
  }
});

test("numeric keyword module aliases remain module references inside calculations", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["pi", "e", "infinity", "NaN", String.raw`p\69`]) {
      const result = captures(`.sample { width: calc(${name}.$value); }`, language);
      assertRole(result, name, "module", ["constant.builtin"]);
      assertRole(result, "$value", "variable");
    }
  }
});

test("numeric keyword function names retain function roles inside calculations", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["pi", "e", "infinity", "NaN", String.raw`p\69`]) {
      const result = captures(`.sample { width: calc(${name}(1)); }`, language);
      assertRole(result, name, "function", ["constant.builtin"]);
    }
  }
});

test("interpolation and identifier suffixes do not leave a builtin keyword prefix", () => {
  for (const language of [Scss, Scss.cssLanguage]) {
    for (const name of ["pi", "e", "infinity", "NaN", String.raw`p\69`]) {
      const dynamic = `${name}#{$suffix}`;
      const result = captures(`.sample { width: calc(${dynamic}); }`, language);
      assertRole(result, dynamic, "constant", ["constant.builtin"]);
      assertRole(result, "$suffix", "variable");
      assert.ok(!result.some(({ name }) => name === "constant.builtin"), dynamic);
      assertRole(captures(`.sample { width: calc(${name}extra); }`, language), `${name}extra`, "constant", [
        "constant.builtin"
      ]);
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
