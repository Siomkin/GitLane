# Tasks

## 1. Picker view-model

- [x] 1.1 Extend `remoteAccountPickerModel` in `remoteAccountOptions.ts` to take the host's tokens and return labelled options (`gh`, `token`, `system`) with non-colliding values; verify in `remoteAccountOptions.test.ts` that a `gh` account and a token with the same login appear as two options, and a token for another host does not appear
- [x] 1.2 Omit the `system` option when the host has a keychain token; verify in `remoteAccountOptions.test.ts` with and without a token
- [x] 1.3 Compute the selected option in the same order as `transportAuthForRemote`, reusing `providerTokenKey` and `pickProviderTokenForHost`; verify in `remoteAccountOptions.test.ts` for a URL with no username, a `gh`-matching username in different case, a token-keyed username, and an unknown username

## 2. Saving the choice

- [x] 2.1 Let `setRemoteAccount` in `src/store/accounts.ts` take a token choice: write no username when the login matches a `gh` account on the host in any case, otherwise write `transportUsername ?? login`; verify with store tests for both cases
- [x] 2.2 Write the `{ version: 2, unbound: true }` binding when a token is chosen on the default remote; verify with a store test that a legacy `gh` binding no longer selects `repoAccountRef`, and that `prAccountRef` returns the token's `native` ref
- [x] 2.3 Verify with a store test that `planRemoteUsernameMigration` does not write a username back after a token choice, and that `transportAuthForRemote` returns `providerToken` for both URL forms from 2.1 while a `gh` choice still returns `githubGh`

## 3. Picker UI

- [x] 3.1 Render the model's options in `RemoteAccountPicker.tsx` with their source label, pass the choice through `RemoteRow.tsx` and `RemotesPanel.tsx`, and verify in `RemoteAccountPicker.test.tsx` that picking the token calls the pick handler with the token choice
- [x] 3.2 Render the picker only with two or more options and otherwise keep the existing note; show "Connect another…" whenever the picker renders; verify in `RemoteAccountPicker.test.tsx` for only-a-token, SSH, and picker-with-token cases
- [x] 3.3 Verify in `RemotesPanel.test.tsx` that the summary card shows the token's login after a token is chosen on the default remote
- [x] 3.4 Update the "GitHub / multi-account model" section of `CLAUDE.md` to say a keychain token can be chosen per remote and that a URL with no username selects it; verify the section matches `transportAuthForRemote`

## 4. Integration checks

- [x] 4.1 Run `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, and `bun run coverage`, and verify each exits 0
- [x] 4.2 In `bun run tauri dev`, with a `gh` account and a same-login keychain token on github.com, choose the token on `origin`, fetch, and open the pull requests view; verify both succeed, the picker still shows the token after reopening the repository, and `gh auth status` is unchanged
