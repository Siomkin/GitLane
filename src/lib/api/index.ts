export * from "./git";
export * from "./github";
export * from "./providers";
export * from "./terminal";

import { gitApi } from "./git";
import { githubApi } from "./github";
import { providersApi } from "./providers";
import { terminalApi } from "./terminal";

export const api = { ...gitApi, ...githubApi, ...providersApi, ...terminalApi };
