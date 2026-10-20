/* global document, Worker, requestAnimationFrame, Option, getComputedStyle */
import { diagnosticLabel, diagnosticContent, diagnosticsByLine } from "./highlight.mjs";
import { describeTimings, formatTimings } from "./parse.mjs";
const form = document.querySelector("#compare-form");
const controls = document.querySelector("#compare-controls");
const source = document.querySelector("#compare-source");
const sample = document.querySelector("#compare-sample");
const feedback = document.querySelector("#compare-feedback");
const focus = document.querySelector("#compare-focus");
const panels = [];
const worker = new Worker("./worker.mjs", { type: "module" });
let samples = [];
let busy = true;
let requestId = 0;
let timeout;
const editor = document.querySelector("#compare-editor");
let customSource;

function settle() {
  clearTimeout(timeout);
  busy = false;
  controls.disabled = false;
  form.removeAttribute("aria-busy");
}

function fail(message, fatal) {
  settle();
  feedback.textContent = `Results not updated: ${message}${fatal ? " Reload the page to retry." : ""}`;
  if (fatal) {
    controls.disabled = true;
    worker.terminate();
  }
}

function compare() {
  if (busy) return;
  if (source.value.length > 128 * 1024) {
    fail("Keep source under 128 Ki characters.");
    return;
  }
  busy = true;
  controls.disabled = true;
  form.setAttribute("aria-busy", "true");
  feedback.textContent = "Parsing and highlighting with all grammars…";
  timeout = setTimeout(() => fail("Comparison timed out.", true), 30_000);
  worker.postMessage({ id: ++requestId, source: source.value });
}

function selectSample() {
  editor.hidden = sample.value !== "custom";
  if (sample.value === "custom") {
    focus.textContent = "Custom source";
    // The first visit starts from the example shown; later visits bring back the last edit.
    if (customSource !== undefined && customSource !== source.value) {
      source.value = customSource;
      compare();
    }
    return;
  }
  const selected = samples[Number(sample.value)];
  source.value = selected.source;
  focus.textContent = selected.focus;
  compare();
}

worker.onmessage = ({ data }) => {
  if (data.id !== undefined && data.id !== requestId) return;
  if (data.type === "ready") {
    settle();
    document.querySelector("#compare-runtime").textContent =
      `Tree-sitter ${data.manifest.runtime} · shared theme (capture names map onto shared roles)`;
    samples = data.manifest.samples;
    samples.forEach((item, index) => sample.add(new Option(item.name, String(index)), sample.options.length - 1));
    const custom = sample.querySelector('option[value="custom"]');
    custom.text = `${String(samples.length + 1).padStart(2, "0")} · ${custom.text}`;
    sample.value = "0";
    createPanels(data.manifest.engines);
    selectSample();
  } else if (data.type === "error") {
    fail(data.message, data.fatal);
  } else if (data.type === "timing") {
    data.timings.forEach((time, index) => {
      const timing = document.querySelector(`#compare-timing-${index}`);
      timing.textContent = formatTimings(time);
      timing.title = describeTimings(time);
    });
  } else if (data.type === "timing-error") {
    panels.forEach((_, index) => {
      const timing = document.querySelector(`#compare-timing-${index}`);
      timing.textContent = `Timing unavailable: ${data.message}`;
      timing.removeAttribute("title");
    });
  } else if (data.type === "result") {
    const { differences } = data;
    const count = data.source.split("\n").length;
    const changedLines = new Set(differences);
    data.results.forEach((item, index) => {
      document.querySelector(`#compare-highlight-${index}`).innerHTML = item.html;
      document.querySelector(`#compare-status-${index}`).textContent = `${item.errors} ERROR · ${item.missing} MISSING`;
      const timing = document.querySelector(`#compare-timing-${index}`);
      timing.textContent = "Measuring times…";
      timing.removeAttribute("title");
      document.querySelector(`#compare-tree-${index}`).textContent = item.tree;
      const errors = document.querySelector(`#compare-errors-${index}`);
      const diagnosticItems = document.createDocumentFragment();
      item.diagnostics.forEach(diagnostic => {
        const li = document.createElement("li");
        const link = document.createElement("a");
        link.href = `#compare-line-${index}-${diagnostic.from.row + 1}`;
        link.textContent = diagnosticLabel(diagnostic);
        link.addEventListener("click", event => {
          event.preventDefault();
          jumpToLine(diagnostic.from.row + 1);
          panels[index].focus();
        });
        const content = diagnosticContent(data.source, diagnostic);
        const code = document.createElement("code");
        code.append(content.before);
        if (content.marker) {
          const marker = document.createElement("span");
          marker.className = "compare-missing-marker";
          marker.textContent = content.marker;
          code.append(marker);
        }
        code.append(content.after);
        li.append(link, code);
        diagnosticItems.append(li);
      });
      errors.replaceChildren(diagnosticItems);
      errors.hidden = item.diagnostics.length === 0;
      const diagnosticLines = diagnosticsByLine(item.diagnostics);
      const gutter = document.createDocumentFragment();
      for (let lineNumber = 1; lineNumber <= count; lineNumber++) {
        const line = document.createElement("span");
        line.id = `compare-line-${index}-${lineNumber}`;
        line.textContent = `${lineNumber}\n`;
        const labels = [];
        if (changedLines.has(lineNumber)) {
          line.classList.add("compare-line-different");
          labels.push("Different highlight colors");
        }
        if (diagnosticLines.has(lineNumber)) {
          line.classList.add("compare-line-error");
          labels.push(...diagnosticLines.get(lineNumber));
        }
        line.title = labels.join("\n");
        gutter.append(line);
      }
      panels[index].querySelector(".compare-lines").replaceChildren(gutter);
      panels[index].scrollTo(0, 0);
    });
    feedback.textContent = `${count} ${count === 1 ? "line" : "lines"} · ${differences.length} color-difference ${differences.length === 1 ? "line" : "lines"}`;
    settle();
  }
};
worker.onerror = event => fail(event.message || "Could not load the parsers.", true);
timeout = setTimeout(() => fail("Parser loading timed out.", true), 30_000);

