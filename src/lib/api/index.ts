export * from "./diagnostics";
export * from "./events";
export * from "./git";
export { CommandError, isCommandError, toCommandError } from "./invoke";
export * from "./github";
export * from "./providers";
export * from "./remote";
export * from "./terminal";

import { gitApi } from "./git";
import { githubApi } from "./github";
import { providersApi } from "./providers";
import { remoteApi } from "./remote";
import { terminalApi } from "./terminal";

export const api = { ...gitApi, ...githubApi, ...providersApi, ...remoteApi, ...terminalApi };
