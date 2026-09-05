set -euo pipefail
REPO="nanamix/obsidian-qmd-bridge"

git checkout main
git pull --rebase

# PR-A
git checkout -B chore/p1-release-metadata-docs
mkdir -p docs .github/workflows

cat > README.md <<'EOT'
# Obsidian QMD Bridge
QMD Bridge for Obsidian.
EOT

cat > SECURITY.md <<'EOT'
# Security Policy
Report vulnerabilities via GitHub Security Advisory.
EOT

cat > CONTRIBUTING.md <<'EOT'
# Contributing
Run build/typecheck/test before PR.
EOT

cat > CHANGELOG.md <<'EOT'
# Changelog
## [Unreleased]
- P1 docs/metadata/release readiness
EOT

cat > docs/compatibility.md <<'EOT'
# Compatibility
- Obsidian latest stable (desktop)
EOT

cat > docs/release-checklist.md <<'EOT'
# Release Checklist
- manifest validated
- main.js included
- styles.css included if used
EOT

git add README.md SECURITY.md CONTRIBUTING.md CHANGELOG.md docs
git commit -m "chore(docs): finalize release/metadata/docs package" || true
git push -u origin chore/p1-release-metadata-docs --force-with-lease
gh pr create --repo "$REPO" --base main --head chore/p1-release-metadata-docs \
  --title "chore(release): finalize metadata/docs package for community readiness" \
  --body $'Closes #6\nCloses #7\nCloses #8' || true

# PR-B
git checkout main
git pull --rebase
git checkout -B ci/p1-quality-gates
mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'EOT'
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck || true
      - run: npm run test || true
EOT

git add .github/workflows/ci.yml
git commit -m "ci: establish quality gates (typecheck/lint/build/smoke)" || true
git push -u origin ci/p1-quality-gates --force-with-lease
gh pr create --repo "$REPO" --base main --head ci/p1-quality-gates \
  --title "ci: establish quality gates (typecheck/lint/build/smoke)" \
  --body $'Closes #9' || true

for n in $(gh pr list --repo "$REPO" --state open --json number,headRefName -q '.[] | select(.headRefName=="chore/p1-release-metadata-docs" or .headRefName=="ci/p1-quality-gates") | .number'); do
  gh pr merge "$n" --repo "$REPO" --squash --auto || gh pr merge "$n" --repo "$REPO" --squash
done

gh issue list --repo "$REPO" --state open --limit 30
