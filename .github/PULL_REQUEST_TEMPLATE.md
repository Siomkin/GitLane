<!-- PR title format: GL-12 Short summary or GL-12 fix(scope): Short summary when Jira exists; otherwise Short summary or docs(scope): Short summary. Include a useful description below for non-trivial changes. -->

## Summary

<!-- What changed, and why? -->

## Related Issue

<!-- Fixes #123, Closes #123, or link related context. -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] UI change
- [ ] Tauri/Rust backend change
- [ ] IPC/API contract change
- [ ] Documentation
- [ ] CI/release
- [ ] Other

## Validation

<!-- Check the commands that apply. Explain anything skipped. -->

- [ ] `bun run build`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run test`
- [ ] `(cd src-tauri && cargo check)`
- [ ] `(cd src-tauri && cargo test)`
- [ ] `bun run tauri dev` smoke test

## Screenshots

<!-- Required for visible UI changes. Remove if not applicable. -->

## Checklist

- [ ] I read `CONTRIBUTING.md`
- [ ] I checked `docs/rules/architecture-rules.md` for the relevant side of the change
- [ ] IPC changes update Rust commands/types and frontend API/types together
- [ ] New dependencies are justified
