export function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
}

function themeKey(name, theme) {
  const parts = name.split(".");
  // Match tree-sitter-highlight: most matching name components, first theme entry on ties.
  return Object.keys(theme)
    .filter(key => key.split(".").every(part => parts.includes(part)))
    .sort((a, b) => b.split(".").length - a.split(".").length)[0];
}

export function highlight(source, captures, themes) {
  const nodes = new Map();
  // Later query captures override earlier captures on the same node, including unknown roles.
  for (const capture of captures) nodes.set(capture.node.id, capture);
  const events = [];
  for (const capture of nodes.values()) {
    const key = themeKey(capture.name, themes.light);
    const { startIndex: start, endIndex: end } = capture.node;
    if (!key || start === end) continue;
    const range = { start, end, key, name: capture.name };
    events.push({ at: start, start: true, range }, { at: end, start: false, range });
  }
  events.sort((a, b) => a.at - b.at || Number(a.start) - Number(b.start) || b.range.end - a.range.end);
  const active = [];
  const segments = [];
  let position = 0;
  const append = end => {
    if (end > position) {
      const current = active.at(-1);
      segments.push({ start: position, end, key: current?.key || null, name: current?.name || null });
      position = end;
    }
  };
  for (const event of events) {
    append(event.at);
    if (event.start) active.push(event.range);
    else active.splice(active.indexOf(event.range), 1);
  }
  append(source.length);
  const html = segments
    .map(segment => {
      const text = escapeHtml(source.slice(segment.start, segment.end));
      if (!segment.key) return text;
      const style = `--hl-light: ${themes.light[segment.key]}; --hl-dark: ${themes.dark[segment.key]}`;
      return `<span style="${style}" title="@${escapeHtml(segment.name)}">${text}</span>`;
    })
    .join("");
  return { html: `<pre><code>${html}</code></pre>`, segments };
}

export function differentLines(source, results) {
  // Each theme key has its own color in both palettes, so equal keys mean equal displayed colors.
  const keys = new Map();
  const maps = results.map(result => {
    const map = new Uint8Array(source.length);
    for (const { start, end, key } of result.segments) {
      if (!key) continue;
      if (!keys.has(key)) keys.set(key, keys.size + 1);
      map.fill(keys.get(key), start, end);
    }
    return map;
  });
  const lines = new Set();
  let line = 1;
  for (let index = 0; index < source.length; index++) {
    if (!/\s/.test(source[index]) && maps[0][index] !== maps[1][index]) lines.add(line);
    if (source[index] === "\n") line++;
  }
  return [...lines];
}

export function describeTree(root) {
  const cursor = root.walk();
  const lines = [];
  let depth = 0;
  let errors = 0;
  let missing = 0;
  const diagnostics = [];
  try {
    for (;;) {
      const node = cursor.currentNode;
      if (node.isError) errors++;
      if (node.isMissing) missing++;
      if (node.isError || node.isMissing) {
        diagnostics.push({
          kind: node.isMissing ? "MISSING" : "ERROR",
          type: node.type,
          start: node.startIndex,
          end: node.endIndex,
          from: node.startPosition,
          to: node.endPosition
        });
      }
      if (node.isNamed || node.isMissing) {
        const field = cursor.currentFieldName;
        const start = node.startPosition;
        const end = node.endPosition;
        lines.push(
          `${"  ".repeat(depth)}${field ? `${field}: ` : ""}${node.isMissing ? "MISSING " : ""}${node.type} [${start.row + 1}:${start.column + 1}–${end.row + 1}:${end.column + 1}]`
        );
      }
      if (cursor.gotoFirstChild()) {
        depth++;
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent())
          return { tree: lines.join("\n"), errors, missing, diagnostics, hasError: root.hasError };
        depth--;
      }
    }
  } finally {
    cursor.delete();
  }
}

export function diagnosticLabel(diagnostic) {
  const { kind, type, from, to } = diagnostic;
  const position = `L${from.row + 1}:${from.column + 1}`;
  return kind === "MISSING"
    ? `MISSING ${JSON.stringify(type)} at ${position}`
    : `ERROR ${position}–L${to.row + 1}:${to.column + 1}`;
}

export function diagnosticContent(source, diagnostic) {
  if (diagnostic.kind !== "MISSING") {
    return { before: source.slice(diagnostic.start, diagnostic.end), marker: "", after: "" };
  }
  const prefix = source.slice(0, diagnostic.start);
  let lineStart = prefix.lastIndexOf("\n") + 1;
  // At the start of a line, include the preceding line to give the empty range context.
  if (lineStart === diagnostic.start && lineStart > 0) lineStart = prefix.slice(0, -1).lastIndexOf("\n") + 1;
  const newline = source.indexOf("\n", diagnostic.start);
  return {
    before: source.slice(lineStart, diagnostic.start),
    marker: `⟨missing ${JSON.stringify(diagnostic.type)}⟩`,
    after: source.slice(diagnostic.start, newline === -1 ? source.length : newline)
  };
}

export function diagnosticsByLine(diagnostics) {
  const lines = new Map();
  for (const diagnostic of diagnostics) {
    const last =
      diagnostic.to.row > diagnostic.from.row && diagnostic.to.column === 0 ? diagnostic.to.row - 1 : diagnostic.to.row;
    for (let row = diagnostic.from.row; row <= Math.max(diagnostic.from.row, last); row++) {
      if (!lines.has(row + 1)) lines.set(row + 1, []);
      lines.get(row + 1).push(diagnosticLabel(diagnostic));
    }
  }
  return lines;
}
