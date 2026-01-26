#!/bin/bash
set -e

# Professional Branch Synchronization Script (Rebase Edition)
# Pipeline: test -> dev -> main
# This script ensures that dev and main are always up-to-date with test.
# It uses 'reset --hard' on integration branches to resolve divergence automatically.

echo "🔄 Starting robust branch synchronization..."

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo "❌ Error: You have uncommitted changes. Please stash or commit them first."
  exit 1
fi

# 1. Fetch all remote changes
echo "🛰️ Fetching from origin..."
git fetch origin

# 2. Synchronize 'test' branch (The Source of Truth)
echo "📍 Syncing 'test' branch..."
git checkout test
# If test has diverged, we try to rebase it on origin/test to keep local work
git rebase origin/test || { echo "❌ Conflict on 'test'. Please resolve manually."; exit 1; }
git push origin test

# 3. Synchronize 'dev' branch
echo "📍 Synchronizing 'dev' with 'test'..."
git checkout dev
# Force local 'dev' to match 'origin/dev' to clear any divergence
git reset --hard origin/dev
# Rebase dev onto test
git rebase test
# Force push to update remote dev
git push -f origin dev

# 4. Synchronize 'main' branch
echo "📍 Synchronizing 'main' with 'dev'..."
git checkout main
# Force local 'main' to match 'origin/main' to clear any divergence
git reset --hard origin/main
# Rebase main onto dev
git rebase dev
# Force push to update remote main
git push -f origin main

# 5. Return to 'test'
git checkout test
echo "✅ Everything is synchronized: test == dev == main"