form.addEventListener("submit", event => {
  event.preventDefault();
  compare();
});
sample.addEventListener("change", selectSample);
source.addEventListener("input", () => {
  customSource = source.value;
  feedback.textContent = "Source edited · Compare again to update all results.";
});
source.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    compare();
  }
});

let scrolling = false;
function createPanels(engines) {
  const template = document.querySelector("#compare-panel-template");
  const container = document.querySelector(".compare-panels");
  container.style.setProperty("--compare-engine-count", engines.length);
  engines.forEach((engine, index) => {
    const fragment = template.content.cloneNode(true);
    const field = name => fragment.querySelector(`[data-field="${name}"]`);
    for (const name of ["title", "version", "date", "status", "timing", "highlight", "tree", "errors"]) {
      field(name).id = `compare-${name}-${index}`;
    }
    fragment.querySelector("section").setAttribute("aria-labelledby", `compare-title-${index}`);
    field("title").textContent = engine.label;
    const link = field("version");
    link.textContent = `${engine.version ? `v${engine.version} · ` : ""}${engine.commit?.slice(0, 7) || "local"}${engine.modified ? " + edits" : ""} ↗`;
    link.title = `Grammar: ${engine.commit || "Local source"}`;
    link.href = engine.repository + (engine.commit ? `/tree/${engine.commit}` : "");
    field("date").textContent = engine.date || "";
    if (engine.date) field("date").dateTime = engine.date;
    const query = field("query");
    query.hidden = false;
    query.textContent = engine.extension
      ? `query · v${engine.extension.version}${engine.extension.modified ? " + edits" : ""} ↗`
      : "query ↗";
    query.href = engine.queryLink;
    query.title = engine.extension ? `Extension query: ${engine.extension.commit}` : "Grammar highlight query";
    const panel = field("code");
    for (const [element, description] of [
      [panel, "highlights"],
      [field("tree"), "syntax tree"],
      [field("errors"), "parse diagnostics"]
    ]) {
      element.setAttribute("aria-label", `${engine.label} ${description}`);
    }
    panels.push(panel);
    panel.addEventListener("scroll", () => {
      if (scrolling) return;
      scrolling = true;
      panels.forEach(other => {
        if (other === panel) return;
        other.scrollTop = panel.scrollTop;
        other.scrollLeft = panel.scrollLeft;
      });
      requestAnimationFrame(() => {
        scrolling = false;
      });
    });
    container.append(fragment);
  });
}

function jumpToLine(line) {
  document
    .querySelectorAll(".compare-line-current")
    .forEach(element => element.classList.remove("compare-line-current"));
  panels.forEach((_, index) =>
    document.querySelector(`#compare-line-${index}-${line}`).classList.add("compare-line-current")
  );
  const height = parseFloat(getComputedStyle(panels[0].querySelector("pre")).lineHeight);
  panels.forEach(panel => {
    panel.scrollTop = Math.max(0, line - 3) * height;
  });
}
