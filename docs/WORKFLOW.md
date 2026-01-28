# Branch Workflow: test → dev → main

This document describes the branch strategy for DEXBot2 development.

## Branch Hierarchy

```
feature branches
       ↓
    test (testing/staging branch)
       ↓
    dev (active development integration)
       ↓
    main (stable/production releases)
```

## Branch Purposes

- **test**: Staging branch for feature testing before integration
- **dev**: Active development branch where features are integrated
- **main**: Stable, production-ready branch
- **feature/\***: Feature branches for specific features/fixes

## Workflow

### 1. Creating a Feature

```bash
# Start from test (latest testing branch)
git checkout test
git pull origin test

# Create feature branch
git checkout -b feature/my-feature test
```

### 2. Working on a Feature

```bash
# Make your changes, commit as normal
git add .
git commit -m "feat: describe your feature"

# Push to remote when ready for review
git push -u origin feature/my-feature
```

### 3. Testing & Integration

```bash
# When ready for testing, create PR: feature/my-feature → test
# After review and testing passes:
git checkout test
git pull origin test
git merge --no-ff feature/my-feature
git push origin test

# Delete feature branch after merging
git branch -D feature/my-feature
git push origin --delete feature/my-feature
```

### 4. Merging to Dev

```bash
# After test branch is validated and tested
git checkout dev
git pull origin dev
git merge --no-ff test
git push origin dev
```

### 5. Releasing to Main

```bash
# When code is stable and ready for production
git checkout main
git pull origin main
git merge --no-ff dev
git push origin main

# Tag releases
git tag -a v0.X.Y -m "Release version 0.X.Y"
git push origin v0.X.Y
```

## Current Branch Status

| Branch | Commits Ahead | Remote Sync |
|--------|---|--------|
| test | 100 | ✓ Synced with origin/test |
| dev | 100 | ✓ Synced with origin/dev |
| main | - | Separate release channel |

**Status**: All branches synchronized and ready for development (Jan 10, 2026).

## Key Rules

### ✅ DO:
- Always pull before creating a feature branch
- Use `--no-ff` flag for merge commits to maintain history
- Work on **test** branch (primary development)
- Push **test** to origin/test
- Merge **test INTO dev** when stable
- Push **dev** after merging from test
- Keep dev and main clean (no direct commits)
- Use feature branches for larger features
- Code review should happen on feature → test PRs
- Integration testing happens on test branch
- Only merge to dev after test validation
- Only merge to main for releases

### ❌ DON'T:
- Never merge dev → test (wrong direction!)
- Never force push to test, dev, or main
- Never commit directly to dev or main
- Never push dev without merging from test first
- Never forget to pull before merging

## Verification & Synchronization

### Check Branch Status
```bash
# View all branches with tracking
git branch -vv

# Count commits ahead of main
echo "test:" && git log --oneline main..test | wc -l
echo "dev:" && git log --oneline main..dev | wc -l

# Both should show the same number (currently 100)
```

### Sync test with dev
```bash
# If test is behind dev, pull dev's changes
git checkout test
git pull origin test
git merge dev  # Only if absolutely necessary to sync

# Verify sync
git log --oneline main..test | wc -l
git log --oneline main..dev | wc -l
```

### Daily Workflow Summary
```bash
# Morning: Start on test
git checkout test
git pull origin test

# During day: Make changes
git add .
git commit -m "feat: description"
git push origin test

# When ready to integrate
git checkout dev
git pull origin dev
git merge --no-ff test
git push origin dev

# Back to test for next cycle
git checkout test
git pull origin test
```

## NPM Scripts for Branch Synchronization

The following npm scripts provide safe, automated branch synchronization:

```bash
# Sync local test to origin/test (safe, no branch switching)
npm run ptest

# Sync test to dev with safe remote push
npm run pdev

# Promote dev to main (full release)
npm run pmain
```

### Script Details

| Script | Purpose | What It Does | When to Use |
|--------|---------|-------------|-----------|
| `npm run ptest` | Safe test sync | Pushes local test commits to origin/test without switching branches | Daily development; ensures origin/test is up-to-date |
| `npm run pdev` | Integrate to dev | Merges test → dev with safe remote push | When test is stable and ready for staging |
| `npm run pmain` | Release to main | Promotes dev → main with validation and tagging | For official releases only |

## Commands Summary

```bash
# Setup - Start on test (primary branch)
git checkout test
git pull origin test

# Feature work - Use feature branches for organized work
git checkout -b feature/xyz test
# ... make changes ...
git push -u origin feature/xyz
# ... create PR for review ...

# Merge to test - Integrate feature into primary branch
git checkout test && git pull && git merge --no-ff feature/xyz && git push origin test

# Quick: Sync test to origin/test (no branch switch)
npm run ptest

# Sync test to dev - Promote tested code to staging
npm run pdev

# Merge dev to main (releases only) - Promote to production
npm run pmain
```

## Troubleshooting

### If you accidentally merged dev into test:
```bash
# Undo the merge on test
git checkout test
git reset --hard HEAD~1

# Verify
git log --oneline -5

# Push to fix remote
git push origin test --force-with-lease
```

### If test is missing commits from dev:
```bash
# This shouldn't happen in normal workflow
# But if it does, identify and cherry-pick missing commits
git checkout test
git log --oneline main..dev  # See what dev has
git log --oneline main..test # See what test has

# Cherry-pick missing commits
git cherry-pick <commit-hash>
git push origin test
```

### If you committed directly to dev (should not happen):
```bash
# Revert from dev
git checkout dev
git revert <commit-hash>
git push origin dev

# Cherry-pick to test if needed
git checkout test
git cherry-pick <commit-hash>
git push origin test

# Fix dev via merge
git checkout dev
git merge test
git push origin dev
```
