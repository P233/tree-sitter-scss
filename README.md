# tree-sitter-scss

A shared **CSS and SCSS parser for Tree-sitter**, with semantic highlighting queries and explicit boundaries for editor features. The parser, native bindings, queries, and tests form an editor-independent package. Indented Sass (`.sass`) is not supported.

For a complete Emacs editing experience, use the companion [scss2-mode project](https://github.com/P233/scss2-mode), which provides `scss2-mode` and `css2-mode`, bundles a matching parser snapshot, and integrates the independent Emmet2 package. This repository does not contain Emacs modes, completion catalogs, or abbreviation engines. The source packages can be built locally; these instructions do not imply that a registry release has already been published.

## Why this parser

CSS and SCSS share selectors, declarations, blocks, and most values, but differ at lexical boundaries. A CSS string containing `#{` is literal text; in SCSS it can start interpolation. A CSS dimension such as `1px-2px` also differs from a Sass subtraction expression. Reusing the SCSS entry for every file can therefore produce the wrong boundaries even when ordinary CSS parses correctly.

This project keeps **one grammar source and one generated parser table**, with two native language entries. An immutable dialect tag selects the small lexical differences in the scanner. There is no global language switch, duplicated generated table, or second AST to synchronize.

The tree gives consumers the structures needed to operate on a complete selector, declaration, value, query, or block. Highlighting assigns semantic roles to those same nodes. Editors own their colors, completion data, editing commands, and abbreviation integrations; the parser owns syntax and source ranges.

The benefit is a consistent structural contract across CSS and SCSS. The cost is ownership of the full grammar and its CSS compatibility work. This is not a Sass compiler, a CSS validator, or a claim of complete language coverage. Syntax errors are out of scope: the project provides no diagnostics or error messages, does not tune error recovery, and leaves `ERROR` and `MISSING` nodes uncaptured by the highlight query.

## Use the native bindings

A C/C++ toolchain is required to build the Node binding from source. The package payload includes generated C sources, so consumers do not need the Tree-sitter generator. Node.js 22.13 or later is required by this package; development uses Node.js 24.

From a checkout, create a local npm artifact:

```sh
pnpm install --frozen-lockfile
npm pack --pack-destination /tmp
# In a consuming Node project:
npm install /tmp/tree-sitter-scss-1.0.0.tgz tree-sitter@0.25.1
```

```js
const Parser = require("tree-sitter");
const Scss = require("tree-sitter-scss");

const parser = new Parser();
parser.setLanguage(Scss); // Use Scss.cssLanguage for CSS literal semantics.
const tree = parser.parse(".card { color: red; }");
console.log(tree.rootNode.toString());

const query = new Parser.Query(Scss, Scss.HIGHLIGHTS_QUERY);
console.log(query.captures(tree.rootNode));
```

The Node entry exports `language`, `nodeTypeInfo`, `HIGHLIGHTS_QUERY`, and `cssLanguage`. Both language objects expose the same node schema and query text. Native exports are `tree_sitter_scss` and `tree_sitter_stylesheet_css`; the latter's language name is `stylesheet-css`. Use the matching entry consistently when parsing and querying a tree.

Rust consumers can use a path dependency before a registry release:

```toml
[dependencies]
tree-sitter = "0.27.0"
tree-sitter-scss = { path = "../tree-sitter-scss" }
```

```rust
let mut parser = tree_sitter::Parser::new();
parser.set_language(&tree_sitter_scss::LANGUAGE.into()).unwrap();
let tree = parser.parse(".card { color: red; }", None).unwrap();
assert!(!tree.root_node().has_error());
```

Rust also exports `CSS_LANGUAGE`, `NODE_TYPES`, and `HIGHLIGHTS_QUERY`. The generated parser uses ABI 14. Node tests use the Tree-sitter 0.25.1 runtime; Rust tests use 0.27.0. Other runtime versions require their own compatibility checks. The standard CLI metadata registers the SCSS entry; selecting the CSS entry is currently a native-binding responsibility.

## Structural contract

`grammar.js` is the source of truth. `src/parser.c`, `src/grammar.json`, `src/node-types.json`, and parser headers are generated. `src/scanner.c` is authored and handles dialect-sensitive lexical boundaries. Consumers should use named fields where available and direct delimiters when they need trivia-inclusive editing ranges.

Internally, ordinary values, calculations, and query conditions share the `_expression_atom` production. Each context adds its own containers and special forms: Sass lists and maps, calculation groups and constants, or query groups and query calls. File and block endings share `_final_statement`, while property endings remain specific to their block. These hidden rules reuse parsing decisions without adding public nodes. CSS function bodies retain their own property and query productions so raw `result` values cannot escape into ordinary declarations. The scanner owns lexical exceptions; the highlight query assigns semantic roles to the resulting tree.

| Construct       | Structure and ownership                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Style rule      | `rule_set` owns its `selectors`, direct braces, and optional `body`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Selector        | `selectors` has one named child per comma item: a simple selector, a `compound_selector` of adjacent simple selectors, or a `complex_selector` of compounds joined by `combinator` nodes or by descendant whitespace, which has no node. `:is()`-style pseudos and `nth-child(… of …)` wrap their lists in `selectors`.                                                                                                                                                |
| Block           | `declaration_block` contains statements between its owner's braces. Empty or comment-only blocks have no `body` field. Its last statement, like a file's, may omit the semicolon.                                                                                                                                                                                                                                                                                      |
| Declaration     | `property_declaration` and `variable_declaration` expose `name`, ordered `value` children, and `flags`. A final semicolon may be omitted before a closing block.                                                                                                                                                                                                                                                                                                       |
| Nested property | A `property_declaration` wrapper contains `nested_property`, which owns the prefix, optional value, and child block. It remains distinct from a nested selector.                                                                                                                                                                                                                                                                                                       |
| At-rule         | Specialized statements retain headers and optional bodies. `if_statement` owns its dependent `else_clause` nodes. Unknown `at_rule` bodies preserve recognized statements and a narrow raw fallback.                                                                                                                                                                                                                                                                   |
| Query           | `query_statement` exposes a `prelude`; nested conditions use `query_group`. Query functions such as `media()`, `supports()`, `style()`, and `scroll-state()` wrap their condition in the same `query_group`. `feature_query` retains the full declaration value, including commas and raw custom-property groups.                                                                                                                                                      |
| Arguments       | `arguments` has one named child per comma item: a single atom, `named_argument`, `feature_query`, or an `argument` wrapping several atoms. CSS `var()` keeps everything after its first comma as one fallback.                                                                                                                                                                                                                                                         |
| Expression      | Calls, parameters, Sass maps/lists, raw groups, strings, and interpolation retain explicit containers. An author-defined `--` name is a `dashed_name` inside its `property_name` or `plain_value`; a CSS function name keeps `function_name`. Expressions otherwise keep ordered atoms rather than an evaluation AST. A `-` directly before a number belongs to that `number`, except that Sass reads it as subtraction right after another number (`1-1`, `1px-2px`). |

Additional fields include `condition`, `parameters`, `arguments`, `module`, and `alias` on their respective owners. **Fields are not always singular:** `value`, `prelude`, and `condition` may contain multiple ordered children, including anonymous commas. Comments remain separate extras. Empty declarations have no value node. Do not treat the first matching field child as the whole expression, or require a body node before recognizing braces.

The complete machine-readable contract is in [src/node-types.json](src/node-types.json). Structural tests cover field roles, text ranges, nested ownership, empty forms, one-node-per-item selector and argument lists, and incremental edits. Consumers should update their grammar snapshot, queries, and schema assumptions together when upgrading. A compatible parser ABI does not imply compatibility with a different grammar's node schema.

## Highlighting design

[queries/highlights.scm](queries/highlights.scm) maps syntax nodes to semantic roles: selectors, properties, modules, functions, variables, literals, operators, comments, strings, and punctuation. Editors map these captures to their own theme. The preview theme in `scripts/preview.config.json` is a development aid, not part of the language contract; it gives every capture a distinct color so a changed role is visible.

Captures follow the parsed element: a number is a number and a function name is a function, including inside raw payloads. Base captures cover complete names and literals; contextual captures refine roles such as map keys and media features. Every `--` name is a variable in both dialects, following Sass variables, while CSS function names remain functions. A wildcard takes the role of the name it replaces, and selector sigils (`.`, `#`, `%`, `:`) are delimiters. Interpolation and escapes retain their own captures within strings and names. There is no catch-all error capture to hide unsupported syntax.

Keywords and parameters carry Neovim-style sub-roles: `keyword.import` (`@use`, `@forward`, `@import`, and their `as`, `show`, `hide`, `with`), `keyword.conditional`, `keyword.repeat`, `keyword.return`, `keyword.debug`, `keyword.exception` (`@error`), `keyword.directive` (CSS at-rules and unknown at-keywords), `keyword.modifier` (`!default`, `!global`, `!optional`, `!important`), and `variable.parameter` (declared parameters and named call arguments). `@mixin`, `@function`, `@include`, and the other directives stay `keyword`. Highlighters fall back from a sub-role to its prefix, but `tree-sitter-highlight` matches name parts in any order, so no sub-role repeats another role's name; `keyword.function` would render as `function`, and a test enforces the rule. The keyword sub-roles are outside the Tree-sitter CLI's standard list, so `tree-sitter highlight --check` lists them; the warning appears only when `--check` is requested.

For the same text range, a later pattern overrides an earlier one. Tree-sitter CLI 0.27 renders captures this way; a highlighter that keeps the first match, as `tree-sitter-highlight` 0.20 did, loses the contextual roles. The `Context overrides` section is kept separately identifiable for consumers that apply those captures after base colors, and a test pins its marker and the closed set of capture names that editor face tables map.

Raw custom-property values use balanced delimiters instead of SassScript expression parsing. The literal `--` prefix selects that rule. Their CSS tokens keep typed nodes (numbers, strings, colors, words, calls, operators, and delimiters), but a raw payload never contains a Sass variable, boolean, null, or evaluated expression; text such as `$name`, file names, and `//` runs remain `raw_text` strings. Unknown at-rule preludes use the same tokens, except that `//` starts a comment there. A fully interpolated property name retains SassScript values. A trailing priority is an `important` node outside the raw payload. CSS `result` descriptors use raw values only within a dashed-name CSS function and its conditional query bodies.

The stress fixture's 58 active sections are tested individually and together. They exercise modules, mixins, functions, content blocks, control flow, nested declarations, escaped identifiers, selector variants, raw custom properties, URLs, modern CSS directives, conditional values, and interpolation. Tests distinguish parse validity, character coverage, capture roles, token ranges, and incremental behavior. Every character receiving a capture does not prove its role is correct or that every possible input is supported.

## Comparison with upstream SCSS grammars

The reference is [tree-sitter-grammars/tree-sitter-scss at `2ef6d42`](https://github.com/tree-sitter-grammars/tree-sitter-scss/tree/2ef6d42e3ad7a8208900f9346f4529806ae0f9f9), not every project with the same name or its current main branch. That grammar extends `tree-sitter-css`; this project maintains its complete grammar locally. Its implementation is visible in the [pinned grammar source](https://github.com/tree-sitter-grammars/tree-sitter-scss/blob/2ef6d42e3ad7a8208900f9346f4529806ae0f9f9/grammar.js).

| Decision          | This project                                                                                        | Pinned comparison                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Grammar ownership | One locally maintained CSS/SCSS grammar                                                             | SCSS extensions over the CSS grammar                                           |
| Language entries  | CSS and SCSS share tables with lexical dialect differences                                          | One SCSS entry                                                                 |
| Declarations      | Distinct property, variable, and nested-property nodes                                              | Shared declaration form                                                        |
| Expression model  | Ordered atoms with explicit grouping and role fields                                                | Includes nested binary expressions                                             |
| Main tradeoff     | Direct control over boundaries for consistent editor operations; owns CSS compatibility maintenance | Can inherit work from the CSS grammar; consumers adapt to its inherited schema |

This project is useful when CSS/SCSS consumers need the same node roles and source boundaries. The upstream approach can be preferable when compatibility with that ecosystem's existing queries or tree schema matters more. These are architectural differences, not a comprehensive compatibility score or a performance ranking. The queries and node schemas are not drop-in replacements for one another.

## Known limits

- Indented Sass is unsupported. CSS mode changes lexical interpretation, but shares the grammar's tolerant structures; it is not a strict CSS-only validator.
- Expressions do not provide precedence-aware evaluation, scope checking, module resolution, unit arithmetic, or browser-support validation. Some unfinished editor input is intentionally accepted.
- Keywords, directives, and the custom-property `--` prefix match literal spellings only; CSS keywords also accept any letter case. CSS and Sass decode escaped spellings such as `@m\65 dia` or `c\61 lc(pi)`, but this parser keeps them as ordinary identifiers. Most degrade to generic nodes; forms such as `!\69mportant` or `:nth-child(2\6e+1)` produce parse errors.
- General identifiers with hexadecimal escapes spanning CRLF are not fully covered. Units handle CRLF locally.
- Typed `attr()` unions such as `attr(data-width type(<length> | <percentage>), 10px)` still produce a parse error.
- Inside Sass `url()`, a function call keeps its callee as one `function_name`; `url(map.get($icons, x))` does not split out a `module_name`.
- Comma-separated declaration values and Sass lists keep their items as ordered atoms without item nodes. A unary minus attaches only to numbers, so `-$x` stays an operator and a variable.
- Unspaced Sass subtraction is recognized only after a number, so `fn()-1` reads as a call followed by `-1`.
- Raw payloads split an unquoted URL into CSS tokens, so `url(https://a.test/x.png)` inside a custom property reads as a word, a colon, and a `//` string. Words joined by other punctuation, such as `foo.png`, stay one `raw_text` string.
- The shared query cannot tell dialects apart, so CSS highlights a `//` line as a comment although CSS has no line comments.
- A descendant combinator is read from whitespace directly before the next compound, so `.a /* c */.b` reads as one compound selector. A spaced pseudo-class is a descendant only when a block follows, so `@extend .a :hover;` reads `.a:hover`.
- Unknown at-rule fallback accepts only selected semicolon-terminated payloads and balanced groups. Arbitrary unsupported syntax is not silently reclassified as valid.
- Extreme nesting around external tokens can be expensive in runtime changed-range calculation. Descendant selectors use a scanner token, so a local test editing the innermost of 100 nested rules spent about 1 ms in that phase, and about 95 ms at 1,000 levels; realistic nesting and large real files showed no change. These are specific observations, not cross-platform benchmarks. Ordinary numbers and units stay in the generated lexer; complex unit cases still require the scanner.

The broader feature wishlist in `test/example.scss` and commented error examples are not promises of implemented support.

## Develop and verify

Use Node.js 24, pnpm 11.25.0, Python, a C/C++ compiler, and a current stable Rust toolchain with `rustfmt`. No Emacs installation is required for this repository's checks.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

The live preview opens at **http://127.0.0.1:4173** and displays real syntax trees, CLI highlights, and parse/build errors. It listens only on loopback. Source, query, and theme edits rerender; grammar and metadata edits also rebuild. Stop with Ctrl+C, and restart after editing development scripts.

```sh
pnpm dev examples/highlight-stress.scss --port 4174
pnpm preview                         # Export build/preview/index.html
pnpm parse                           # Parse examples/basic.scss with the CLI
pnpm highlight                       # Highlight that same file
```

| Command                | Purpose                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm generate`        | Regenerate parser C, headers, and metadata at ABI 14                                                               |
| `pnpm build`           | Build the Node native binding                                                                                      |
| `pnpm check:generated` | Compare a temporary generation against committed output without overwriting it; enforce the large-state budget     |
| `pnpm test`            | Generate, build, and run parser/highlight and Node tests                                                           |
| `pnpm test:parser`     | Corpus structure and highlight assertions                                                                          |
| `pnpm test:node`       | Binding, semantic coverage, incremental parsing, and development-tool tests                                        |
| `pnpm test:rust`       | Rust binding and documentation tests                                                                               |
| `pnpm check:package`   | Verify npm/Cargo payloads contain the complete parser and no unrelated files; check version agreement              |
| `pnpm check`           | Lint, formatting, generated output, build, all parser tests, package contents, Rust formatting, and preview export |

The complete check verifies generated files before rebuilding, so stale output cannot pass by being silently regenerated. It also caps large parse states, which Tree-sitter stores as dense symbol-width rows and which dominate parser size; a sudden rise usually means a token choice became valid in many states. Node tests run serially because development-tool tests rebuild artifacts. Builds and exported previews live in ignored `build/`; building the native binding replaces that directory. CLI libraries are isolated per checkout. The preview inspects the native tree's error flag as well as CLI output, including missing nodes.

GitHub Actions runs the same check on Linux and macOS. The editor package owns Emacs and Emmet integration tests. A successful local check does not establish that a hosted workflow has executed.

## Release boundary

The npm payload contains grammar sources, generated parser files, scanner, queries, Node binding, metadata, README, and license. The Cargo crate contains the corresponding Rust binding. Neither contains Emacs code, completion data, development dependencies, or build products. Cargo include paths are anchored to the repository root to avoid accidentally packaging similarly named files from dependencies.

Before a release, update the version consistently in `package.json`, `Cargo.toml`, and `tree-sitter.json`, then run `pnpm check`. Inspect `npm pack --dry-run` and `cargo package --list` when intentionally changing the payload. Local artifact creation is separate from publication:

```sh
npm pack --pack-destination /tmp
cargo package --allow-dirty
```

Use a reviewed clean release checkout for actual publication. The parser is licensed under [MIT](LICENSE). The companion editor project owns its distribution and bundled-parser version independently.
