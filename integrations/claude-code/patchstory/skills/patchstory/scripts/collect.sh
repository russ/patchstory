#!/usr/bin/env bash
# collect.sh [<pr-number|pr-url|git-range|branch>] [--repo <dir>] [--out <dir>]
#
# Thin wrapper that turns "what change do you mean?" into a patchstory scaffold.
# It resolves a source the way a human would expect, then runs a single
# `patchstory scaffold` to produce, in a fresh work dir:
#
#   - skel.json  : a schema-valid pr-walkthrough.json skeleton (the `none`
#                  heuristic) for the agent to enrich
#   - pr.diff    : the exact raw diff the skeleton was computed from, to pass
#                  back to `patchstory render --diff`
#
# Source resolution:
#   - explicit PR number / PR URL            -> github
#   - explicit range "a..b" / "a...b"         -> diff
#   - explicit branch name                    -> diff (default-base...branch)
#   - no arg + branch has an open PR (gh)     -> github
#   - no arg + no PR                          -> diff (default-base...HEAD)
#
# Portable across Linux and macOS (GNU + BSD userland, bash >= 3.2). Not for Windows.
set -euo pipefail

ARG=""
REPO=""
OUT="${PATCHSTORY_WORK:-$HOME/.cache/patchstory}"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a dir}"; shift 2 ;;
    --out)  OUT="${2:?--out needs a dir}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed -E 's/^# ?//'; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) if [ -z "$ARG" ]; then ARG="$1"; shift; else echo "unexpected arg: $1" >&2; exit 2; fi ;;
  esac
done

PATCHSTORY="$(command -v patchstory || true)"
[ -n "$PATCHSTORY" ] || PATCHSTORY="npx -y patchstory"

if [ -z "$REPO" ]; then
  REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [ -n "$REPO" ]; then cd "$REPO"; fi

have_gh() { command -v gh >/dev/null 2>&1; }
is_pr_url() { [[ "$1" =~ ^https?://github\.com/.+/pull/[0-9]+ ]]; }

default_base() {
  local ref
  ref="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [ -n "$ref" ]; then echo "${ref#refs/remotes/}"; return; fi
  local b
  for b in origin/main origin/master main master; do
    if git rev-parse --verify --quiet "$b" >/dev/null 2>&1; then echo "$b"; return; fi
  done
  echo "main"
}

# PR number -> full URL (patchstory's `github` source wants a URL).
pr_url_for() {
  have_gh || { echo "gh CLI required to resolve a PR number" >&2; exit 1; }
  gh pr view "$1" --json url -q .url 2>/dev/null
}

MODE="" PR_URL="" RANGE="" SLUG=""

if [ -z "$ARG" ]; then
  if have_gh && PR_URL="$(gh pr view --json url -q .url 2>/dev/null)" && [ -n "$PR_URL" ]; then
    MODE="github"
  else
    MODE="diff"; RANGE="$(default_base)...HEAD"
  fi
elif [[ "$ARG" =~ ^[0-9]+$ ]]; then
  MODE="github"; PR_URL="$(pr_url_for "$ARG")"
  [ -n "$PR_URL" ] || { echo "could not resolve PR #$ARG" >&2; exit 1; }
elif is_pr_url "$ARG"; then
  MODE="github"; PR_URL="$ARG"
elif [[ "$ARG" == *".."* ]]; then
  MODE="diff"; RANGE="$ARG"
else
  MODE="diff"; RANGE="$(default_base)...${ARG}"
fi

if [ "$MODE" = "github" ]; then
  SLUG="pr-$(printf '%s' "$PR_URL" | grep -oE '[0-9]+' | tail -1)"
else
  [ -n "$REPO" ] || { echo "not in a git repo (use --repo)" >&2; exit 1; }
  SLUG="$(printf '%s' "${RANGE##*..}" | tr '/ ' '--' | LC_ALL=C sed -E 's/[^A-Za-z0-9._-]//g')"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$OUT/${SLUG:-change}-$STAMP"
mkdir -p "$WORK"

echo ">> mode=$MODE  work=$WORK" >&2

if [ "$MODE" = "github" ]; then
  $PATCHSTORY github "$PR_URL" --scaffold -o "$WORK/skel.json" --emit-diff "$WORK/pr.diff" >&2
else
  $PATCHSTORY diff "$RANGE" --repo "$REPO" --scaffold -o "$WORK/skel.json" --emit-diff "$WORK/pr.diff" >&2
fi

node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log("title:   " + d.title);
  console.log("source:  " + JSON.stringify(d.source));
  console.log("stats:   " + JSON.stringify(d.stats));
  console.log("commits: " + (d.commits ? d.commits.length : 0));
  console.log("skeleton chapters:");
  for (const c of d.chapters || []) console.log("    - " + c.title + "  [" + (c.files || []).length + " file(s)]");
' "$WORK/skel.json"

cat <<EOF

WORK=$WORK
SKELETON=$WORK/skel.json     # heuristic starting point — read + enrich this
RAWDIFF=$WORK/pr.diff        # exact diff bytes — pass to render --diff

NEXT: rewrite $WORK/skel.json into a real narrative (save as pr-walkthrough.json), then open it:
  $PATCHSTORY render "$WORK/pr-walkthrough.json" --diff "$WORK/pr.diff" --redact --single-file --out "$WORK/walkthrough.html" --open
EOF
