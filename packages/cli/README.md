# patchstory

Generate a **static, interactive PR walkthrough** from a git diff, commit range,
raw diff file, or GitHub PR — a self-contained HTML site (or a single portable
`.html` file) you can zip, email, attach to a ticket, or open locally with no
server.

```bash
npm install -g patchstory          # or: npx patchstory ...

patchstory diff main...my-branch --single-file --open
patchstory github https://github.com/org/repo/pull/123 --serve
patchstory file ./my-pr.diff --redact
```

The CLI ships as a single self-contained bundle (zero runtime dependencies).
Full documentation, screenshots, and the JSON intermediate format:
**https://github.com/russ/patchstory**
