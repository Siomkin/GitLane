use crate::git::forge::ForgeKind;

pub(super) struct ProviderSpec {
    pub(super) provider: &'static str,
    pub(super) forge: &'static str,
    pub(super) cli: Option<&'static str>,
    pub(super) status_args: &'static [&'static str],
    pub(super) auth_method: &'static str,
    pub(super) login_command: &'static str,
    pub(super) logout_args: Option<&'static [&'static str]>,
    /// When true, `logout_args` alone is insufficient: the CLI's `logout` refuses
    /// to run without an explicit `--hostname` and cannot prompt in our
    /// non-interactive spawn (glab). Sign-out then resolves the signed-in host(s)
    /// from `status_args` and appends `--hostname <host>` per host.
    pub(super) logout_needs_hostname: bool,
    pub(super) docs_url: &'static str,
    pub(super) notes: &'static str,
    /// When true, a zero-exit probe with empty stdout+stderr is treated as
    /// *not* authenticated. Used for `tea login list`, which exits 0 even with
    /// no configured logins — we infer "signed in" only when it emits a login
    /// listing. Assumes an empty login list produces no output; if a future
    /// `tea` prints table chrome for the empty case this would over-report.
    pub(super) require_output: bool,
}

pub(super) const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        provider: "gitlab",
        forge: "GitLab",
        cli: Some("glab"),
        status_args: &["auth", "status"],
        auth_method: "GitLab CLI",
        login_command: "glab auth login",
        logout_args: Some(&["auth", "logout"]),
        logout_needs_hostname: true,
        docs_url: "https://gitlab.com/gitlab-org/cli",
        notes: "Signed in with glab. Merge requests (list, view, create, merge, approve) work when glab is signed in.",
        require_output: false,
    },
    ProviderSpec {
        provider: ForgeKind::CURSOR_ORIGIN_KEY,
        forge: "Cursor Origin",
        cli: Some("origin"),
        status_args: &["auth", "status"],
        auth_method: "Origin CLI",
        login_command: "origin auth login",
        logout_args: Some(&["auth", "logout"]),
        logout_needs_hostname: false,
        docs_url: "https://cursor.com/docs/origin/cli",
        notes: "Signed in with origin. Pull request list, detail, diff, merge, and existing review threads work when origin is signed in. Creating Origin PRs is not in GitLane yet.",
        require_output: false,
    },
    ProviderSpec {
        provider: "bitbucket",
        forge: "Bitbucket",
        cli: None,
        status_args: &[],
        auth_method: "Git credential helper / GCM or SSH",
        login_command: "Use an HTTPS remote with Git Credential Manager, or use an SSH remote with a Bitbucket SSH key.",
        logout_args: None,
        logout_needs_hostname: false,
        docs_url: "https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/",
        notes: "Bitbucket has no bundled CLI. Git transport works through Git's credential helper/GCM for HTTPS, or through SSH keys for SSH remotes.",
        require_output: false,
    },
    ProviderSpec {
        provider: "azure-devops",
        forge: "Azure DevOps",
        cli: Some("az"),
        status_args: &["account", "show", "--output", "none"],
        auth_method: "Azure CLI",
        login_command: "az login",
        logout_args: Some(&["logout"]),
        logout_needs_hostname: false,
        // The connect path's first step is installing `az`, so point at the
        // Azure CLI install guide rather than the Azure DevOps CLI extension docs.
        // Locale-less URL — Learn redirects to the visitor's locale.
        docs_url: "https://learn.microsoft.com/cli/azure/install-azure-cli?view=azure-cli-latest",
        notes: "Uses Azure CLI sign-in as the account signal. Git transport works through GCM/helper for HTTPS, or through SSH keys for SSH remotes.",
        require_output: false,
    },
    ProviderSpec {
        provider: "gitea",
        forge: "Gitea",
        cli: Some("tea"),
        status_args: &["login", "list"],
        auth_method: "tea CLI",
        login_command: "tea login add",
        logout_args: None,
        logout_needs_hostname: false,
        docs_url: "https://gitea.com/gitea/tea",
        notes: "Uses tea login metadata only. Gitea PR features are not implemented.",
        require_output: true,
    },
    ProviderSpec {
        provider: "forgejo",
        forge: "Forgejo",
        cli: Some("tea"),
        status_args: &["login", "list"],
        auth_method: "tea CLI",
        login_command: "tea login add",
        logout_args: None,
        logout_needs_hostname: false,
        docs_url: "https://forgejo.org/docs/latest/user/cli/",
        notes: "Forgejo is Gitea-compatible for tea login metadata. PR features are not implemented.",
        require_output: true,
    },
];
