# PatchStory plugin for Claude Code

A [Claude Code](https://claude.com/claude-code) plugin (one skill) that drives `patchstory` to
produce a human-readable, interactive walkthrough of a PR or local change — with **Claude
itself authoring the narrative** (the JSON IR), not the built-in heuristic or `-g anthropic`
adapter.

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

Prereqs on every machine: `patchstory` >= 0.1.3 on PATH (`npm i -g patchstory`, or the script
falls back to `npx -y patchstory`), plus `node` >= 20, `git`, and `gh` for PR mode. Linux or
macOS (not Windows).

### As a plugin (recommended)

```text
/plugin marketplace add russ/patchstory
/plugin install patchstory@russ-patchstory
```

Then: `/patchstory`, `/patchstory 123`, or "make a walkthrough of this PR". The marketplace
manifest must be on the repo's default branch for `marketplace add` to find it.

### Manually (symlink the skill)

```bash
ln -s "$(pwd)/integrations/claude-code/patchstory/skills/patchstory" ~/.claude/skills/patchstory
```

…or copy that directory into `~/.claude/skills/patchstory`.

## Layout

```
.claude-plugin/marketplace.json                 # marketplace catalog (repo root)
integrations/claude-code/patchstory/            # plugin root (marketplace `source`)
  .claude-plugin/plugin.json                     # plugin manifest
  skills/patchstory/
    SKILL.md                                     # the skill + authoring rubric
    scripts/collect.sh                           # resolves the source, runs `patchstory scaffold`
```

Other agents (Cursor, aider, …) can follow the same recipe directly — see
**“Author the story with your own AI agent”** in the [top-level README](../../README.md).
