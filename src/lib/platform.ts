// Synchronous host-platform detection for UI decisions (window-chrome layout,
// keyboard-shortcut hints). Derived from the webview user-agent so it needs no
// async `@tauri-apps/plugin-os` round-trip — avoiding a first-paint flash where
// the layout shifts once the platform resolves. WKWebView reports "Macintosh",
// WebView2 "Windows NT", and WebKitGTK "X11; Linux".

const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isMac = /Mac/i.test(ua);
export const isWindows = /Win/i.test(ua);
export const isLinux = !isMac && /Linux|X11/i.test(ua);

/** The primary modifier key label for shortcut hints: ⌘ on macOS, Ctrl elsewhere. */
export const modKey = isMac ? "⌘" : "Ctrl";

/** "<mod> + Enter" hint, rendered the way each platform writes it. */
export const modEnter = isMac ? "⌘↵" : "Ctrl+↵";
