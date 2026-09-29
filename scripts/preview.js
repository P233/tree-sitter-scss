const { execFileSync } = require("node:child_process");
const { Buffer } = require("node:buffer");
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { extname, join, relative, resolve } = require("node:path");
const { parseArgs } = require("node:util");
const { build, childOptions, generate, root, runTreeSitter } = require("./grammar.js");
const stressSource = join(root, "examples/highlight-stress.scss");

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
  // CLI exit codes miss some hidden MISSING nodes; inspect the tree via the native API.
  const { valid, diagnostics } = JSON.parse(
    execFileSync(process.execPath, [join(__dirname, "inspect.js"), source], childOptions)
  );
  const config = ["--config-path", "scripts/preview.config.json", "--scope", "source.scss"];
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

function renderTextPreview(text) {
  const directory = mkdtempSync(join(tmpdir(), "scss-preview-"));
  try {
    const source = join(directory, "input.scss");
    writeFileSync(source, text);
    return renderPreview(source);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function page(source, result, { revision = "", watch = false, css = "", sourceText } = {}) {
  const status = result.valid ? "Parsed without errors" : "Parse or build errors";
  const editor =
    sourceText !== undefined
      ? `<form id="preview-form"><fieldset class="preview-editor">
    <label for="preview-source">SCSS source</label>
    <textarea id="preview-source" name="source" rows="6" spellcheck="false" wrap="off">${escapeHtml(sourceText)}</textarea>
    <div class="preview-actions"><button type="submit">Generate</button>
    <button type="button" id="preview-reset" aria-label="Reset to Highlight stress">Highlight stress</button></div>
    </fieldset></form>`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>SCSS preview</title><style id="preview-style">${css}</style></head><body>
    <main class="preview" data-revision="${escapeHtml(revision)}" data-watch="${watch}">
    <header class="preview-header"><h1>SCSS preview</h1>
    <p class="preview-path">${escapeHtml(relative(root, source))}</p></header>
    ${editor}<div class="preview-feedback">
    <p id="preview-status" role="status" class="${result.valid ? "preview-status" : "preview-error"}">${status}</p>
    ${editor ? '<p id="preview-updates" role="status"></p>' : ""}</div>
    <div class="preview-results">
    <section class="preview-panel"><h2 id="preview-code-title">Code</h2>
    <div id="preview-highlight" class="preview-output" role="region" aria-labelledby="preview-code-title" tabindex="0">${result.highlight || ""}</div></section>
    <section class="preview-panel"><h2 id="preview-tree-title">Syntax tree</h2>
    <pre id="preview-diagnostics" class="preview-output" role="region" aria-labelledby="preview-tree-title" tabindex="0">${escapeHtml(result.diagnostics)}</pre></section>
    </div></main>
    ${editor ? '<script src="/preview-client.js" defer></script>' : ""}</body></html>`;
}

function serve(source, port, watch) {
  let revision = "";
  let html;
  let timer;
  let needsBuild = true;
  const ensureBuilt = () => {
    if (!needsBuild) return;
    generate();
    build();
    needsBuild = false;
  };
  const update = () => {
    let result;
    let css = "";
    let sourceText = "";
    try {
      css = readFileSync(join(__dirname, "preview.css"), "utf8");
      sourceText = readFileSync(source, "utf8");
      ensureBuilt();
      result = renderTextPreview(sourceText);
    } catch (error) {
      result = { valid: false, highlight: "", diagnostics: String(error.stderr || error.message) };
    }
    revision = randomUUID();
    html = page(source, result, { revision, watch, css, sourceText });
    console.log(result.valid ? "Preview updated." : result.diagnostics);
  };
  const server = createServer({ requestTimeout: 30_000 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const json = (status, value) =>
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
    try {
      if (request.method === "GET" && request.url === "/revision") {
        response.writeHead(200, { "Content-Type": "text/plain" }).end(revision);
      } else if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      } else if (request.method === "GET" && request.url === "/preview-client.js") {
        const client = readFileSync(join(__dirname, "preview-client.js"), "utf8");
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(client);
      } else if (request.method === "GET" && request.url === "/example") {
        ensureBuilt();
        const text = readFileSync(stressSource, "utf8");
        json(200, {
          ...renderTextPreview(text),
          source: text,
          revision,
          css: readFileSync(join(__dirname, "preview.css"), "utf8")
        });
      } else if (request.method === "POST" && request.url === "/preview") {
        if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
          request.resume();
          return json(403, { error: "Requests must come from this preview page." });
        }
        if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
          request.resume();
          return json(415, { error: "Expected JSON containing a source string." });
        }
        request.setEncoding("utf8");
        let body = "";
        let size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          if (size <= 1024 * 1024) body += chunk;
        }
        if (size > 1024 * 1024) return json(413, { error: "Source must be smaller than 1 MiB." });
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          return json(400, { error: "Expected valid JSON." });
        }
        if (typeof input?.source !== "string") return json(400, { error: "Expected a source string." });
        ensureBuilt();
        json(200, {
          ...renderTextPreview(input.source),
          revision,
          css: readFileSync(join(__dirname, "preview.css"), "utf8")
        });
      } else {
        response.writeHead(404).end("Not found");
      }
    } catch (error) {
      json(500, { error: String(error.stderr || error.message) });
    }
  });
  const buildSources = [join(root, "grammar.js"), join(root, "tree-sitter.json"), join(root, "src/scanner.c")];
  const files = watch
    ? [
        source,
        stressSource,
        ...buildSources,
        join(root, "queries/highlights.scm"),
        join(__dirname, "preview.config.json"),
        join(__dirname, "preview.css"),
        join(__dirname, "preview-client.js"),
        join(__dirname, "inspect.js")
      ]
    : [];
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
    update();
    for (const file of new Set(files)) {
      watchFile(file, { interval: 300 }, () => {
        needsBuild ||= buildSources.includes(file);
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
        serve: { type: "boolean", default: false },
        watch: { type: "boolean", default: false },
        port: { type: "string", default: "4173" }
      },
      allowPositionals: true
    });
    if (positionals.length > 1)
      throw new Error("Usage: pnpm preview [file.scss], pnpm dev [file.scss], or pnpm preview:export [file.scss]");
    const source = resolve(root, positionals[0] || stressSource);
    if (extname(source).toLowerCase() !== ".scss") throw new Error("Only .scss files are supported.");
    if (values.serve || values.watch) {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
      serve(source, port, values.watch);
    } else {
      generate();
      build();
      const result = renderPreview(source);
      const destination = join(root, "build/preview/index.html");
      mkdirSync(join(root, "build/preview"), { recursive: true });
      writeFileSync(destination, page(source, result, { css: readFileSync(join(__dirname, "preview.css"), "utf8") }));
      console.log(`Preview: ${destination}`);
      if (!result.valid) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.stderr || error.message);
    process.exitCode = 1;
  }
}

module.exports = { escapeHtml, renderPreview, page };
