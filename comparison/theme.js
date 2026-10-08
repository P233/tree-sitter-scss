/* global document, localStorage, matchMedia */
// A blocking script in <head>: it sets the theme before the first paint, so a stored choice never flashes.
{
  const root = document.documentElement;
  const storageKey = "tree-sitter-scss-comparison-theme";
  const system = matchMedia("(prefers-color-scheme: dark)");
  const stored = () => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  };
  const apply = theme => {
    root.dataset.theme = theme;
    document.querySelector("#compare-theme")?.setAttribute("aria-pressed", String(theme === "dark"));
  };

  apply(stored() ?? (system.matches ? "dark" : "light"));
  // Until the reader picks a theme, follow the system setting.
  system.addEventListener("change", event => {
    if (!stored()) apply(event.matches ? "dark" : "light");
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply(root.dataset.theme);
    document.querySelector("#compare-theme").addEventListener("click", () => {
      const theme = root.dataset.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(storageKey, theme);
      } catch {
        // Without storage the choice lasts until the page is reloaded.
      }
      apply(theme);
    });
  });
}
