#!/usr/bin/env bash
# Install a Rust toolchain while holding a lock on the rustup home.
#
# Jobs can share a rustup home, and rustup does not lock it. Several of them
# installing the same toolchain at once can leave it broken for every job after
# them. With the install done here, under the lock, the `dtolnay/rust-toolchain`
# step that follows finds everything in place and changes nothing.
#
# Env: CHANNEL; optional COMPONENTS and TARGETS (comma- or space-separated).
# Run from the repository root.
# Self-check: bash .github/actions/setup-rust/install-locked.test.sh
set -euo pipefail

: "${CHANNEL:?}"

# PATH may not have cargo's bin directory yet: the dtolnay step adds it, for
# the steps after it.
PATH="$PATH:${CARGO_HOME:-$HOME/.cargo}/bin"
if ! command -v rustup >/dev/null; then
  echo "rustup is not installed yet; the next step installs it."
  exit 0
fi

rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
# Shorter than the shortest job timeout (15 minutes), so the error below prints.
wait_seconds="${LOCK_WAIT_SECONDS:-600}"
mkdir -p "$rustup_home"
exec 9>"$rustup_home/.toolchain-install.lock"
echo "Waiting for the toolchain lock in $rustup_home"
# Both take a kernel lock on descriptor 9, which is released when the last
# process holding it exits, so a killed job leaves no stale lock behind.
if command -v flock >/dev/null; then
  flock -w "$wait_seconds" 9
else
  # macOS has no flock(1), but it ships perl.
  perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or die $!; alarm shift; flock($fh, LOCK_EX) or die $!' "$wait_seconds"
fi || {
  echo "::error::No toolchain lock on $rustup_home after ${wait_seconds}s: another job is still installing Rust there."
  exit 1
}

# An interrupted or raced install can leave the toolchain registered without a
# working cargo, and `rustup toolchain install` then calls it up to date. Only
# checked under the lock, where no other job can be halfway through an install.
installed="$(rustup toolchain list)"
if grep -q "^$CHANNEL-" <<<"$installed" && ! rustup run "$CHANNEL" cargo --version >/dev/null 2>&1; then
  echo "::warning::Rust $CHANNEL is registered in $rustup_home but its cargo does not run; reinstalling it."
  rustup toolchain uninstall "$CHANNEL"
fi

# rustup also installs what rust-toolchain.toml declares, on the first cargo
# call and outside this lock, so those components and targets go in here too.
# shortcut: reads one-line lists only, parse TOML properly if the file gets a multi-line one.
declared() { [[ ! -f rust-toolchain.toml ]] || sed -n "s/^$1 = \[\(.*\)\]/\1/p" rust-toolchain.toml | tr -d '"'; }
targets="${TARGETS:-},$(declared targets)"
components="${COMPONENTS:-},$(declared components)"

# The command dtolnay/rust-toolchain runs, so that step becomes a no-op.
args=(toolchain install "$CHANNEL")
for target in ${targets//,/ }; do args+=(--target "$target"); done
for component in ${components//,/ }; do args+=(--component "$component"); done
RUSTUP_PERMIT_COPY_RENAME=1 rustup "${args[@]}" --profile minimal --no-self-update
