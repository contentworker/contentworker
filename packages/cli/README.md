# @contentworker/cli

> A private workspace package. It ships on npm inside [`@contentworker/sdk`](../sdk/sdk/README.md) as its `contentworker` binary; the examples below use that name.

The `contentworker` command: sign in to a workspace, keep the content model and the block catalog
in files, read and write entries, upload assets, import files and generate types. Every command
takes `--json` for scripts and agents. Node 24 or later.

```sh
npm install -D @contentworker/sdk

npx contentworker login --url https://api.cms.example.com
npx contentworker doctor
npx contentworker model export --out content-model.ts
npx contentworker model apply content-model.ts --dry-run
npx contentworker blocks push --dry-run
npx contentworker entries list --content-type article --json
npx contentworker import posts.xml --content-type article --map title=title --map body=content --dry-run
npx contentworker types --out src/generated/content-types.ts
```

`blocks push` imports a manifest's `{ url }` (https) or `{ file }` thumbnail into the space's
assets and pushes `{ assetId }`, the only kind the admin draws: images only (AVIF, GIF, JPEG, PNG,
SVG, WebP), at most 2 MiB, and reused by content hash rather than uploaded on every push.

In CI, set `CONTENTWORKER_TOKEN` and `CONTENTWORKER_URL` instead of logging in. Exit codes: 0 ok,
1 failed, 2 usage or confirmation needed (it never prompts off a terminal; pass `--yes`), 3 not
signed in, 4 destructive model or block catalog change refused (`--allow-destructive`).

Every command and option: https://docs.contentworker.app/guides/cli/. Skills that teach a coding
agent to use it: https://docs.contentworker.app/guides/agent-skills/.
