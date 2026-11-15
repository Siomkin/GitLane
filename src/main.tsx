import React from "react";
import ReactDOM from "react-dom/client";
import { createRenderErrorReporter } from "./lib/errorReporter";
import { Root } from "./Root";

// Suppress the WKWebView's native right-click menu (Reload / Inspect …) so our
// custom branch context menu isn't covered by it. Editable fields keep their
// native menu for copy/paste.
window.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
});

// macOS WebKit autocorrect pops a suggestion bubble under text fields (and
// "fixes" branch names, SHAs and paths). Turn it off on every field as it
// gains focus, unless the field sets its own value.
window.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (!el.hasAttribute("autocorrect")) el.setAttribute("autocorrect", "off");
  if (!el.hasAttribute("autocapitalize")) el.setAttribute("autocapitalize", "off");
});

// Release builds have no devtools: every render error, contained or not, goes
// to the local frontend error log.
const reportRenderError = createRenderErrorReporter();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onCaughtError: reportRenderError("caught"),
  onUncaughtError: reportRenderError("uncaught"),
}).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
