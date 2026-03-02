#!/usr/bin/env bash
set -euo pipefail

GITCDN_URL="${GITCDN_URL:-https://gitdelivr.net}"
RESULTS_DIR="${RESULTS_DIR:-ci-results}"

mkdir -p "$RESULTS_DIR"

echo "git version: $(git --version)"
echo "git path: $(command -v git)"
echo "git-lfs version: $(git lfs version || true)"
echo "benchmark target: $GITCDN_URL"

supports_filter_clone() {
  git clone -h 2>&1 | grep -q -- '--filter'
}

skip_bench() {
  local label="$1"
  local reason="$2"
  local logfile="$RESULTS_DIR/${label}.log"
  {
    echo "=== $label ==="
    echo "skipped: $reason"
  } | tee "$logfile"
}

bench() {
  local label="$1"
  shift

  local workdir
  workdir="$(mktemp -d)"
  local logfile="$RESULTS_DIR/${label}.log"

  echo "=== $label ===" | tee "$logfile"
  echo "target dir: $workdir/repo" | tee -a "$logfile"
  if [ -x /usr/bin/time ]; then
    /usr/bin/time -f 'elapsed=%e user=%U sys=%S maxrss_kb=%M exit=%x' \
      env GIT_TRACE_PERFORMANCE=1 git clone "$@" "$workdir/repo" \
      2>&1 | tee -a "$logfile"
  else
    TIMEFORMAT='elapsed=%R user=%U sys=%S'
    {
      time env GIT_TRACE_PERFORMANCE=1 git clone "$@" "$workdir/repo"
    } 2>&1 | tee -a "$logfile"
  fi
  rm -rf "$workdir"
}

bench "gitcdn_commander" --no-checkout "${GITCDN_URL}/github.com/tj/commander.js"
bench "github_commander" --no-checkout "https://github.com/tj/commander.js"

bench "gitcdn_react_depth1" --depth=1 --no-checkout "${GITCDN_URL}/github.com/facebook/react"
bench "github_react_depth1" --depth=1 --no-checkout "https://github.com/facebook/react"

bench "gitcdn_linux_depth1" --depth=1 --no-checkout "${GITCDN_URL}/github.com/torvalds/linux"
bench "github_linux_depth1" --depth=1 --no-checkout "https://github.com/torvalds/linux"

if supports_filter_clone; then
  bench "gitcdn_linux_blobnone" --depth=1 --filter=blob:none --no-checkout "${GITCDN_URL}/github.com/torvalds/linux"
  bench "github_linux_blobnone" --depth=1 --filter=blob:none --no-checkout "https://github.com/torvalds/linux"
else
  skip_bench "gitcdn_linux_blobnone" "git version does not support --filter=blob:none"
  skip_bench "github_linux_blobnone" "git version does not support --filter=blob:none"
fi

bench "gitcdn_mutter_depth1" --depth=1 --single-branch --no-checkout "${GITCDN_URL}/gitlab.gnome.org/GNOME/mutter.git"
bench "github_mutter_depth1" --depth=1 --single-branch --no-checkout "https://github.com/GNOME/mutter.git"
