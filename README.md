# tree-sitter-scss

**This project is not affiliated with the official [tree-sitter-grammars/tree-sitter-scss](https://github.com/tree-sitter-grammars/tree-sitter-scss).** It is a Tree-sitter parser written from scratch for both SCSS and CSS: the grammar is designed around SCSS, and CSS support comes automatically from a second language entry of the same parser. Indented Sass (`.sass`) is not supported.

## Why it exists

The parser is built to give two Emacs packages a syntax tree they can act on:

- **Structural editing in [scss2-mode](https://github.com/P233/scss2-mode).** Kill, copy, duplicate, empty, and substitute whole selector branches, declarations, values, arguments, and blocks, following the approach of [JSX Jedi](https://github.com/P233/jsx-jedi) for JSX/TSX. Every target's range comes from the syntax tree, in CSS and SCSS alike.
- **Context-aware completion with [emmet2-mode](https://github.com/P233/emmet2-mode).** The syntax role at point decides what to offer: at-rules after `@`, properties at the start of a declaration, values after the colon, custom properties inside `var()`, and Sass variables, mixins, and module members. It also decides where an Emmet abbreviation such as `m10` may expand into `margin: 10px;`.

Emacs users should install scss2-mode, which bundles this parser. This repository contains only the grammar, scanner, highlight query, and Node/Rust bindings. The packages are not published to npm or crates.io, where the `tree-sitter-scss` name belongs to the official grammar; see [Use from source](#use-from-source).

## Compared with the official grammar

The official grammar extends `tree-sitter-css` with SCSS rules. This project is one grammar for both dialects, shaped for structural editing and context-aware completion. Measured with Tree-sitter CLI 0.27.0 against the official grammar at commit [`2ef6d42`](https://github.com/tree-sitter-grammars/tree-sitter-scss/tree/2ef6d42e3ad7a8208900f9346f4529806ae0f9f9); the real-code row uses rhythm-sass at commit [`76aac68`](https://github.com/P233/rhythm-sass/tree/76aac6827bdd80d439579f0cf93cad78cd6d7fc7):

|                   | This project                                                                          | Official                                                                        |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| CSS               | Second entry of the same parser, with the same node schema and query                  | Separate `tree-sitter-css`, whose schema no longer matches the SCSS one         |
| Everyday Sass     | Parses cleanly                                                                        | Errors on `!default`, `@use ... as`, maps, `@include ns.mixin`, `$args...`      |
| Real code         | [rhythm-sass](https://github.com/P233/rhythm-sass) (1,157 non-blank lines): no errors | 700 error nodes; 37% of non-blank lines fall inside `ERROR`                     |
| Empty value       | `color: ;` is a declaration without a value                                           | A zero-width `integer_value` with a MISSING number token; the tree has an error |
| Selectors         | Flat compounds with explicit combinator nodes                                         | Left-nested: the `:hover` node in `.a .b:hover` spans the whole selector        |
| Declarations      | Property and variable declarations, including nested properties                       | One declaration node; nested properties are errors                              |
| Fields            | `selectors`, `body`, `name`, `value`, `prelude`, `condition`                          | None on rules, declarations, or CSS at-rules                                    |
| Custom properties | Raw token payload                                                                     | Parsed as Sass: `0 / 20%` inside `rgb()` becomes a division                     |

Coverage matters beyond highlighting: node ranges inside an `ERROR` cannot be trusted, so scss2-mode refuses structural edits there. The costs are owning all CSS compatibility work and a generated parser about five times larger (4.1 MB of generated C against 0.79 MB). The node schema and highlight query are not interchangeable with the official grammar's.

## Use from source

Both bindings compile the generated C sources, so they need a C/C++ compiler; the Node build also needs Python. Clone a release tag and pack it for Node:

```sh
git clone --branch v0.10.0 https://github.com/P233/tree-sitter-scss.git
cd tree-sitter-scss
npm pack  # Writes tree-sitter-scss-0.10.0.tgz
```

In a Node project next to the checkout, installing the tarball compiles the binding:

```sh
npm install ../tree-sitter-scss/tree-sitter-scss-0.10.0.tgz tree-sitter@0.25.1
```

```js
const Parser = require("tree-sitter");
const Scss = require("tree-sitter-scss");

const parser = new Parser();
parser.setLanguage(Scss); // Scss.cssLanguage for CSS
const tree = parser.parse(".card { color: $accent; }");
const captures = new Parser.Query(Scss, Scss.HIGHLIGHTS_QUERY).captures(tree.rootNode);
```

In Rust, depend on the checkout by path:

```toml
[dependencies]
tree-sitter = "0.27.0"
tree-sitter-scss = { path = "../tree-sitter-scss" }
```

```rust
let mut parser = tree_sitter::Parser::new();
parser
    .set_language(&tree_sitter_scss::LANGUAGE.into()) // CSS_LANGUAGE for CSS
    .expect("load SCSS");
let tree = parser.parse(".card { color: $accent; }", None).unwrap();
```

## Consumer contract

- **Language entries:** `scss` (native symbol `tree_sitter_scss`) and `stylesheet-css` (`tree_sitter_stylesheet_css`). The generated parser uses ABI 14 and is tested with Tree-sitter 0.25.1 in Node and 0.27.0 in Rust. `tree-sitter.json` registers only SCSS; native consumers select the CSS entry explicitly.
- **Bindings:** Node exports `language`, `cssLanguage`, `nodeTypeInfo`, and `HIGHLIGHTS_QUERY`; Rust exports `LANGUAGE`, `CSS_LANGUAGE`, `NODE_TYPES`, and `HIGHLIGHTS_QUERY`. Both entries share one node schema and one query.
- **The CSS entry differs only lexically:** `#{` inside a string stays literal and `1px-2px` is one dimension. Sass syntax in a `.css` file still parses without errors, and neither entry reports semantic problems such as undefined variables.
- **Fields are not always singular:** `value`, `prelude`, and `condition` may hold several ordered children, including anonymous commas. Do not treat the first field child as the whole expression.
- **Declaration values and Sass lists are ordered atoms:** there is no evaluation tree and no node per comma-separated item, so split on the comma children. Call arguments and maps do have item nodes: several atoms in one argument are wrapped in `argument`, and each map pair is a `map_entry`. `-10px` is one number, while `-$gutter` is an operator followed by a variable.
- **Nested properties use `property_declaration` directly:** `name`, optional `value`, and optional `body` belong to the same node, with direct braces even when the property block is empty. There is no public `nested_property` wrapper.
- **Selector-taking pseudo arguments are direct branches:** `selector_arguments` contains its parentheses, comma-separated selector branches, and comments without an inner `selectors` node. Value-taking pseudos such as `:lang()` instead contain value nodes; the `of` list in `nth_arguments` retains its own `selectors` node.
- **Selector lists can hold empty items:** Sass accepts `a, , b` and a trailing comma, so a `,` child may be followed by another comma, the block, or a closing parenthesis instead of a selector.
- **Block boundaries:** the owning rule, declaration, or directive has direct `{` and `}` children. Use those delimiters to identify the complete block interior, including comments and whitespace. The optional `body` only groups content; it can begin or end with a statement comment, and a comment-only block can have a `body`.
- **Empty forms:** an empty block has no `body` and an empty declaration has no `value`, so recognize the braces or colon without requiring content nodes.
- **Comments and strings:** a `/* */` comment in a statement position is a `block_comment` child; other comments are extras with literal text, and `//` comments never parse interpolation. In SCSS, statement comments and strings parse `#{…}` when its closing brace follows without leaving the enclosing block, statement, comment, or string, and the expression may span lines. An opener without such a closer stays literal text as an editing tolerance, even though Sass may reject it.
- **Statements being typed:** whitespace that crosses a line break is a descendant combinator unless lookahead reaches a statement terminator before a block opens. This scan has a 1,024-step budget that comments spend too, and the selector continues when the budget runs out. A selector typed on its own line above another statement is therefore one `ERROR` node and leaves that statement intact, as is a single compound that ends with a comma, a combinator or an opening parenthesis above a declaration. A longer selector ending that way, and unfinished `@if`/`@each` conditions, can still absorb the next statement until their block is typed, and an unclosed `#{` outside comments and strings pairs with the next `}`.
- **Versioning:** keep the parser, [node schema](src/node-types.json), and [highlight query](queries/highlights.scm) on the same revision. A compatible ABI does not make another grammar's schema or queries interchangeable with these.

## Highlighting

[queries/highlights.scm](queries/highlights.scm) assigns semantic roles; editors map the captures to their own faces. Most captures are standard Tree-sitter names such as `property`, `variable`, `function`, `module`, `string`, and `punctuation.delimiter`; `variable.parameter` marks declared parameters and named call arguments. Keywords carry Neovim-style sub-roles outside the Tree-sitter CLI's standard list:

- `keyword.import`, `keyword.conditional`, `keyword.repeat`, `keyword.return`, `keyword.debug`, and `keyword.exception` for Sass directives and their clause words.
- `keyword.directive` for CSS at-rules and unknown at-keywords.
- `keyword.modifier` for `!default`, `!global`, `!optional`, and `!important`.

The query expects a later capture of the same range to override an earlier one, as the Tree-sitter CLI does. A host highlighter must apply captures in that order; in Emacs, that means `:override t` on the font-lock rules. The `; Context overrides` section refines base roles such as map keys, query features, and parameters, so it depends on this order. The query has no `ERROR` pattern, but zero-width `MISSING` punctuation can still be captured: a missing `]` becomes `punctuation.bracket`.

## Known limits

In about 680,000 lines from 14 popular CSS and SCSS frameworks, such as Bootstrap 5.3 and Bulma 1.0, only the unspaced subtraction below appeared, on a single line.

- Escaped identifiers retain their source spelling, but escaped keywords such as `c\61 lc`, `@m\65 dia`, and `:l\61 ng` use generic syntax instead of their specialized roles. Keyword-only forms such as escaped `!important`, and escapes inside `An+B` formulas, may produce a parse error. Numeric constants in calculations and CSS `var()` keep their scanner-based escape support. CSS consumes CRLF as one escape terminator; SCSS retains its single-character terminator, so `.x\31`, CRLF, `b` reads as a descendant selector in SCSS.
- In comments and strings, interpolation pairing has a 1,024-step lookahead budget, with each nested opener spending 64 extra steps. This is not a byte or character limit: a step can consume an identifier or escape, and spaces after a URL opener have a separate scan. If the expression contains the comment's `*/`, or in a string its own quote or a line break, the comment or string must end on the closing line or open another interpolation there.
- Typed `attr()` unions such as `attr(data-width type(<length> | <percentage>), 10px)` produce a parse error.
- A descendant combinator is read from whitespace directly before the next compound, so `.a /* c */.b` is one compound selector. A name glued to the preceding simple selector, as in `[x]a`, is a parse error; Sass reads it as a descendant.
- Unspaced subtraction after a closing parenthesis reads as a negative number: `fn()-1` and `($s)-1` both end with the number `-1` instead of a subtraction.
- Inside Sass `url()`, `url(map.get($icons, x))` keeps `map.get` as one `function_name` without a `module_name`. Inside raw custom-property values, `url(https://a.test/x.png)` splits into the word `https`, a colon, and the raw text `//a.test/x.png`.
- With 1,000 nested rules, adding a descendant combinator to the innermost selector spent about 50 ms computing incremental changed ranges on an Apple M1 Pro; other edits, and the same edit at 100 levels, stayed under 1 ms. The deepest block nesting in the sample was 11 levels.

## Development

Requires Node.js 24, pnpm, Python, a C/C++ compiler, and a stable Rust toolchain with `rustfmt`.

```sh
pnpm install --frozen-lockfile
pnpm check   # Lint, generated-output check, build, parser/Node/Rust tests, package contents
pnpm dev     # Live preview of trees and highlights at http://127.0.0.1:4173
```

`grammar.js` and `src/scanner.c` are the authored sources; `pnpm generate` regenerates everything else under `src/`.

After `pnpm build`, run native acceptance tests with `pnpm test:node` or the development tooling and preview tests with `pnpm test:development`. `pnpm benchmark` reports reproducible parsing and editing workloads. See [Architecture](ARCHITECTURE.md) for ownership, invariants, and comparison instructions.

## License

[MIT](LICENSE)
