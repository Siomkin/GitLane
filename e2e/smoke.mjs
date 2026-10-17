// WebDriver smoke for the built app: start tauri-driver, open a session on the
// debug binary, and check the React root mounted in the real webview. It speaks
// the W3C WebDriver protocol with plain fetch, so it adds no client dependency.
//
// Usage (inside the e2e container, under xvfb): bun e2e/smoke.mjs <path-to-binary>

import { spawn } from "node:child_process";

const app = process.argv[2];
if (!app) throw new Error("usage: bun e2e/smoke.mjs <path-to-binary>");

const DRIVER = "http://127.0.0.1:4444";
const driver = spawn("tauri-driver", ["--port", "4444"], { stdio: "inherit" });

async function call(method, path, body) {
  const res = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
  return json.value;
}

async function waitFor(check, what, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // Driver not listening yet, or the page is still loading.
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

let session;
try {
  await waitFor(() => fetch(`${DRIVER}/status`).then((r) => r.ok), "tauri-driver");
  ({ sessionId: session } = await call("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: app } } },
  }));

  const title = await call("GET", `/session/${session}/title`);
  if (title !== "GitLane") throw new Error(`unexpected window title: ${title}`);

  const mounted = await waitFor(
    () =>
      call("POST", `/session/${session}/execute/sync`, {
        script: "return document.querySelector('#root')?.childElementCount ?? 0",
        args: [],
      }),
    "the React root to mount",
  );
  const text = await call("POST", `/session/${session}/execute/sync`, {
    script: "return document.body.innerText.slice(0, 200)",
    args: [],
  });
  console.log(`smoke ok: title=${title}, root children=${mounted}, text=${JSON.stringify(text)}`);
} finally {
  if (session) await call("DELETE", `/session/${session}`).catch(() => {});
  driver.kill();
}
