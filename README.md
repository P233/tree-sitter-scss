# tree-sitter-scss

**This project is not affiliated with the official [tree-sitter-grammars/tree-sitter-scss](https://github.com/tree-sitter-grammars/tree-sitter-scss).** It is a Tree-sitter parser written from scratch for SCSS and CSS: the grammar is designed around SCSS, and CSS is a second language entry of the same parser. Indented Sass (`.sass`) is not supported.

It targets reading and highlighting complete stylesheets, with one grammar for SCSS and CSS. It was built for [scss2-mode](https://github.com/P233/scss2-mode), which bundles its own parser snapshot; changes in this checkout take effect there only after that snapshot is updated and its consumers are validated. Nothing here is published to npm or crates.io, where the `tree-sitter-scss` name belongs to the official grammar; see [Use from source](#use-from-source).

## Compared with the official grammar

The official grammar extends `tree-sitter-css`; this one serves both dialects with one parser, schema, and query. Measured with Tree-sitter CLI 0.27.0, the official grammar at [`2ef6d42`](https://github.com/tree-sitter-grammars/tree-sitter-scss/tree/2ef6d42e3ad7a8208900f9346f4529806ae0f9f9) errors on everyday Sass such as `!default`, `@use ... as`, maps, `@include ns.mixin`, and `$args...`: on the 1,157 non-blank lines of [rhythm-sass `76aac68`](https://github.com/P233/rhythm-sass/tree/76aac6827bdd80d439579f0cf93cad78cd6d7fc7), it reports 700 error nodes, with 37% of the lines inside `ERROR`, where this parser reports none. It also left-nests selectors, so the `:hover` node in `.a .b:hover` spans the whole selector; has no fields on rules, declarations, or CSS at-rules; reports nested properties as errors; and parses custom-property values as Sass.

Node ranges inside an `ERROR` cannot be trusted, so scss2-mode refuses structural edits there. The costs are owning all CSS compatibility work and a generated parser about five times larger (4.0 MB of C against 0.79 MB). The schema and query are not interchangeable with the official ones.

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
- **Comments and strings:** a `/* */` comment in a statement position is a `block_comment` child; other comments are extras with literal text, and `//` comments never parse interpolation. In SCSS, statement comments and strings parse complete `#{…}` expressions through the grammar, including nested quotes, comments and multiline expressions. CSS keeps `#{` literal in text hosts.
- **Statements being typed:** syntax and highlighting target complete files, and the shape of an erroneous tree is not a compatibility guarantee. A statement typed or mistyped above a declaration usually stays one local `ERROR` and the following rules stay intact: a selector line, including one ending in `,`, a combinator or a touching `.`, `:` or `#{`; a word or space typed into a declaration, as in `cur sor: x;`; a line of leading `>`, `+`, `~` or `#{}`; a cut-off control or nestable at-rule header; and a value missing its `;`, also above a compact declaration such as `display:flex;`. A bare `$` stays inside its statement, so the mixin or function around it keeps its parameters and body, and `[a=] {}` parses without an error as an editing tolerance, although Sass rejects it. [Statement breaks](ARCHITECTURE.md#statement-breaks) lists the sites; [Known limits](#known-limits) lists the gaps.
- **Incremental parsing:** hosts can still update an old tree after edits or agent-applied replacements. Complete supported input must produce the same tree and ordered captures as a fresh parse, including after repairing damaged input. A reading-oriented parser does not require buffers to be immutable or every update to discard the old tree.
- **Versioning:** keep the parser, [node schema](src/node-types.json), and [highlight query](queries/highlights.scm) on the same revision.

## Highlighting

[queries/highlights.scm](queries/highlights.scm) assigns semantic roles; editors map the captures to their own faces. Most captures are standard Tree-sitter names such as `property`, `variable`, `function`, `module`, and `punctuation.delimiter`; `variable.parameter` marks declared parameters and named call arguments. Outside the Tree-sitter CLI's standard list are `type.unit`, `operator.expression`, and Neovim-style keyword roles: `keyword.import`, `keyword.conditional`, `keyword.repeat`, `keyword.return`, `keyword.debug`, and `keyword.exception` for the Sass directives and clause words they name (others, such as `@mixin`, are plain `keyword`); `keyword.directive` for CSS at-rules and unknown at-keywords; and `keyword.modifier` for `!default`, `!global`, `!optional`, and `!important`.

A later capture of the same range overrides an earlier one, as in the Tree-sitter CLI; the `; Context overrides` section, which refines roles such as map keys, query features, and parameters, depends on this. In Emacs, that means `:override t` on the font-lock rules. Brackets other than a type's `<` and `>`, `;`, and colons outside pseudo-classes have no capture, so hosts render them in the default face or with their own bracket coloring. The query has no error-specific coloring rules. Tree-sitter may still capture zero-width MISSING punctuation; hosts can ignore empty ranges.

## Known limits

- Escaped keywords such as `c\61 lc`, `@m\65 dia`, and `:l\61 ng` get generic syntax instead of their specialized forms; escaped calculation constants and CSS `var()` are still recognized. Escaped `!important` and escapes inside `An+B` may produce a parse error. CSS consumes CRLF as one escape terminator and SCSS does not, so `.x\31`, CRLF, `b` is a descendant selector in SCSS.
- Internet Explorer–only syntax is not supported: the `*` property hack, `alpha(opacity=50)` arguments, `progid:` filters and `expression()` parse as local errors. A leading `_` is an ordinary name character.
- In a media or container query, a feature name continued by interpolation, as in `(max-#{$side} > 1px)`, colors as a value rather than a property.
- Selector arguments after a class, ID, type, placeholder or `&` name continued by interpolation, as in `.a#{$p}(.b)` and `&#{$p}(.x)`, produce a parse error.
- Typed `attr()` unions such as `attr(data-width type(<length> | <percentage>), 10px)` produce a parse error.
- A descendant combinator is read from whitespace directly before the next compound, so `.a /* c */.b` is one compound and `svg /* c */|a` keeps its namespace prefix. A name glued to a preceding simple selector, as in `[x]a`, is a parse error; Sass reads a descendant.
- Unspaced subtraction after `)` reads as a negative number: `fn()-1` and `($s)-1` end with the number `-1`.
- In Sass `url(map.get($icons, x))`, `map.get` is one `function_name` without a `module_name`. In a raw custom-property value, `url(https://a.test/x.png)` splits into the word `https`, a colon, and the raw text `//a.test/x.png`.
- These still absorb the following rules while being typed: a colon typed into a name (`op:acity: 0.4`), an unpaired `[`, an unclosed `#{` in an SCSS string or comment, which reads as an expression up to a later `}`, and a control-directive header whose group stays open past its first line (`@if fn(`, then `$a,` and `width: 1px;` on the next lines). An unclosed `url(` keeps them, but the next declaration's name joins its `ERROR`. Punctuation after another statement or a `{` on its line, as in `color: red; ,`, joins a hidden statement break and is not reported.
- With 1,000 nested rules, adding a descendant combinator to the innermost selector spends about 30 ms computing changed ranges (Tree-sitter 0.25.1, Apple M1 Pro); other edits, and the same edit at 100 levels, stay under 1 ms.

## Development

Requires Node.js 24, pnpm, Python, a C/C++ compiler, and a stable Rust toolchain with `rustfmt`.

```sh
pnpm install --frozen-lockfile
pnpm check   # What CI runs: lint, formatting, generated files, build, tests, package contents, preview export
pnpm dev     # Live preview of trees and highlights at http://127.0.0.1:4173
```

`grammar.js` and `src/scanner.c` are the authored sources; `pnpm generate` regenerates everything else under `src/`. After `pnpm build`, `pnpm test:node` runs the native acceptance tests, `pnpm test:fuzz` checks incremental parses after seeded random edits, and `pnpm benchmark` measures full parsing, ordered highlight capture queries, their combined cost, a numeric incremental replacement, and key-by-key typing. See [Architecture](ARCHITECTURE.md) for ownership, invariants, and comparison instructions.

## License

[MIT](LICENSE)
