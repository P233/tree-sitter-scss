/* global document, location */
{
  const preview = document.querySelector(".preview");
  const form = document.querySelector("#preview-form");
  const controls = form.querySelector("fieldset");
  const source = document.querySelector("#preview-source");
  const reset = document.querySelector("#preview-reset");
  const status = document.querySelector("#preview-status");
  const updates = document.querySelector("#preview-updates");
  const highlight = document.querySelector("#preview-highlight");
  const diagnostics = document.querySelector("#preview-diagnostics");
  let revision = preview.dataset.revision;

  async function generate(useExample = false) {
    if (controls.disabled) return;
    const focused = document.activeElement;
    controls.disabled = true;
    form.setAttribute("aria-busy", "true");
    status.textContent = "Generating…";
    try {
      const response = await fetch(
        useExample ? "/example" : "/preview",
        useExample
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source: source.value })
            }
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Preview unavailable");
      if (useExample) source.value = result.source;
      document.querySelector(".preview-path").textContent = useExample
        ? "examples/highlight-stress.scss"
        : "Custom SCSS";
      document.querySelector("#preview-style").textContent = result.css;
      highlight.innerHTML = result.highlight;
      diagnostics.textContent = result.diagnostics;
      status.textContent = result.valid ? "Parsed without errors" : "Parse errors";
      status.className = result.valid ? "preview-status" : "preview-error";
      revision = result.revision;
      updates.textContent = "";
    } catch (error) {
      status.textContent = "Could not generate preview";
      status.className = "preview-error";
      diagnostics.textContent = error.message;
      highlight.innerHTML = "";
    } finally {
      for (const pane of [highlight, diagnostics]) {
        pane.scrollTop = 0;
        pane.scrollLeft = 0;
      }
      controls.disabled = false;
      form.setAttribute("aria-busy", "false");
      if (document.activeElement === document.body) focused?.focus();
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    return generate();
  });
  reset.addEventListener("click", () => generate(true));

  async function poll() {
    try {
      const response = await fetch("/revision", { cache: "no-store" });
      if (!response.ok) throw new Error("Preview unavailable");
      const current = await response.text();
      if (current !== revision) {
        if (!controls.disabled && source.value === source.defaultValue) location.reload();
        else updates.textContent = "Files changed. Generate to update.";
      } else updates.textContent = "";
    } catch {
      updates.textContent = "Preview disconnected. Restart pnpm preview or pnpm dev.";
    } finally {
      setTimeout(poll, 1000);
    }
  }
  if (preview.dataset.watch === "true") setTimeout(poll, 1000);
}
