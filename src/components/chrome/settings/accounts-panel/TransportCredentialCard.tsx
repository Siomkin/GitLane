import { useReducer } from "react";
import type { ForgeAuthProvider } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  defaultsToProviderTokenForPullRequests,
  isForgeAuthProvider,
  supportsProviderTokenAuth,
} from "@/lib/forgeHelp";
import { focusRing } from "@/lib/ui";
import { useAccounts } from "@/store/accounts";
import { useUi } from "@/store/ui";
import { inputCls } from "./provider-connect/ui";
import { providerInitials, providerLabel, type ProviderKey } from "./providers";

export interface TransportCredentialAccount {
  provider: ProviderKey;
  credentialHost: string;
  credentialPath: string | null;
  login: string;
  remoteName: string;
}

type CredentialMessage = { tone: "ok" | "warn" | "error"; text: string };
interface CredentialDraftState {
  editing: boolean;
  usernameDraft: string;
  password: string;
  useForPullRequests: boolean;
  message: CredentialMessage | null;
}

type CredentialDraftAction =
  | { type: "open"; login: string; provider: ProviderKey }
  | { type: "close" }
  | { type: "username"; value: string }
  | { type: "password"; value: string }
  | { type: "useForPullRequests"; value: boolean }
  | { type: "message"; value: CredentialMessage | null }
  | { type: "saved"; value: CredentialMessage };

const initialCredentialDraft = (provider: ProviderKey): CredentialDraftState => ({
  editing: false,
  usernameDraft: "",
  password: "",
  useForPullRequests: defaultsToProviderTokenForPullRequests(provider),
  message: null,
});

function credentialDraftReducer(
  state: CredentialDraftState,
  action: CredentialDraftAction,
): CredentialDraftState {
  switch (action.type) {
    case "open":
      return {
        editing: true,
        usernameDraft: action.login,
        password: "",
        useForPullRequests: defaultsToProviderTokenForPullRequests(action.provider),
        message: null,
      };
    case "close":
      return { ...state, editing: false };
    case "username":
      return { ...state, usernameDraft: action.value };
    case "password":
      return { ...state, password: action.value };
    case "useForPullRequests":
      return { ...state, useForPullRequests: action.value };
    case "message":
      return { ...state, message: action.value };
    case "saved":
      return { ...state, editing: false, password: "", message: action.value };
  }
}

