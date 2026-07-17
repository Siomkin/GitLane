// Vitest setup for the `node` project — pure-logic *.test.ts files that never
// touch the DOM. Only the localStorage shim is installed; jest-dom and RTL
// cleanup live in setup.ts, which the `jsdom` project uses.
import { installLocalStorage } from "./local-storage";

installLocalStorage();
