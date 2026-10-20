# tree-sitter-scss comparison

A static page comparing `P233/tree-sitter-scss`, the grammar and highlight query
shipped by Zed’s SCSS & SASS extension, and `tree-sitter-grammars/tree-sitter-scss`
on the same source. It is published at
https://peiwen.lu/project/tree-sitter-scss-comparison/. Each pane shows its grammar
repository, commit and commit date, the release version when a release tag marks
that commit, and a query link. The Zed pane also links the extension revision and
version. All engines use the same capture-name to role mapping, theme and
web-tree-sitter 0.27.0 runtime; token tooltips keep the original capture names.

## Build and preview

Run from the repository root:

```sh
pnpm install --frozen-lockfile
git clone https://github.com/tree-sitter-grammars/tree-sitter-scss .compare/official
git -C .compare/official checkout 5da5ba71a558b007b352c505bfcd9095ae337022
npm --prefix .compare/official install --ignore-scripts --omit=dev
git clone https://github.com/simeonoff/tree-sitter-scss .compare/zed
git -C .compare/zed checkout 3f918284a73a54b53e4f326b0aa8c74ccbf4ee4d
git clone https://github.com/bajrangCoder/zed-scss .compare/zed-scss
git -C .compare/zed-scss checkout 18deab7712272b64a4ca24ed0950618631d77fa8
pnpm compare:build
pnpm compare
```

The preview runs at `http://127.0.0.1:4174`. Use `pnpm compare --port 4175`
for another port. The CLI compiles each generated C parser to WASM and may
download wasi-sdk on the first build. The grammar and extension checkouts and
the compiler cache are build inputs; they are not deployed.

Use `pnpm compare:build --official /path/to/checkout` and
`--css-query /path/to/css/queries/highlights.scm` to override the local baseline
paths. The CSS package's `LICENSE` must be one directory above `queries/`.
The default baseline is the official grammar at the commit above, with its
tree-sitter-css 0.20.0 dependency. Zed’s SCSS & SASS extension v0.2.1 at
`18deab7712272b64a4ca24ed0950618631d77fa8` pins the grammar at
`3f918284a73a54b53e4f326b0aa8c74ccbf4ee4d`. The build checks that pin and copies
`languages/scss/highlights.scm` unchanged, with both MIT license files. Use
`--zed /path/to/grammar` and `--zed-extension /path/to/extension` to override
these inputs. All three parsers use the same CLI and WASM build flags.

The P233 side uses this checkout's generated `src/` and
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

- The 16 examples cover CSS, Sass modules, variables, maps, mixins, interpolation,
  selectors, nested properties, query syntax, raw values, at-rules, Unicode, and
  the known limits of P233/tree-sitter-scss.
- A highlighted line number identifies different displayed colors on that line.
  Whitespace is excluded from this comparison; capture names remain available in
  token tooltips.
- `!` marks lines intersecting an `ERROR` range or a `MISSING` position. Hover the
  line number or use the diagnostic list at the bottom of the pane to inspect the position.
  Each `ERROR` includes its exact source text; `MISSING` entries show the surrounding
  line with an inline missing-node marker. Clicking a diagnostic scrolls all
  panes to its source line.
- Each pane shows its syntax tree below the code, with named nodes, fields, and
  missing nodes. A missing token whose symbol the grammar hides is listed at the
  start of its visible parent, which is exact when that parent is empty, as in
  `@Import;`. All positions use 1-based lines and UTF-16 columns,
  with exclusive range ends.
- Scrolling is always linked. Choosing an example compares it at once. "Custom
  source" opens an editor that starts from the example shown and keeps your text
  when you switch away and back; press Compare below it or Cmd/Ctrl+Enter to
  update the results.
- The page follows the system color scheme until "Dark theme" is toggled; the
  choice is kept in local storage. Both themes give each highlight role its own
  color, so the difference markers are the same in either.

Diagnostics come directly from each parser's tree; no Sass compiler or module
resolver is involved. Color differences, times and diagnostic counts describe those
specific revisions and inputs. The page makes no ranking or quality assessment.
Inputs are limited to 128 Ki UTF-16 code units. Comparisons use fresh parses and
stop their worker after 30 seconds if it does not respond.

Times appear after the highlight results, without keeping the controls disabled
for the measurement. Each pane shows two: parse covers the parser alone, and
highlighted adds the engine's own highlight query and building the colored
markup from its captures, so a query that colors more tokens takes longer.
Before any timing, every engine runs the highlighted work untimed for about 20
ms, so the engine timed first does not absorb the runtime's warm-up. Each time
then gets one untimed run and five batches of consecutive fresh runs, each batch
lasting at least 10 ms; a slow run forms its own batch. The page reports the
median of the five batch means, with two significant figures and seconds from 1
s up; hovering the times shows how many runs were timed. Every engine gets the
same five batches, so a faster engine completes more runs. Tree cleanup and page
updates are outside the timed intervals. Results describe warm work in the
current browser, not editor or compiler latency.

## Files and checks

- `index.html`, `style.css` and `app.js` own the page and its manifest-driven panels.
- `theme.js` sets the stored or system theme before the first paint.
- `worker.mjs` owns the parsers and queries. It publishes highlights before
  timings; request IDs keep old measurements out of newer results.
- `parse.mjs` owns batch measurement, tree cleanup and timing display formatting.
- `highlight.mjs` owns shared capture roles, rendering, color differences and
  syntax tree diagnostics.
- `samples.json` owns the examples.
- `build.js` exports provenance, query links, versions, licenses and static assets
  and serves the preview. It reuses the repository's preview palette and tools.
- `highlight_test.js` owns the comparison's automated regression checks.

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

`highlight_test.js` covers N-engine differences, shared capture roles, diagnostics
and simulated-clock timing bounds, quantization, medians and tree cleanup.
The comparison tests also run under `pnpm test:development`. No browser test is
automated; before deploying, check sample selection, custom source editing,
diagnostic navigation, linked scrolling, both themes, Unicode, HTML-like input,
responsive layout, and subdirectory hosting.
