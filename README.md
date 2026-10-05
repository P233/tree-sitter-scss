# tree-sitter-scss

**This project is not affiliated with the official [tree-sitter-grammars/tree-sitter-scss](https://github.com/tree-sitter-grammars/tree-sitter-scss).** It is a Tree-sitter parser written from scratch for SCSS and CSS: the grammar is designed around SCSS, and CSS is a second language entry of the same parser. Indented Sass (`.sass`) is not supported.

It was built for [scss2-mode](https://github.com/P233/scss2-mode), which reads the tree for structural editing, completion, and [emmet2-mode](https://github.com/P233/emmet2-mode) abbreviations; Emacs users should install scss2-mode, which bundles this parser. Nothing here is published to npm or crates.io, where the `tree-sitter-scss` name belongs to the official grammar; see [Use from source](#use-from-source).

## Compared with the official grammar

The official grammar extends `tree-sitter-css`; this one serves both dialects with one parser, schema, and query. Measured with Tree-sitter CLI 0.27.0, the official grammar at [`2ef6d42`](https://github.com/tree-sitter-grammars/tree-sitter-scss/tree/2ef6d42e3ad7a8208900f9346f4529806ae0f9f9) errors on everyday Sass such as `!default`, `@use ... as`, maps, `@include ns.mixin`, and `$args...`: on the 1,157 non-blank lines of [rhythm-sass `76aac68`](https://github.com/P233/rhythm-sass/tree/76aac6827bdd80d439579f0cf93cad78cd6d7fc7), it reports 700 error nodes, with 37% of the lines inside `ERROR`, where this parser reports none. It also left-nests selectors, so the `:hover` node in `.a .b:hover` spans the whole selector; has no fields on rules, declarations, or CSS at-rules; reports nested properties as errors; and parses custom-property values as Sass.

Node ranges inside an `ERROR` cannot be trusted, so scss2-mode refuses structural edits there. The costs are owning all CSS compatibility work and a generated parser about five times larger (4.1 MB of C against 0.79 MB). The schema and query are not interchangeable with the official ones.

## Use from source

Both bindings compile the generated C sources, so they need a C/C++ compiler; the Node build also needs Python. Pack a checkout for Node:

```sh
git clone https://github.com/P233/tree-sitter-scss.git
cd tree-sitter-scss && npm pack  # Writes tree-sitter-scss-0.11.0.tgz
```

In a Node project next to the checkout, installing the tarball compiles the binding:

```sh
npm install ../tree-sitter-scss/tree-sitter-scss-0.11.0.tgz tree-sitter@0.25.1
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
parser.set_language(&tree_sitter_scss::LANGUAGE.into()).expect("load SCSS"); // CSS_LANGUAGE for CSS
let tree = parser.parse(".card { color: $accent; }", None).unwrap();
```

## Consumer contract

- **Entries and bindings:** `scss` (native symbol `tree_sitter_scss`) and `stylesheet-css` (`tree_sitter_stylesheet_css`) share one node schema and one query. Node exports `language`, `cssLanguage`, `nodeTypeInfo`, and `HIGHLIGHTS_QUERY`; Rust exports `LANGUAGE`, `CSS_LANGUAGE`, `NODE_TYPES`, and `HIGHLIGHTS_QUERY`. The parser uses ABI 14 and is tested with Tree-sitter 0.25.1 in Node and 0.27.0 in Rust; `tree-sitter.json` registers only SCSS.
- **The CSS entry differs only lexically:** for example, `#{` in strings and comments stays literal, and `1px-2px` is one dimension. Sass syntax in a `.css` file still parses without errors; neither entry reports semantic problems such as undefined variables.
- **Fields are not always singular:** `value`, `prelude`, and `condition` may hold several ordered children, including anonymous commas.
- **Values are ordered atoms:** declaration values and Sass lists have no evaluation tree and no node per comma-separated item, so split on the comma children. Call arguments and maps differ: several atoms in one argument are wrapped in `argument`, and each map pair is a `map_entry`. `-10px` is one number; `-$gutter` is an operator and a variable.
- **Nested properties** are a `property_declaration` with `name`, optional `value`, optional `body`, and direct braces. There is no `nested_property` node.
- **Selectors:** `selector_arguments` holds its parentheses, comma-separated branches, and comments directly, without an inner `selectors` node; value-taking pseudos such as `:lang()` hold value nodes, and the `of` list in `nth_arguments` keeps its own `selectors`. Because Sass parses a selector after evaluating it, `#{$sel}(.a)` is a `pseudo_selector` whose `pseudo_name` holds only interpolation. Sass accepts `a, , b` and a trailing comma, so a `,` may be followed by another comma, the block, or `)`.
- **Blocks and empty forms:** the owning rule, declaration, or directive has direct `{` and `}` children that bound the whole interior. The optional `body` only groups content: it can begin or end with a statement comment, and a comment-only block has one. An empty block has no `body`, and an empty declaration has no `value`.
- **Comments and strings:** a `/* */` comment in a statement position is a `block_comment` child; other comments are extras with literal text, and `//` comments never parse interpolation. In SCSS, statement comments and strings parse `#{…}`, which may span lines, when its `}` follows without leaving the enclosing block, statement, comment, or string. An opener without such a closer stays literal text, even though Sass may reject it.
- **Statements being typed** usually end before a declaration on the next line; [Statement breaks](ARCHITECTURE.md#statement-breaks) lists each site.
  - One local `ERROR` covers a selector line, including one ending with a comma, combinator, `(`, touching `.` or `:`, or an interpolation with nothing in it yet, such as `#{}` or `#{$}`; a line of leading punctuation such as `>` or `#{}`; an attribute operator without its value, as in `&[d=]` (`[a=] {}` parses without an error, although Sass rejects it); and the cut-off header of a Sass control directive or of a nestable CSS at-rule such as `@media`. A declaration missing its `;` ends before the next declaration line.
  - A missing `;` after a value ending in interpolation or an open `url(`, and an interpolated name on its own line, put the next declaration's name in an `ERROR`; a compound start after a space, as in `.b .` or `& #`, takes the whole next declaration.
  - These can still absorb the following statements: an unpaired or empty `[` (`&[d`, `&[d=`, `.b []`); a touching colon such as `op:acity`; a compound start after a space on a block's last line; an unclosed `#{` with more text on a selector line, as in `.b-#{$a`, which pairs with the next `}`; and a header whose parenthesis stays open past its first line. A same-line typo inside a declaration block, such as `cur sor: x;` or a word typed before an existing declaration on its line, can nest the following rules into one `ERROR` until the line is completed.
- **Versioning:** keep the parser, [node schema](src/node-types.json), and [highlight query](queries/highlights.scm) on the same revision.

## Highlighting

[queries/highlights.scm](queries/highlights.scm) assigns semantic roles; editors map the captures to their own faces. Most captures are standard Tree-sitter names such as `property`, `variable`, `function`, `module`, and `punctuation.delimiter`; `variable.parameter` marks declared parameters and named call arguments. Outside the Tree-sitter CLI's standard list are `type.unit`, `operator.expression`, and Neovim-style keyword roles: `keyword.import`, `keyword.conditional`, `keyword.repeat`, `keyword.return`, `keyword.debug`, and `keyword.exception` for the Sass directives and clause words they name (others, such as `@mixin`, are plain `keyword`); `keyword.directive` for CSS at-rules and unknown at-keywords; and `keyword.modifier` for `!default`, `!global`, `!optional`, and `!important`.

A later capture of the same range overrides an earlier one, as in the Tree-sitter CLI; the `; Context overrides` section, which refines roles such as map keys, query features, and parameters, depends on this. In Emacs, that means `:override t` on the font-lock rules. The section's one `ERROR` pattern marks a stray `.` or `::` as `punctuation.delimiter`, and zero-width MISSING punctuation can be captured: a missing `]` becomes `punctuation.bracket`.

## Known limits

- Escaped keywords such as `c\61 lc`, `@m\65 dia`, and `:l\61 ng` get generic syntax instead of their specialized forms; escaped calculation constants and CSS `var()` are still recognized. Escaped `!important` and escapes inside `An+B` may produce a parse error. CSS consumes CRLF as one escape terminator and SCSS does not, so `.x\31`, CRLF, `b` is a descendant selector in SCSS.
- In comments and strings, interpolation pairing looks ahead at most 1,024 steps, and each nested opener spends 64 more until it closes. A step can consume a whole identifier or escape.
- Property hacks other than a `*` touching its name or separated from it by a line break, such as `* zoom: 1`, `*#{$p}: 1`, or `.zoom: 1`, produce a parse error, although Sass accepts them.
- Typed `attr()` unions such as `attr(data-width type(<length> | <percentage>), 10px)` produce a parse error.
- A descendant combinator is read from whitespace directly before the next compound, so `.a /* c */.b` is one compound and `svg /* c */|a` keeps its namespace prefix. A name glued to a preceding simple selector, as in `[x]a`, is a parse error; Sass reads a descendant.
- Unspaced subtraction after `)` reads as a negative number: `fn()-1` and `($s)-1` end with the number `-1`.
- In Sass `url(map.get($icons, x))`, `map.get` is one `function_name` without a `module_name`. In a raw custom-property value, `url(https://a.test/x.png)` splits into the word `https`, a colon, and the raw text `//a.test/x.png`.
- With 1,000 nested rules, adding a descendant combinator to the innermost selector spends about 30 ms computing changed ranges (Tree-sitter 0.25.1, Apple M1 Pro); other edits, and the same edit at 100 levels, stay under 1 ms.

## Development

Requires Node.js 24, pnpm, Python, a C/C++ compiler, and a stable Rust toolchain with `rustfmt`.

```sh
pnpm install --frozen-lockfile
pnpm check   # What CI runs: lint, formatting, generated files, build, tests, package contents, preview export
pnpm dev     # Live preview of trees and highlights at http://127.0.0.1:4173
```

`grammar.js` and `src/scanner.c` are the authored sources; `pnpm generate` regenerates everything else under `src/`. After `pnpm build`, `pnpm test:node` runs the native acceptance tests, `pnpm test:fuzz` checks incremental parses after seeded random edits, and `pnpm benchmark` measures parsing and editing. See [Architecture](ARCHITECTURE.md) for ownership, invariants, and comparison instructions.

## License

[MIT](LICENSE)
