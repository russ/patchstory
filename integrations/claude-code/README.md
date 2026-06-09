# PatchStory skill for Claude Code

A [Claude Code](https://claude.com/claude-code) skill that drives `patchstory` to produce a
human-readable, interactive walkthrough of a PR or local change — with **Claude itself
authoring the narrative** (the JSON IR), not the built-in heuristic or `-g anthropic` adapter.

It leans on three CLI primitives so it stays thin:

- `patchstory <source> --scaffold --emit-diff` — get a schema-valid skeleton + the exact diff
- `patchstory schema` — the IR contract, for validation
- `patchstory render --diff … --redact` — render the agent's story with secrets masked

## What it does

1. Resolve the source (branch's open PR, else branch-vs-base; or an explicit PR#/URL/range).
2. Scaffold a starting `pr-walkthrough.json` + capture the diff.
3. Claude rewrites the skeleton into a real narrative — chapter intent, risk, reviewer
   questions, verification steps.
4. Render one self-contained `.html` (secrets redacted) and open it in the browser.

## Install

Requires `patchstory` on PATH (`npm i -g patchstory`, or the scripts fall back to
`npx -y patchstory`), plus `node` >= 20, `git`, and `gh` for PR mode. Linux or macOS.

Symlink (recommended — stays in sync as you `git pull`):

```bash
ln -s "$(pwd)/integrations/claude-code/patchstory" ~/.claude/skills/patchstory
```

…or copy it:

```bash
cp -r integrations/claude-code/patchstory ~/.claude/skills/patchstory
```

Then in Claude Code: `/patchstory`, or `/patchstory 123`, or "make a walkthrough of this PR".

## Layout

```
integrations/claude-code/
  README.md
  patchstory/
    SKILL.md            # the skill definition + authoring rubric
    scripts/collect.sh  # resolves the source and runs `patchstory scaffold`
```

Other agents (Cursor, aider, …) can follow the same recipe directly — see
**“Author the story with your own AI agent”** in the [top-level README](../../README.md).
