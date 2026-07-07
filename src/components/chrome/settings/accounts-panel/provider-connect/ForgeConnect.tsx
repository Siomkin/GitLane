// The connect body for a non-GitHub provider. Every way to connect — personal
// access token, the provider CLI, native OAuth — is a distinct MethodCard, so
// the methods read as separate options instead of a blur. One method leads as
// "Recommended"; the rest sit under "Or connect another way". Which leads is
// setup-aware: once an OAuth client id is registered, OAuth leads (one click,
// keychain-backed); before that the simpler paste-a-token path leads (GL-139).

import { cn } from "../../../../../lib/cn";
import { focusRing } from "../../../../../lib/ui";
import { openExternalUrl } from "../../../../../lib/openExternal";
import type { ForgeAuthStatus } from "../../../../../lib/api";
import { accountHandle } from "../providers";
import { CopyCommand } from "../CopyCommand";
import { CredentialHelperForm } from "./CredentialHelperForm";
import { OauthMethod } from "./OauthMethod";
import { MethodCard } from "./MethodCard";
import { DEFAULT_CREDENTIAL_HOST, isOauthProvider, sshKeyHelp, tokenCreationUrl, useOauthConfigured } from "./oauth";
import { DownloadIcon, ExternalIcon, KeyIcon, LockIcon, ShieldIcon, TerminalIcon, linkCls } from "./ui";

function TokenBody({ status }: { status: ForgeAuthStatus }) {
  const host = DEFAULT_CREDENTIAL_HOST[status.provider] ?? "your host";
  const createUrl = tokenCreationUrl(status.provider, host) ?? status.docsUrl;
  return (
    <>
      <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Create an access token on <span className="font-mono">{host}</span> and paste it below — save it to your git
        credential helper or GitLane's OS keychain (your choice) so push and fetch work.
      </p>
      <button onClick={() => openExternalUrl(createUrl)} className={cn(linkCls, "mt-2")}>
        <ExternalIcon />
        Create a token on {status.forge}
      </button>
      <div className="mt-2.5">
        <CredentialHelperForm status={status} usernameHint={status.account?.username} />
      </div>
      {status.provider === "bitbucket" && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          Bitbucket usually uses your Bitbucket username with an API token as the password. Some token types use{" "}
          <code className="font-mono">x-bitbucket-api-token-auth</code> as the username.
        </p>
      )}
    </>
  );
}

function CliBody({ status }: { status: ForgeAuthStatus }) {
  const cli = status.cli ?? "";
  if (!status.available) {
    return (
      <>
        <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          The <code className="font-mono text-[12px]">{cli}</code> command-line tool isn’t installed yet — a setup step,
          not a broken account. Install it, then press Refresh.
        </p>
        <button
          onClick={() => openExternalUrl(status.docsUrl)}
          className={cn(
            "mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white transition hover:brightness-110",
            focusRing,
          )}
        >
          Install {cli}
        </button>
      </>
    );
  }
  return (
    <>
      <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Run the login command in a terminal, then press Refresh.
      </p>
      <div className="mt-2.5">
        <CopyCommand command={status.loginCommand} />
      </div>
    </>
  );
}

function SshBody({ status }: { status: ForgeAuthStatus }) {
  const host = DEFAULT_CREDENTIAL_HOST[status.provider] ?? "";
  const { addUrl, docsUrl } = sshKeyHelp(status.provider, host);
  return (
    <>
      <p className="text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Prefer SSH? Add your public key to {status.forge} and an <span className="font-mono">ssh://</span> remote
        authenticates with your key and ssh-agent — no token, and GitLane stores nothing.
      </p>
      {(addUrl || docsUrl) && (
        <div className="mt-2 flex flex-col gap-1.5">
          {addUrl && (
            <button onClick={() => openExternalUrl(addUrl)} className={linkCls}>
              <ExternalIcon />
              Add an SSH key on {status.forge}
            </button>
          )}
          {docsUrl && (
            <button onClick={() => openExternalUrl(docsUrl)} className={linkCls}>
              <ExternalIcon />
              How to set up SSH keys
            </button>
          )}
        </div>
      )}
    </>
  );
}

interface Method {
  key: string;
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}

export function ForgeConnect({
  status,
  accountLoading,
  refresh,
}: {
  status: ForgeAuthStatus;
  accountLoading: boolean;
  refresh: React.ReactNode;
}) {
  const cli = status.cli ?? "";
  const oauth = isOauthProvider(status.provider);
  const defaultHost = DEFAULT_CREDENTIAL_HOST[status.provider] ?? "";
  // `null` (probing) is treated as "not configured" so the token path leads until
  // an OAuth client id is proven registered — then OAuth is promoted.
  const oauthReady = useOauthConfigured(oauth ? status.provider : null, defaultHost) === true;
  const authed = status.authenticated === true;
  const resolving = accountLoading && !status.account;

  const token: Method = {
    key: "token",
    icon: <KeyIcon />,
    title: "Personal access token",
    body: <TokenBody status={status} />,
  };
  const cliMethod: Method | null = status.cli
    ? {
        key: "cli",
        icon: status.available ? <TerminalIcon /> : <DownloadIcon />,
        title: `${status.forge} CLI`,
        body: <CliBody status={status} />,
      }
    : null;
  const oauthMethod: Method | null = oauth
    ? {
        key: "oauth",
        icon: <ShieldIcon />,
        title: "Sign in with OAuth",
        body: <OauthMethod provider={status.provider} forge={status.forge} />,
      }
    : null;
  // SSH is available for every forge and never GitLane-managed, so it always
  // trails the HTTPS methods as a link-out.
  const sshMethod: Method = {
    key: "ssh",
    icon: <LockIcon />,
    title: "SSH key",
    body: <SshBody status={status} />,
  };

  // Recommended first: OAuth once a client id is registered, otherwise the token.
  const ordered: (Method | null)[] =
    oauthReady && oauthMethod
      ? [oauthMethod, token, cliMethod, sshMethod]
      : [token, cliMethod, oauthMethod, sshMethod];
  const methods = ordered.filter((m): m is Method => m !== null);
  const [primary, ...rest] = methods;

  return (
    <div className="flex flex-col gap-3">
      {authed && (
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-2.5">
          <div className="text-[12.5px] font-semibold text-emerald-700 dark:text-emerald-400">
            {status.account
              ? `Signed in as ${accountHandle(status.account)}`
              : resolving
                ? "Signed in — resolving account…"
                : `Signed in to ${cli}`}
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            Authenticated for git transport. Pull requests aren’t available for {status.forge} in GitLane yet.
          </p>
        </div>
      )}

      {primary && (
        <MethodCard icon={primary.icon} title={primary.title} recommended={!authed}>
          {primary.body}
        </MethodCard>
      )}

      {rest.length > 0 && (
        <>
          <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            Or connect another way
          </div>
          {rest.map((m) => (
            <MethodCard key={m.key} icon={m.icon} title={m.title}>
              {m.body}
            </MethodCard>
          ))}
        </>
      )}

      <div className="mt-0.5 flex items-center gap-3">
        {refresh}
        <button onClick={() => openExternalUrl(status.docsUrl)} className={linkCls}>
          Learn more
        </button>
      </div>
      {status.notes && <p className="text-[11.5px] text-neutral-400 dark:text-neutral-500">{status.notes}</p>}
    </div>
  );
}
