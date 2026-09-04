## 1. Content-security policy (config + frontend)

- [x] 1.1 Remove `asset:` and `https://asset.localhost` from `img-src` in `src-tauri/tauri.conf.json`; verify `bun run tauri dev` renders every icon/avatar-free screen unchanged and `grep -rn convertFileSrc src` is still empty
- [x] 1.2 Make `src/components/ui/Markdown.tsx` the single image-host allow-list (`isTrustedImageSrc`, `Markdown.tsx:63`) and generate/copy the same list into `img-src`; decide whether `img.shields.io` (`Markdown.tsx:48`) stays; verify a component test that an off-list image renders alt text and an on-list image renders `<img>`
- [x] 1.3 Try `style-src 'self'; style-src-attr 'unsafe-inline'` and verify in `bun run tauri dev` on the oldest supported macOS WebKit that all 127 `style={}` sites still apply; if unsupported, record the finding in `docs/tauri-plugin-decisions.md` and keep `'unsafe-inline'`
- [x] 1.4 Document each capability in `src-tauri/capabilities/default.json` with its JS call site in `docs/tauri-plugin-decisions.md`; verify the doc lists all 17 permissions

## 2. OS openers (Rust impl)

- [x] 2.1 In `src-tauri/src/shell.rs:201-215` and `git/write/reveal.rs` assert the path is absolute (`Path::is_absolute`) before spawning `open -R`, `explorer /select,`, or `xdg-open`, returning an error otherwise; add `--` only for `xdg-open` (documented) — do not assume macOS `open` accepts it; verify unit tests with a `-dash` directory name on each platform branch
- [x] 2.2 Apply the same absolute-path assertion in `git/write/open_path.rs` for the non-Windows branches; verify the existing `rejects_missing_and_unsafe_paths` test (`open_path.rs:196`) gains a leading-dash case

## 3. Release signing (CI + config)

- [x] 3.1 Add Apple certificate import, `APPLE_SIGNING_IDENTITY`, and notarisation env to the `release-app` macOS legs in `.github/workflows/release.yml`, guarded by `secrets.APPLE_CERTIFICATE != ''` via `$GITHUB_ENV` (per the note at `release.yml:467-478`); set `bundle.macOS.signingIdentity` from env instead of `"-"`; verify a dry-run beta tag produces a notarised DMG (`spctl --assess`)
- [x] 3.2 When secrets are absent, append "macOS build is unsigned" to the generated release notes in `publish-release`; verify with a beta release on a fork or dispatch run
- [x] 3.3 Update `docs/release-channels.md` and the `bump-version` skill with the signing prerequisite; verify the docs build (`docs.yml`) passes

## 4. Definition of done

- [x] 4.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)`, `bun run sizes`, `openspec validate tighten-tauri-security-config --strict`; verify all pass
- [ ] 4.2 Exercise in `bun run tauri dev`: open a PR with an external image and a `javascript:` link, reveal a `-dash` worktree in Finder, toggle the beta channel and run an update check; verify each matches its spec scenario
