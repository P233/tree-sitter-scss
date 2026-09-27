# tree-sitter-scss

An early, runnable **SCSS-only** Tree-sitter grammar. Indented Sass (`.sass`) is not supported.

## Start developing

Use Node.js 24 (see `.node-version`), pnpm 11.25.0, a C/C++ compiler, and Python for native builds. A current stable Rust toolchain with `rustfmt` is required for the complete check.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

Open **http://127.0.0.1:4173**. The preview updates after changes to `grammar.js`, `tree-sitter.json`, `queries/highlights.scm`, the selected SCSS file, or the preview theme/styles. It displays the real CLI highlights, a syntax tree, and parse/build errors. Stop it with **Ctrl+C**. Changes to the JavaScript development scripts require restarting the server.

```sh
pnpm dev path/to/example.scss --port 4174
pnpm preview                         # Export build/preview/index.html
pnpm preview path/to/example.scss    # Export a different SCSS file
pnpm parse                           # CLI syntax tree for examples/basic.scss
pnpm highlight                       # Terminal highlighting for the same file
```

The preview uses only Node's built-in server and the installed Tree-sitter tools; no browser-side parser, Docker, or WebAssembly compiler is required. It listens on loopback only. The static HTML can also be opened directly in a browser. The repository supplies CLI configuration without changing global settings.

## Checks and iteration

| Command                     | Purpose                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm test`                 | Generate, rebuild the binding, run parser/highlight tests and Node integration tests                 |
| `pnpm check`                | Lint, format check, generated-file verification, build, all tests including Rust, and static preview |
| `pnpm generate`             | Regenerate the C parser and metadata from `grammar.js`                                               |
| `pnpm build`                | Rebuild the Node native binding                                                                      |
| `pnpm check:generated`      | Generate into a temporary directory and compare with `src/` without overwriting it                   |
| `pnpm test:parser`          | AST corpus and highlight assertions                                                                  |
| `pnpm test:node`            | Binding and development-tool tests; requires a current native build                                  |
| `pnpm test:rust`            | Rust binding and documentation tests                                                                 |
| `pnpm lint` / `pnpm format` | Check JavaScript / format authored development files                                                 |

For a grammar change, first add a focused corpus example, then edit `grammar.js` and run `pnpm test`. For a capture change, add an assertion in `test/highlight` and run `pnpm test:parser`. Use the preview to inspect actual colors and node boundaries. Run `pnpm check` before committing; if it reports stale generated files, run `pnpm generate` and review the generated changes.

`pnpm check` intentionally verifies generated files **before** any command regenerates them. Node suites run serially because the development-tool tests rebuild native artifacts. Preview checks use a freshly loaded native binding's `hasError` flag: the CLI's exit code alone can miss hidden `MISSING` nodes. A malformed file remains previewable with a visible error state, and a static export exits unsuccessfully when parsing fails.

GitHub Actions runs the same `pnpm check` on Linux and macOS. A local pass does not establish that a hosted workflow has run. Wallaby is optional; these native CLI/Node/Rust commands are the authoritative checks when it has no data.

## Project map

| Path                                                 | Responsibility                                            |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `grammar.js`                                         | Authored SCSS grammar                                     |
| `src/`                                               | Generated parser, node schema, and headers                |
| `queries/highlights.scm`                             | Semantic capture rules shared by consumers                |
| `bindings/node`, `bindings/rust`                     | Native runtime integration and smoke tests                |
| `test/corpus`, `test/highlight`                      | Expected ASTs and capture assertions                      |
| `examples/basic.scss`                                | Runnable preview sample                                   |
| `scripts/grammar.js`                                 | Generation, native build, and generated-file verification |
| `scripts/preview.js`, `scripts/inspect.js`           | Preview lifecycle and fresh native parse inspection       |
| `scripts/preview.config.json`, `scripts/preview.css` | Preview colors and page layout                            |

Build products and exported previews live in the ignored `build/` directory. `pnpm build` replaces that directory; regenerate a static preview afterward if needed. The live preview keeps its current page in memory.

## Toolchain and generated files

- Tree-sitter CLI: 0.27.0; generated parser ABI: 14 for runtime compatibility.
- Node runtime used in tests: 0.25.1, with a Node-API binding instead of NAN.
- Rust runtime used in tests: 0.27.0, with the `tree-sitter-language` interface.

Edit `grammar.js` and run `pnpm generate`; commit the resulting `src/grammar.json`, `src/node-types.json`, `src/parser.c`, and parser headers together. Do not edit generated files directly. Run `pnpm build` after regeneration when using the Node binding outside `pnpm test`.

## Current scope

The tested subset includes property declarations, simple tag/class/ID selectors and selector groups, nested rules, variables and flags, quoted strings and escapes, interpolation, numbers and units, colors, booleans/null, function calls and named arguments, lists, maps, and comments.

This is a working foundation, **not complete SCSS support**. At-rules (`@use`, `@mixin`, `@include`, control flow, CSS at-rules), parent/placeholder/attribute/pseudo selectors and combinators, namespaced variables, rest arguments, Unicode/escaped identifiers, special CSS value contexts such as custom properties and unquoted URLs, interpolation inside block comments, and final declarations without semicolons remain future work. Expressions are token sequences, not a complete precedence-aware SassScript AST.

`test/example.scss` is the original broader feature wishlist; it is not claimed to parse successfully. `examples/basic.scss` is the runnable example. `test/corpus` locks AST structure, `test/highlight` checks rendered captures, and the Node tests additionally check node text ranges, binding loading, error recovery, and incremental parsing.

## Consumers

```js
const Parser = require("tree-sitter");
const Scss = require("tree-sitter-scss");

const parser = new Parser();
parser.setLanguage(Scss);
const tree = parser.parse("body { color: red; }");
console.log(tree.rootNode.toString());
```

The Node package exports `language`, `name`, `nodeTypeInfo`, and `HIGHLIGHTS_QUERY`. The Rust crate is now named `tree-sitter-scss` and exports `LANGUAGE`, `NODE_TYPES`, and `HIGHLIGHTS_QUERY`; replace the old `tree_sitter_SCSS::language()` call with `tree_sitter_scss::LANGUAGE.into()`.

`tree-sitter.json` associates only `.scss` with this grammar. `queries/highlights.scm` provides the base captures. Editor-specific capture/face mappings and query loading still need integration and verification; no editor configuration is installed automatically.
