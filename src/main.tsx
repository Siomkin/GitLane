import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Suppress the WKWebView's native right-click menu (Reload / Inspect …) so our
// custom branch context menu isn't covered by it. Editable fields keep their
// native menu for copy/paste.
window.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
