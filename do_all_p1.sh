#!/usr/bin/env bash
set -euo pipefail

REPO="nanamix/obsidian-qmd-bridge"

# 0) precheck
gh auth status >/dev/null
git rev-parse --is-inside-work-tree >/dev/null

########################################
# PR-A: #6 #7 #8 (release/metadata/docs)
########################################
git checkout main
git pull --rebase
git checkout -b chore/p1-release-metadata-docs

mkdir -p docs

# README.md
cat > README.md <<'EOF'
# Obsidian QMD Bridge

QMD Bridge for Obsidian.  
Run QMD search/index commands from Obsidian and open matched notes directly.

## Features
- Open QMD Search panel in sidebar
- Run `qmd update` and `qmd embed` from commands
- View QMD status and collections
- Collection path mapping for opening files in vault

## Installation
1. Build release assets (`main.js`, `manifest.json`, optional `styles.css`)
2. Copy to `<vault>/.obsidian/plugins/obsidian-qmd-bridge/`
3. Enable plugin in Obsidian Community Plugins

## Configuration
- qmd executable absolute path
- default search type / result count / collection
- collection path mapping

## Security Notes
- Path traversal and out-of-bound path handling are blocked
- Input validation is applied for collection/path-related values

## Compatibility
- See `docs/compatibility.md`

## Development
```bash
npm install
npm run build
npm run typecheck
npm run test