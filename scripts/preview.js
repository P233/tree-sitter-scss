const { execFileSync } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } = require("node:fs");
const { extname, join, relative, resolve } = require("node:path");
const { parseArgs } = require("node:util");
const { build, generate, root, runTreeSitter } = require("./grammar.js");

function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    character =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]
  );
}

function renderPreview(source) {
  generate();
  build();
  // CLI exit codes miss some hidden MISSING nodes; inspect the tree via the native API.
  const { valid, diagnostics } = JSON.parse(
    execFileSync(process.execPath, [join(__dirname, "inspect.js"), source], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    })
  );
  const config = ["--config-path", "scripts/preview.config.json", "--grammar-path", root];
  const highlight = runTreeSitter([
    "highlight",
    ...config,
    "--html",
    "--layout",
    "fragment",
    "--style",
    "inline",
    source
  ]);
  return { highlight, diagnostics, valid };
}

function page(source, result, revision, live, css = "") {
  const status = result.valid ? "Parsed without errors" : "Parse or build errors — inspect the diagnostics below";
  const reload = live
    ? `<script>
    setInterval(async () => {
      try {
        const revision = await (await fetch('/revision', {cache: 'no-store'})).text();
        if (revision !== '${revision}') location.reload();
      } catch {
        document.querySelector('[role="status"]').textContent = 'Preview disconnected. Restart pnpm dev.';
      }
    }, 1000);
  </script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>SCSS highlight preview</title><style>${css}</style></head><body>
    <main class="preview"><h1>SCSS highlight preview</h1>
    <p class="preview-path">${escapeHtml(relative(root, source))}</p>
    <p>SCSS subset · ${live ? "Updates when grammar, queries, theme, or source changes" : "Static preview"}</p>
    <p role="status" class="${result.valid ? "preview-status" : "preview-error"}">${status}</p>
    <section aria-label="Highlighted source">${result.highlight || ""}</section>
    <details ${result.valid ? "" : "open"}><summary>Syntax tree and diagnostics</summary>
    <pre>${escapeHtml(result.diagnostics)}</pre></details></main>${reload}</body></html>`;
}

function serve(source, port) {
  let revision = 0;
  let html;
  let timer;
  const update = () => {
    let result;
    let css = "";
    try {
      css = readFileSync(join(__dirname, "preview.css"), "utf8");
      result = renderPreview(source);
    } catch (error) {
      result = { valid: false, highlight: "", diagnostics: String(error.stderr || error.message) };
    }
    html = page(source, result, ++revision, true, css);
    console.log(result.valid ? "Preview updated." : result.diagnostics);
  };
  update();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/revision") {
      response.writeHead(200, { "Content-Type": "text/plain" }).end(String(revision));
    } else if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    } else {
      response.writeHead(404).end("Not found");
    }
  });
  const files = [
    source,
    join(root, "grammar.js"),
    join(root, "tree-sitter.json"),
    join(root, "queries/highlights.scm"),
    join(__dirname, "preview.config.json"),
    join(__dirname, "preview.css")
  ];
  const stop = () => {
    clearTimeout(timer);
    for (const file of files) unwatchFile(file);
    server.close();
    server.closeAllConnections();
  };
  server.on("error", error => {
    console.error(error.message);
    stop();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`SCSS preview: http://127.0.0.1:${server.address().port}/ (Ctrl+C to stop)`);
    for (const file of files) {
      watchFile(file, { interval: 300 }, () => {
        clearTimeout(timer);
        timer = setTimeout(update, 75);
      });
    }
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (require.main === module) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        watch: { type: "boolean", default: false },
        port: { type: "string", default: "4173" }
      },
      allowPositionals: true
    });
    if (positionals.length > 1)
      throw new Error("Usage: pnpm preview [file.scss] or pnpm dev [file.scss] [--port 4173]");
    const source = resolve(root, positionals[0] || "examples/basic.scss");
    if (extname(source).toLowerCase() !== ".scss") throw new Error("Only .scss files are supported.");
    if (values.watch) {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
      serve(source, port);
    } else {
      const result = renderPreview(source);
      const destination = join(root, "build/preview/index.html");
      mkdirSync(join(root, "build/preview"), { recursive: true });
      writeFileSync(destination, page(source, result, 0, false, readFileSync(join(__dirname, "preview.css"), "utf8")));
      console.log(`Preview: ${destination}`);
      if (!result.valid) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.stderr || error.message);
    process.exitCode = 1;
  }
}

module.exports = { escapeHtml, renderPreview, page };
