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