export function TransportCredentialCard({ account }: { account: TransportCredentialAccount }) {
  const [draft, dispatchDraft] = useReducer(
    credentialDraftReducer,
    account.provider,
    initialCredentialDraft,
  );
  const saveRemoteCredential = useAccounts((s) => s.saveRemoteCredential);
  const saveProviderToken = useAccounts((s) => s.saveProviderToken);
  const forgetHttpsCredential = useAccounts((s) => s.forgetHttpsCredential);
  const setRemoteUsername = useAccounts((s) => s.setRemoteUsername);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const username = draft.editing ? draft.usernameDraft : account.login;
  const disabled = username.trim() === "" || draft.password === "";
  const forge = providerLabel(account.provider);
  const trackedProvider: ForgeAuthProvider | undefined = isForgeAuthProvider(account.provider)
    ? account.provider
    : undefined;
  const canTryPullRequests = supportsProviderTokenAuth(account.provider);

  const toggleEditing = () => {
    if (draft.editing) {
      dispatchDraft({ type: "close" });
      return;
    }
    dispatchDraft({ type: "open", login: account.login, provider: account.provider });
  };

  const save = () => {
    const cleanUser = username.trim();
    dispatchDraft({ type: "message", value: null });
    void saveRemoteCredential(account.remoteName, cleanUser, draft.password).then(async (transportSaved) => {
      if (!transportSaved) {
        dispatchDraft({
          type: "message",
          value: { tone: "error", text: "Credential was not saved. Check the error and try again." },
        });
        return;
      }
      if (canTryPullRequests && trackedProvider && draft.useForPullRequests) {
        const prSaved = await saveProviderToken(
          trackedProvider,
          account.credentialHost,
          cleanUser,
          draft.password,
          { silent: true },
        );
        if (!prSaved) {
          dispatchDraft({
            type: "message",
            value: {
              tone: "warn",
              text: "Saved for git transport, but the PR token could not be stored. The token is still here so you can retry.",
            },
          });
          return;
        }
        dispatchDraft({
          type: "saved",
          value: { tone: "ok", text: "Saved for git transport and pull requests." },
        });
        return;
      }
      dispatchDraft({ type: "saved", value: { tone: "ok", text: "Saved for git transport." } });
    });
  };
  const forget = () =>
    requestConfirm({
      title: `Forget ${forge} credential?`,
      message:
        "Removes the saved secret from your Git credential helper. The remote username stays configured.",
      confirmLabel: "Forget",
      danger: true,
      onConfirm: () =>
        void forgetHttpsCredential(account.credentialHost, account.credentialPath, account.login, trackedProvider),
    });
  const remove = () =>
    requestConfirm({
      title: `Remove @${account.login} from ${account.remoteName}?`,
      message:
        "Removes the username from the remote URL so this remote goes back to system git credentials. Saved helper credentials are not deleted.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () => void setRemoteUsername(account.remoteName, null),
    });

  return (
    <div className="px-3.5 py-3">
      <div className="flex items-center gap-3">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] bg-black/[0.06] text-[12px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
          {providerInitials(forge)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">@{account.login}</span>
            <span className="grid h-[17px] place-items-center rounded-full bg-blue-500/12 px-2 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
              GCM/helper
            </span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
            {account.remoteName} · {account.credentialHost} · git transport only
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={toggleEditing}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-neutral-500 transition hover:bg-black/[0.04] hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-white/[0.06] dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            {draft.editing ? "Cancel" : "Update"}
          </button>
          <button
            type="button"
            onClick={forget}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-neutral-500 transition hover:bg-rose-500/10 hover:text-rose-600 dark:text-neutral-400 dark:hover:text-rose-400",
              focusRing,
            )}
          >
            Forget
          </button>
          <button
            type="button"
            onClick={remove}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-neutral-500 transition hover:bg-rose-500/10 hover:text-rose-600 dark:text-neutral-400 dark:hover:text-rose-400",
              focusRing,
            )}
          >
            Remove
          </button>
        </div>
      </div>
      {draft.editing && (
        <div className="mt-3 rounded-lg border border-black/[0.06] bg-black/[0.025] p-3 dark:border-white/[0.08] dark:bg-white/[0.04]">
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={username}
              onChange={(e) => dispatchDraft({ type: "username", value: e.target.value })}
              placeholder="HTTPS username"
              spellCheck={false}
              className={inputCls}
            />
            <input
              value={draft.password}
              onChange={(e) => dispatchDraft({ type: "password", value: e.target.value })}
              placeholder="Token / password"
              type="password"
              spellCheck={false}
              className={cn(
                "h-9 rounded-lg border border-black/10 bg-white px-2.5 text-[12.5px] text-neutral-700 placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
                focusRing,
              )}
            />
          </div>
          {canTryPullRequests && (
            <label className="mt-2 flex items-center gap-2 text-[12px] font-medium text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={draft.useForPullRequests}
                onChange={(e) =>
                  dispatchDraft({ type: "useForPullRequests", value: e.target.checked })
                }
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Try this token for pull requests too
            </label>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={save}
              className={cn(
                "h-9 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-40",
                focusRing,
              )}
            >
              Save credential
            </button>
            <span className="text-[11.5px] leading-snug text-neutral-400 dark:text-neutral-500">
              Updates <span className="font-mono">{account.remoteName}</span> and stores the token in your configured
              Git helper{canTryPullRequests && draft.useForPullRequests ? " and GitLane keychain" : ""}.
            </span>
          </div>
        </div>
      )}
      {draft.message && (
        <div
          className={cn(
            "mt-2 text-[12px] font-medium",
            draft.message.tone === "ok" && "text-emerald-600 dark:text-emerald-400",
            draft.message.tone === "warn" && "text-amber-600 dark:text-amber-400",
            draft.message.tone === "error" && "text-rose-600 dark:text-rose-400",
          )}
        >
          {draft.message.text}
        </div>
      )}
    </div>
  );
}
