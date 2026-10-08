// Export a self-contained static site; the preview server never parses source.
const { execFileSync, spawnSync } = require("node:child_process");
const { createServer } = require("node:http");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} = require("node:fs");
const { dirname, extname, join, resolve } = require("node:path");
const { parseArgs } = require("node:util");
const root = resolve(__dirname, "..");

const output = join(__dirname, "dist");
const cli = join(dirname(require.resolve("tree-sitter-cli/package.json")), "tree-sitter");

function revision(directory) {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", directory, "status", "--porcelain", "--", "src", "queries"], {
    encoding: "utf8"
  });
  const date = spawnSync("git", ["-C", directory, "show", "-s", "--format=%cs", "HEAD"], { encoding: "utf8" });
  return {
    commit: result.status === 0 ? result.stdout.trim() : null,
    date: date.status === 0 ? date.stdout.trim() : null,
    modified: Boolean(status.stdout.trim())
  };
}

// The page compares displayed colors by theme key, so both palettes need the same keys and no shared colors.
function loadThemes() {
  const light = JSON.parse(readFileSync(join(root, "scripts/preview.config.json"), "utf8")).theme;
  const dark = JSON.parse(readFileSync(join(__dirname, "dark-theme.json"), "utf8"));
  if (Object.keys(dark).join() !== Object.keys(light).join()) {
    throw new Error("dark-theme.json must list the preview theme's keys in the same order.");
  }
  for (const [name, palette] of Object.entries({ light, dark })) {
    if (new Set(Object.values(palette)).size !== Object.keys(palette).length) {
      throw new Error(`The ${name} theme gives two keys the same color.`);
    }
  }
  return { light, dark };
}

function build(official, cssQuery) {
  for (const file of [join(official, "src/parser.c"), cssQuery]) {
    if (!existsSync(file)) throw new Error(`Missing ${file}. See README's highlight comparison setup.`);
  }
  mkdirSync(join(root, ".compare"), { recursive: true });
  const staging = mkdtempSync(join(root, ".compare/export-"));
  try {
    mkdirSync(join(staging, "vendor"), { recursive: true });
    const runtime = dirname(require.resolve("web-tree-sitter"));
    for (const name of ["web-tree-sitter.js", "web-tree-sitter.wasm"]) {
      copyFileSync(join(runtime, name), join(staging, "vendor", name));
    }
    for (const name of ["app.js", "theme.js", "worker.mjs", "highlight.mjs", "style.css"]) {
      copyFileSync(join(__dirname, name), join(staging, name));
    }
    copyFileSync(join(__dirname, "index.html"), join(staging, "index.html"));
    // The page links the licenses; a .txt name makes static hosts show them instead of downloading them.
    copyFileSync(join(runtime, "LICENSE"), join(staging, "vendor/LICENSE.txt"));
    copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE-p233.txt"));
    copyFileSync(join(official, "LICENSE"), join(staging, "LICENSE-official.txt"));
    copyFileSync(join(dirname(cssQuery), "../LICENSE"), join(staging, "LICENSE-css.txt"));
    const engines = [root, official].map((directory, index) => {
      const name = index === 0 ? "p233" : "official";
      execFileSync(cli, ["build", "--wasm", "-o", join(staging, `${name}.wasm`), directory], {
        cwd: root,
        stdio: "inherit"
      });
      const query = readFileSync(join(directory, "queries/highlights.scm"), "utf8");
      writeFileSync(join(staging, `${name}.scm`), index === 0 ? query : `${readFileSync(cssQuery, "utf8")}\n${query}`);
      return { name, ...revision(directory), wasm: `${name}.wasm`, query: `${name}.scm` };
    });
    writeFileSync(
      join(staging, "manifest.json"),
      JSON.stringify(
        {
          engines,
          runtime: JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")).version,
          themes: loadThemes(),
          samples: JSON.parse(readFileSync(join(__dirname, "samples.json"), "utf8"))
        },
        null,
        2
      )
    );
    // Publish only a complete export, and retire obsolete runtime assets on rebuild.
    rmSync(output, { recursive: true, force: true });
    renameSync(staging, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`Static site exported to ${output}`);
}

function serve(port) {
  if (!existsSync(join(output, "manifest.json"))) throw new Error("Run pnpm compare:build first.");
  const files = new Set(readdirSync(output, { recursive: true }));
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm"
  };
  const server = createServer((request, response) => {
    const path = request.url.split("?")[0];
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!["GET", "HEAD"].includes(request.method) || !files.has(file) || file === "vendor") {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": types[extname(file)] || "text/plain",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : readFileSync(join(output, file)));
  });
  server.on("error", error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`SCSS comparison: http://127.0.0.1:${server.address().port}/`));
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

module.exports = { loadThemes };

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        build: { type: "boolean" },
        official: { type: "string", default: ".compare/official" },
        "css-query": { type: "string" },
        port: { type: "string", default: "4174" }
      }
    });
    if (values.build) {
      const official = resolve(root, values.official);
      build(
        official,
        values["css-query"]
          ? resolve(values["css-query"])
          : join(official, "node_modules/tree-sitter-css/queries/highlights.scm")
      );
    } else {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
      serve(port);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
