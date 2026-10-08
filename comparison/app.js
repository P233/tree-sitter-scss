/* global document, Worker, requestAnimationFrame, Option, getComputedStyle */
import { diagnosticLabel, diagnosticContent, diagnosticsByLine } from "./highlight.mjs";
const form = document.querySelector("#compare-form");
const controls = document.querySelector("#compare-controls");
const source = document.querySelector("#compare-source");
const sample = document.querySelector("#compare-sample");
const feedback = document.querySelector("#compare-feedback");
const focus = document.querySelector("#compare-focus");
const panels = [...document.querySelectorAll(".compare-code")];
const worker = new Worker("./worker.mjs", { type: "module" });
let samples = [];
let busy = true;
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
  feedback.textContent = "Parsing and highlighting with both grammars…";
  timeout = setTimeout(() => fail("Comparison timed out.", true), 30_000);
  worker.postMessage(source.value);
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
  if (data.type === "ready") {
    settle();
    document.querySelector("#compare-runtime").textContent = `Tree-sitter ${data.manifest.runtime} · shared theme`;
    samples = data.manifest.samples;
    samples.forEach((item, index) => sample.add(new Option(item.name, String(index)), sample.options.length - 1));
    const custom = sample.querySelector('option[value="custom"]');
    custom.text = `${String(samples.length + 1).padStart(2, "0")} · ${custom.text}`;
    sample.value = "0";
    data.manifest.engines.forEach((engine, index) => {
      const link = document.querySelector(`#compare-version-${index}`);
      link.textContent = `${engine.commit?.slice(0, 7) || "local"}${engine.modified ? " + edits" : ""} ↗`;
      link.title = engine.commit || "Local source";
      if (engine.commit) link.href += `/tree/${engine.commit}`;
      document.querySelector(`#compare-date-${index}`).textContent = engine.date || "";
    });
    selectSample();
  } else if (data.type === "error") {
    fail(data.message, data.fatal);
  } else if (data.type === "result") {
    const { differences } = data;
    const count = data.source.split("\n").length;
    const changedLines = new Set(differences);
    data.results.forEach((item, index) => {
      document.querySelector(`#compare-highlight-${index}`).innerHTML = item.html;
      document.querySelector(`#compare-status-${index}`).textContent = `${item.errors} ERROR · ${item.missing} MISSING`;
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
  feedback.textContent = "Source edited · Compare again to update both results.";
});
source.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    compare();
  }
});

let scrolling = false;
panels.forEach((panel, index) =>
  panel.addEventListener("scroll", () => {
    if (scrolling) return;
    scrolling = true;
    panels[1 - index].scrollTop = panel.scrollTop;
    panels[1 - index].scrollLeft = panel.scrollLeft;
    requestAnimationFrame(() => {
      scrolling = false;
    });
  })
);

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
