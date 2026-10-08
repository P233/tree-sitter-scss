# tree-sitter-scss comparison

A static page comparing `P233/tree-sitter-scss` with
`tree-sitter-grammars/tree-sitter-scss` on the same source, published at
https://peiwen.lu/project/tree-sitter-scss-comparison/. Both panes show the
repository, commit, and commit date. Each uses its own grammar and highlight
queries with the same theme and web-tree-sitter 0.27.0 runtime.

## Build and preview

Run from the repository root:

```sh
pnpm install --frozen-lockfile
git clone https://github.com/tree-sitter-grammars/tree-sitter-scss .compare/official
git -C .compare/official checkout 5da5ba71a558b007b352c505bfcd9095ae337022
npm --prefix .compare/official install --ignore-scripts --omit=dev
pnpm compare:build
pnpm compare
```

The preview runs at `http://127.0.0.1:4174`. Use `pnpm compare --port 4175`
for another port. The CLI compiles each generated C parser to WASM and may
download wasi-sdk on the first build. The official grammar's checkout and
the compiler cache are build inputs; they are not deployed.

Use `pnpm compare:build --official /path/to/checkout` and
`--css-query /path/to/css/queries/highlights.scm` to override the local baseline
paths. The CSS package's `LICENSE` must be one directory above `queries/`.
The default baseline is the official grammar at the commit above, with its
tree-sitter-css 0.20.0 dependency. The P233 side uses this checkout's generated `src/` and
`queries/`; regenerate the parser first after changing `grammar.js`.
Uncommitted parser/query changes appear as `+ edits` beside the commit.

## Deploy

Upload the contents of `comparison/dist/` to a static HTTP(S) host. Its
`index.html`, scripts, styles, manifest, queries, WASMs, and licenses form the
complete site. The host needs no Node process, parsing API, repository checkout,
or external CDN. Subdirectory hosting is supported through relative URLs, so
link to the directory with its trailing slash.

Serve `.wasm` as `application/wasm` and `.mjs` / `.js` as `text/javascript`.
A Content-Security-Policy must allow `'wasm-unsafe-eval'` in `script-src`, or
browsers refuse to compile the parsers. Open over HTTP(S), rather than a `file:`
URL. Source pasted into the page is processed in a browser worker and never sent
to a parsing service. Once the assets have loaded, editing and comparing require
no network requests.

The published copy lives in the peiwen.lu site's
`public/project/tree-sitter-scss-comparison/`, whose `_headers` file sets that
policy for the directory.

Re-run `pnpm compare:build` after editing the page, examples, queries, or parser.
Restart the preview after rebuilding. The build replaces `dist/` only after
all assets are generated; the directory is ignored by Git. Deploy that directory
as a unit so its manifest, runtime, queries, and grammars stay together.

## Reading the comparison

- The 14 examples cover CSS, Sass modules, variables, maps, mixins, interpolation,
  selectors, nested properties, query syntax, raw values, at-rules, and Unicode.
- A highlighted line number identifies different displayed colors on that line.
  Whitespace is excluded from this comparison; capture names remain available in
  token tooltips.
- `!` marks lines intersecting an `ERROR` range or a `MISSING` position. Hover the
  line number or use the diagnostic list at the bottom of the pane to inspect the position.
  Each `ERROR` includes its exact source text; `MISSING` entries show the surrounding
  line with an inline missing-node marker. Clicking a diagnostic scrolls both
  panes to its source line.
- Each pane shows its syntax tree below the code, with named nodes, fields, and
  anonymous missing nodes. All positions use 1-based lines and UTF-16 columns,
  with exclusive range ends.
- Scrolling is always linked. Choosing an example compares it at once. "Custom
  source" opens an editor that starts from the example shown and keeps your text
  when you switch away and back; press Compare below it or Cmd/Ctrl+Enter to
  update the results.
- The page follows the system color scheme until "Dark theme" is toggled; the
  choice is kept in local storage. Both themes give each highlight role its own
  color, so the difference markers are the same in either.

Diagnostics come directly from each parser's tree; no Sass compiler or module
resolver is involved. Color differences and diagnostic counts describe those
specific revisions and inputs. The page makes no ranking or quality assessment.
Inputs are limited to 128 Ki UTF-16 code units. Comparisons use fresh parses and
stop their worker after 30 seconds if it does not respond.

## Files and checks

`index.html`, `style.css`, and `app.js` own the page. `theme.js` sets the stored
or system theme before the first paint. `worker.mjs` owns the two parsers and
their queries. `highlight.mjs` renders captures and projects syntax tree
diagnostics. `samples.json` owns the examples. `build.js` exports and serves the
static assets; it reuses the repository's preview palette and pinned tools.

`dark-theme.json` holds the dark counterpart of each preview palette color. Each
keeps its hue, and its OKLCH lightness is `0.95 - 0.4 × L` of the light color, so
roles that stand out on white also stand out on the dark background; chroma is
reduced only to fit sRGB. The build rejects a dark palette whose keys differ
from the preview palette, and either palette that repeats a color.

```sh
node --test comparison/highlight_test.js
pnpm lint
pnpm format:check
```

The comparison tests also run under `pnpm test:development`. No browser test is
automated; before deploying, check sample selection, custom source editing,
diagnostic navigation, linked scrolling, both themes, Unicode, HTML-like input,
responsive layout, and subdirectory hosting.
