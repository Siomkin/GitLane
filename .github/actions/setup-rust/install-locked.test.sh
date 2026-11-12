#!/usr/bin/env bash
# Self-check for install-locked.sh against a stub rustup. Nothing in CI runs it:
#   bash .github/actions/setup-rust/install-locked.test.sh
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/install-locked.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin" "$tmp/work"
cat >"$tmp/bin/rustup" <<'EOF'
#!/usr/bin/env bash
# Logs the calls that change the home; `toolchain install` takes $STUB_SLEEP s.
case "$1 $2" in
  "toolchain list") cat "$STUB/listed" 2>/dev/null || true ;;
  "run "*) [[ ! -e "$STUB/broken" ]] ;;
  "toolchain uninstall") echo uninstall >>"$STUB/log"; rm -f "$STUB/broken" ;;
  "toolchain install") echo "start $*" >>"$STUB/log"; sleep "${STUB_SLEEP:-0}"; echo end >>"$STUB/log" ;;
esac
EOF
chmod +x "$tmp/bin/rustup"

run() { (cd "$tmp/work" && PATH="$tmp/bin:$PATH" STUB="$tmp" RUSTUP_HOME="$tmp/home" CHANNEL=1.2.3 bash "$script" >/dev/null 2>&1); }
calls() { cut -d' ' -f1 "$tmp/log" | tr '\n' ' '; }
check() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; exit 1; fi; }

STUB_SLEEP=2 run & STUB_SLEEP=2 run & wait
check "two installs never overlap" "$(calls)" "start end start end "

: >"$tmp/log"
COMPONENTS="rustfmt, clippy" TARGETS=a,b run
check "runs dtolnay's command" "$(head -1 "$tmp/log")" \
  "start toolchain install 1.2.3 --target a --target b --component rustfmt --component clippy --profile minimal --no-self-update"

: >"$tmp/log"; printf 'channel = "1.2.3"\ncomponents = ["rustfmt", "clippy"]\ntargets = ["c"]\n' >"$tmp/work/rust-toolchain.toml"
TARGETS=a run
check "adds what rust-toolchain.toml declares" "$(head -1 "$tmp/log")" \
  "start toolchain install 1.2.3 --target a --target c --component rustfmt --component clippy --profile minimal --no-self-update"

STUB_SLEEP=3 run & sleep 1
check "gives up after the wait" "$(LOCK_WAIT_SECONDS=1 run && echo locked || echo timed-out)" "timed-out"
wait

set -m # own process group per job, so the whole tree can be killed like a cancelled job's
STUB_SLEEP=60 run & sleep 1
kill -9 -- "-$!"
set +m
check "a killed holder leaves no lock" "$(LOCK_WAIT_SECONDS=5 run && echo locked || echo timed-out)" "locked"

: >"$tmp/log"; echo "1.2.3-stub" >"$tmp/listed"; touch "$tmp/broken"
run
check "reinstalls a registered toolchain whose cargo fails" "$(calls)" "uninstall start end "

: >"$tmp/log"
run
check "leaves a working toolchain alone" "$(calls)" "start end "

: >"$tmp/log"; rm "$tmp/listed"; touch "$tmp/broken"
run
check "does not uninstall what is not registered" "$(calls)" "start end "

# From here on PATH has no rustup; CARGO_HOME keeps the real one out of reach.
check "skips without rustup" "$(PATH=/usr/bin:/bin CARGO_HOME="$tmp/none" CHANNEL=1.2.3 bash "$script")" \
  "rustup is not installed yet; the next step installs it."

: >"$tmp/log"; mkdir -p "$tmp/cargo/bin"; cp "$tmp/bin/rustup" "$tmp/cargo/bin/"
PATH=/usr/bin:/bin CARGO_HOME="$tmp/cargo" STUB="$tmp" RUSTUP_HOME="$tmp/home" CHANNEL=1.2.3 bash "$script" >/dev/null 2>&1
check "finds rustup in cargo's bin directory" "$(calls)" "start end "
