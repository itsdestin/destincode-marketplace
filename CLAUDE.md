# CLAUDE.md

wecoded-marketplace is the YouCoded skill-marketplace registry plus the Cloudflare Worker backend (`worker/`). The Worker **auto-deploys on push to master** via `.github/workflows/worker-deploy.yml` — never run `wrangler deploy` manually; ship changes by merging a PR to master.

## Workspace conventions (read this if you opened this repo standalone)

This repo is one component of the YouCoded product. Development is coordinated from the **youcoded-dev workspace repo**: https://github.com/itsdestin/youcoded-dev — if it isn't on this machine, clone it and run `bash setup.sh` (it clones every sub-repo and carries the working rules, path-scoped rules, and cross-repo docs).

- **Lifecycle documents** (specs, plans, handoffs, investigations) do NOT live in this repo — they go to the workspace: `youcoded-dev/docs/active/` (in flight) → `youcoded-dev/docs/archive/` (done). This repo's `docs/` holds living reference only (`worker-backend.md`, `mcp-authoring.md`).
- **Planning** happens in the workspace `ROADMAP.md` — one roadmap for the whole product.
- Worker/analytics invariants live in the workspace rule `youcoded-dev/.claude/rules/worker-backend.md`; registry/MCP-authoring invariants in `youcoded-dev/.claude/rules/registries.md`.
