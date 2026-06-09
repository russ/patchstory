---
name: patchstory
description: >
  Turn a pull request or local change into a human-readable, interactive walkthrough
  ("PR story") with the `patchstory` CLI. Auto-detects the source — the current branch's
  open PR if there is one, otherwise the branch vs its default base — or takes an explicit
  PR number / PR URL / git range. The agent authors the narrative itself (chapters with
  intent, risk, reviewer questions, and verification steps), then patchstory renders it as
  one self-contained .html with secrets redacted and opens it in the browser.
  Triggers: "/patchstory", "patchstory this", "make a walkthrough of this PR",
  "tell the story of this PR", "PR walkthrough", "explain this PR for a human",
  "patchstory #123", "patchstory the current branch".
---

# patchstory — human-readable PR walkthroughs

[`patchstory`](https://github.com/russ/patchstory) turns a diff into a self-contained
interactive HTML walkthrough: logical **chapters**, each with intent, the relevant diff
hunks, reviewer questions, a risk level, and verification steps.

Its defining design choice: **the story (a JSON document) is separate from the renderer**, so
an agent can author the story directly. **That is this skill's job.** You read the diff and
write `pr-walkthrough.json`; patchstory renders it. You — reading the code in context — are a
better author than a one-shot API call, and no API key is involved. (patchstory's own `none`
heuristic and `-g anthropic` adapter exist, but this skill does not use them for the
narrative.)

Local-first: no hosted service. By default it renders one self-contained `.html` and opens it
in the browser (serving on the LAN is an alternative — see Notes).

## Prerequisites

- `patchstory` on PATH (`npm i -g patchstory`) — else the scripts fall back to `npx -y patchstory`.
- `node` >= 20, `git`, and `gh` (for PR mode; the public `.diff` fallback only covers public repos).
- Linux or macOS (not Windows).

## Workflow

### 1. Resolve the source + scaffold

This skill ships a helper at `scripts/collect.sh` next to this SKILL.md. Resolve its absolute
path first — it works whether installed as a plugin or symlinked manually:

```bash
COLLECT="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/skills/patchstory/scripts/collect.sh}"
[ -f "$COLLECT" ] || COLLECT="$HOME/.claude/skills/patchstory/scripts/collect.sh"
[ -f "$COLLECT" ] || COLLECT="$(find "$HOME/.claude" -name collect.sh -path '*patchstory*' 2>/dev/null | head -1)"
```

Then run it from inside the target git repo. Pass nothing to auto-detect, or pass a PR number,
PR URL, range (`main...feature`), or branch name:

```bash
bash "$COLLECT"                          # auto-detect (branch PR, else branch vs base)
bash "$COLLECT" 123                      # PR number
bash "$COLLECT" https://github.com/org/repo/pull/123
bash "$COLLECT" main...my-branch
```

(`--repo <dir>` targets another checkout; `--out <dir>` overrides the work-dir root,
default `~/.cache/patchstory`.)

It runs `patchstory scaffold` and prints `WORK`, `SKELETON`, and `RAWDIFF` paths plus the
exact render command. Under the hood:

- `$WORK/skel.json` — a schema-valid `pr-walkthrough.json` skeleton from patchstory's `none`
  heuristic: accurate `source`, `title`, `stats`, `commits`, and **`diff_hunks` line numbers**.
- `$WORK/pr.diff` — the exact diff bytes the skeleton was computed from (so hunk refs stay
  aligned when you `render --diff` it).

### 2. Read the inputs

- `$WORK/skel.json` — your starting point. The `source`/`title`/`stats`/`commits` are correct;
  the chapters are heuristic — replace their prose with a real narrative.
- `$WORK/pr.diff` — the actual diff. **Read this** to understand intent.
- Need the contract? `patchstory schema` prints the canonical JSON Schema.
- **Do not paste secret literals** (tokens, keys) into your JSON — `--redact` masks the
  embedded diff at render time, not your prose.

### 3. Author `$WORK/pr-walkthrough.json`

Write a genuinely better narrative than the heuristic — this is the whole point. Keep
`skel.json`'s `source`, `stats`, and `commits`; rewrite everything else. Aim for a reviewer
who has never seen the change:

- **`summary`** — 2–4 sentences: what changes and *why it matters to a human*, not a file list.
- **`themes`** — a few high-level threads (e.g. "Auth", "DB migration", "Tests").
- **`chapters`** — order them as a **reading path**, not by directory. Group related files into
  one chapter when they tell one sub-story. Each chapter:
  - **`intent`** — *why* this exists / what problem it solves (the most valuable field).
  - **`summary`** — what the diff in this chapter does.
  - **`risk_level`** — `low|medium|high`. Raise for auth, payments, migrations, money math,
    deletions, or anything externally observable.
  - **`review_notes`** — sharp reviewer questions.
  - **`verification_steps`** — concrete things to do/check to trust it.
  - **`files`** + **`diff_hunks`** — reuse the skeleton's hunk line refs; re-summarize each.
- **`reviewer_path`** — chapter `id`s in suggested reading order.
- **`start_here`** — 1–3 `{file, reason}` entries a reviewer should open first.
- Set **`"generator": "claude"`** (or your agent's name) and keep **`"version": "0.1"`**.

Scale effort to the diff: a tiny PR may be 1–2 chapters; a large one, 5–8. Don't pad.

### 4. Render to one self-contained `.html` and open it

Run the command the helper printed. `render` re-validates the JSON (surfacing schema errors),
masks secrets in the embedded diff with `--redact`, and `--open` launches the default browser
(`open` on macOS, `xdg-open` on Linux — detached, returns immediately):

```bash
patchstory render "$WORK/pr-walkthrough.json" --diff "$WORK/pr.diff" \
  --redact --single-file --out "$WORK/walkthrough.html" --open
```

Report the `$WORK/walkthrough.html` path so it can be re-opened or attached. If `--open` can't
reach a browser (headless / no GUI), just report the path.

## The walkthrough JSON schema

Authoritative copy: `patchstory schema`. Required: `version`, `title`, `summary`, `source`
(+ `source.type` ∈ `github_pr|git_diff|commit_range|diff_file`), `stats` (`files_changed`,
`additions`, `deletions` — numbers), `chapters`. Each chapter needs a **unique** `id`, `title`,
`summary`, `risk_level` (`low|medium|high`), and `files`. `diff_hunks` items need `file`,
`start_line`, `end_line` (line numbers in the **new** file). Everything else is optional.

```jsonc
{
  "version": "0.1",
  "title": "Add multi-face media review workflow",
  "summary": "Introduces a creator-approval step for media where more than one face is detected, so multi-person uploads can't auto-publish.",
  "generator": "claude",
  "source": { "type": "github_pr", "repo": "org/repo", "pr_number": 123, "base": "main", "head": "feature/multi-face-review" },
  "stats": { "files_changed": 12, "additions": 340, "deletions": 72 },
  "themes": ["Data model & migrations", "Detection service", "Tests"],
  "reviewer_path": ["face-detection", "review-state", "tests"],
  "start_here": [{ "file": "app/services/face_detection_service.rb", "reason": "Core new logic; everything else supports it." }],
  "chapters": [
    {
      "id": "face-detection",
      "title": "Detect multiple faces in uploaded media",
      "summary": "Adds metadata and detection logic for multi-face media.",
      "intent": "Determine whether creator approval is needed before publishing.",
      "risk_level": "medium",
      "files": ["app/models/media.rb", "app/services/face_detection_service.rb"],
      "diff_hunks": [
        { "file": "app/models/media.rb", "start_line": 42, "end_line": 88, "summary": "Adds face_count and review_state fields." }
      ],
      "review_notes": [
        "Confirm single-face uploads are not accidentally blocked.",
        "What happens when face detection fails or times out?"
      ],
      "verification_steps": [
        "Upload media with one face.",
        "Upload media with multiple faces."
      ]
    }
  ]
}
```

## Notes & gotchas

- **Redaction is handled by `patchstory render --redact`** — no manual masking step. It masks
  token shapes / `KEY=value` / private keys in the embedded diff. The scaffolded skeleton and
  `pr.diff` are left unredacted for you to read; just don't quote secrets in your prose.
- **Want to share on the LAN instead of opening locally?** Render to a folder (`--out
  "$WORK/site"`, drop `--single-file`) and then `patchstory serve "$WORK/site"` in the
  background — it binds `0.0.0.0` and prints a URL other devices can open. The `--port` is a
  starting hint; if taken, serve picks the next free port and prints the real one.
- **Private PRs** need `gh` (authenticated). The public `.diff` fallback is public-repos-only.
- The work dir under `~/.cache/patchstory/` persists; old runs can be deleted freely.
