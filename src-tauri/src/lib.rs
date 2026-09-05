//! GitLane Tauri commands — the IPC boundary the React frontend calls into.
//!
//! Read commands return rich serializable structs (see `git::types`); write
//! commands return the raw `git` CLI output so the UI can surface it. The
//! commands themselves live under `commands/`, one module per domain; this
//! file owns the app builder and the single `generate_handler!` registration
//! list.

mod acp;
mod acp_agents;
mod auth_providers;
mod commands;
mod events;
mod git;
mod log;
mod redact;
mod secrets;
mod shell;
mod signing_keys;
/// The one end-to-end smoke path, over the real IPC boundary (see the module).
#[cfg(test)]
mod smoke;
mod terminal;
mod terminal_agents;
mod updater;
mod watcher;

use terminal::TerminalState;
use watcher::WatcherState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // If git spawned this binary as its GIT_ASKPASS helper (provider-token
    // transport auth), answer the credential prompt through the command-scoped
    // parent broker and exit before Tauri initialises — the helper process opens
    // no window, keychain, or IPC. Must stay first so a normal launch is never
    // mistaken for it (the marker env var is set only on the git child we spawn).
    if git::credential_bridge::is_askpass_invocation() {
        git::credential_bridge::respond_to_askpass();
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // The process plugin (cross-platform) is how the updater relaunches the app.
        .plugin(tauri_plugin_process::init())
        .manage(WatcherState::default())
        .manage(TerminalState::default())
        .manage(commands::repo::CloneState::default())
        .manage(commands::github::SignInState::default())
        .manage(commands::auth::OauthState::default())
        .setup(|app| {
            // Warm the login-shell PATH cache off the main thread at startup.
            // `shell::path()` resolves the user's real PATH by running a login
            // shell (`$SHELL -lic …`) on first use and caches it. The synchronous
            // `working_changes` command touches it (via LFS detection's
            // `command_on_path("git-lfs")`), so a cold cache would run that
            // login-shell probe on the webview main thread and stall the first
            // status read. Priming it here on the blocking pool means the first
            // real call hits a warm `OnceLock`.
            tauri::async_runtime::spawn_blocking(|| {
                let _ = crate::shell::path();
            });

            // The updater is desktop-only; registering it here (rather than in the
            // builder chain) keeps a future mobile build compiling without it. The
            // frontend drives it via @tauri-apps/plugin-updater.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // macOS app menu: replace the default with an enriched "About GitLane"
            // panel (version/author/website/license) while keeping the standard
            // Services/Hide/Quit, Edit (clipboard), and Window items. Windows/Linux
            // use our frameless custom chrome, so no native menu there.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};

                let about = AboutMetadataBuilder::new()
                    .name(Some("GitLane"))
                    // macOS renders "Version <version> (<short_version>)". Tauri sets
                    // CFBundleVersion == CFBundleShortVersionString, so passing both
                    // would read "0.1.0 (0.1.0)". Blank short_version to drop the
                    // redundant parenthetical build and show "Version 0.1.0" once.
                    .version(Some(env!("CARGO_PKG_VERSION")))
                    .short_version(Some(""))
                    .authors(Some(vec!["Alexander Siomkin".to_string()]))
                    .comments(Some("Visual git client for macOS"))
                    .copyright(Some("© 2026 Alexander Siomkin"))
                    .website(Some("https://gitlane.space"))
                    .website_label(Some("gitlane.space"))
                    .license(Some("GPL-3.0-or-later"))
                    .build();

                let app_menu = SubmenuBuilder::new(app, "GitLane")
                    .about(Some(about))
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .separator()
                    .close_window()
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::repo::open_repo,
            commands::repo::commit_graph,
            commands::repo::search_history,
            commands::repo::suggest_tree_paths,
            commands::repo::list_branches,
            commands::worktrees::list_worktrees,
            commands::worktrees::add_worktree,
            commands::worktrees::create_branch_in_worktree,
            commands::worktrees::move_branch_to_worktree,
            commands::worktrees::delete_branch_with_worktree,
            commands::branches::checkout,
            commands::branches::checkout_remote_branch,
            commands::branches::create_branch,
            commands::branches::delete_branch,
            commands::recovery::list_reflog,
            commands::recovery::preview_reset,
            commands::recovery::preview_discard_all,
            commands::worktrees::preview_remove_worktree,
            commands::recovery::preview_delete_branch,
            commands::recovery::preview_delete_remote_branch,
            commands::recovery::preview_force_push,
            commands::branches::rename_branch,
            commands::branches::set_upstream,
            commands::branches::merge_branch,
            commands::repo::can_fast_forward,
            commands::branches::fast_forward_branch,
            commands::branches::rebase_onto,
            commands::branches::reset_to,
            commands::branches::cherry_pick_many,
            commands::branches::revert_many,
            commands::conflicts::operation_status,
            commands::conflicts::conflict_file,
            commands::conflicts::accept_conflict_side,
            commands::conflicts::resolve_conflict_file,
            commands::conflicts::mark_conflict_resolved,
            commands::conflicts::reconflict_file,
            commands::conflicts::continue_operation,
            commands::conflicts::abort_operation,
            commands::conflicts::skip_operation,
            commands::tags::create_tag,
            commands::tags::create_annotated_tag,
            commands::tags::create_patch,
            commands::tags::create_patch_range,
            commands::tags::create_working_tree_patch,
            commands::tags::delete_tag,
            commands::remotes::delete_remote_tag,
            commands::remotes::push_tag,
            commands::worktrees::remove_worktree,
            commands::worktrees::worktree_dirty_state,
            commands::worktrees::worktree_is_dirty,
            commands::remotes::delete_remote_branch,
            commands::remotes::force_push,
            commands::recovery::discard_all,
            commands::files::list_repo_files,
            commands::files::repo_file_text,
            commands::files::repo_file_head_text,
            commands::files::write_repo_file,
            commands::status::working_changes,
            commands::status::file_diff,
            commands::status::commit_files,
            commands::status::read_binary_blob,
            commands::status::commit_file_diff,
            commands::status::diff_range,
            commands::status::diff_range_file,
            commands::status::selection_diff,
            commands::status::selection_diff_file,
            commands::status::file_history,
            commands::status::file_blame,
            commands::status::compare_refs,
            commands::repo::range_commits,
            commands::repo::ancestor_refs,
            commands::repo::default_base_branch,
            commands::status::compare_file_diff,
            commands::staging::apply_hunk,
            commands::staging::apply_line,
            commands::staging::stage_files,
            commands::staging::unstage_files,
            commands::staging::preview_discard_file,
            commands::staging::discard_file,
            commands::staging::append_ignore_pattern,
            commands::files::reveal_in_file_manager,
            commands::files::open_path_default,
            commands::files::open_path_difftool,
            commands::staging::stop_tracking,
            commands::staging::worktree_differs_from_commit,
            commands::staging::commit_path_is_restorable,
            commands::staging::restore_path_from_commit,
            commands::staging::stage_all,
            commands::staging::unstage_all,
            commands::recovery::inspect_index_lock,
            commands::recovery::remove_index_lock,
            commands::commits::commit,
            commands::commits::squash_commits,
            commands::commits::squash_range,
            commands::commits::squash_branch,
            commands::commits::stash,
            commands::commits::stash_paths,
            commands::commits::list_stashes,
            commands::commits::stash_apply,
            commands::commits::stash_apply_index,
            commands::commits::stash_branch,
            commands::commits::stash_pop,
            commands::commits::stash_drop,
            commands::remotes::pull,
            commands::remotes::fetch,
            commands::remotes::push_branch,
            commands::remotes::publish_branch,
            commands::github::github_accounts,
            commands::github::github_sign_in,
            commands::github::cancel_github_sign_in,
            commands::github::github_sign_out,
            commands::auth::forge_auth_statuses,
            commands::auth::forge_account,
            commands::auth::forge_sign_out,
            commands::auth::credential_helper_status,
            commands::auth::approve_https_credential,
            commands::auth::reject_https_credential,
            commands::auth::save_provider_token,
            commands::auth::delete_provider_token,
            commands::auth::provider_token_status,
            commands::auth::provider_oauth_sign_in,
            commands::auth::cancel_provider_oauth_sign_in,
            commands::auth::oauth_client_status,
            commands::auth::set_oauth_client_id,
            commands::auth::refresh_tool_probes,
            commands::remotes::repo_forge,
            commands::remotes::list_remotes,
            commands::remotes::add_remote,
            commands::remotes::set_remote_url,
            commands::remotes::set_remote_username,
            commands::remotes::remove_remote,
            commands::github::list_pull_requests,
            commands::github::pull_request_detail,
            commands::github::pull_request_checks,
            commands::github::pull_request_commits,
            commands::github::pull_request_stack,
            commands::github::repository_stacks,
            commands::github::pull_request_diff,
            commands::github::pull_request_review_threads,
            commands::github::resolve_review_thread,
            commands::github::merge_pull_request,
            commands::github::merge_pull_request_stack,
            commands::github::approve_pull_request,
            commands::github::set_pull_request_state,
            commands::github::create_pull_request,
            commands::github::pull_request_reviewer_candidates,
            commands::github::link_pull_request_stack,
            commands::identity::set_repo_identity,
            commands::identity::repo_identity,
            commands::identity::default_git_identity,
            commands::identity::list_signing_keys,
            commands::identity::clear_repo_identity,
            commands::repo::clone_repo,
            commands::repo::cancel_clone,
            commands::repo::init_repo,
            commands::repo::init_repo_in_place,
            commands::updater::check_update_on_channel,
            commands::repo::recents_status,
            commands::repo::reveal_path,
            commands::terminal::terminal_agents_get,
            commands::terminal::terminal_agents_set,
            commands::terminal::terminal_agents_reset,
            commands::terminal::commit_agent_messages_get,
            commands::terminal::commit_agent_messages_set,
            commands::terminal::commit_agent_messages_reset,
            commands::terminal::terminal_agent_probe,
            commands::terminal::acp_prompt,
            commands::terminal::acp_cancel,
            commands::terminal::acp_probe,
            commands::terminal::acp_adapters,
            commands::terminal::acp_agents_get,
            commands::terminal::acp_agents_set,
            commands::terminal::acp_agents_reset,
            commands::terminal::pty_spawn,
            commands::terminal::pty_write,
            commands::terminal::pty_resize,
            commands::terminal::pty_kill,
            commands::repo::watch_repo,
            commands::repo::unwatch_repo,
        ])
        .run(tauri::generate_context!())
        // INVARIANT: Tauri's event loop has no recoverable error path; process
        // exit is the contract.
        .expect("error while running tauri application");
}
