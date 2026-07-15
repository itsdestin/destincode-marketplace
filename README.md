# YouCoded Marketplace

The skill store for [YouCoded](https://github.com/itsdestin/youcoded). Browse and install skills from within the app.

Contains 174 entries: 26 YouCoded-specific skills and 148 imported from Anthropic's official Claude Code plugin registry.

## How It Works

- The YouCoded app fetches `index.json` to populate the skill marketplace
- `curated-defaults.json` determines which skills appear pre-selected for new users
- `featured.json` drives the featured section at the top of the marketplace
- `stats.json` provides usage counts (rebuilt daily by CI)
- Plugin installation is handled by the app — not this repo

## Structure

```
index.json                 # All registry entries (174 entries)
marketplace.json           # YouCoded/community entries (source for the sync)
curated-defaults.json      # Default skills for new users
featured.json              # Featured skill highlights
stats.json                 # Usage stats (rebuilt by CI)
overrides/                 # Per-plugin custom metadata
scripts/
  sync.js                  # Imports plugins from upstream Anthropic registries
```

## Upstream Sync

```bash
node scripts/sync.js                                    # Sync from GitHub
node scripts/sync.js --local <path-to-marketplace-clone> # Sync from local clone
```

Preserves all YouCoded entries, imports upstream alphabetically, applies `overrides/<id>.json` patches.

## Adding a Skill

1. Add your plugin as a directory in this repo and register it in `marketplace.json`
2. Open a pull request — CI validates it and rebuilds `index.json`

Or create a skill inside YouCoded and share it via the app's share feature.

## Registry Entry Format

```json
{
  "id": "skill-id",
  "type": "prompt | plugin",
  "displayName": "Human-Readable Name",
  "description": "One-line description",
  "category": "personal | work | development | ...",
  "author": "@handle",
  "sourceMarketplace": "youcoded | anthropic",
  "sourceType": "prompt | local | url | git-subdir",
  "tags": []
}
```
