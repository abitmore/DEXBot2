#!/bin/bash
set -e

# Professional Branch Synchronization Script (test -> dev)
# This script ensures that dev is always up-to-date with test
# WITHOUT switching branches or using 'reset --hard', protecting uncommitted changes.

echo "🔄 Starting safe branch synchronization (test -> dev)..."

# 1. Ensure we are on 'test'
CURRENT=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT" != "test" ]; then
  echo "📍 Switching to 'test' branch..."
  git checkout test
fi

# 2. Sync 'test' with origin
echo "🛰️ Fetching from origin..."
git fetch origin test

# 3. Push local 'test' commits to origin
echo "📤 Pushing 'test' commits to origin..."
if ! git push origin test; then
  echo "❌ Push failed. You might be behind origin/test or have a conflict."
  echo "⚠️ Please check 'git status' or sync manually."
  exit 1
fi

# 4. Force update 'dev' on origin (Zero-Checkout)
echo "🚀 Synchronizing 'dev' with 'test' on origin..."
git push origin test:dev --force

# 5. Update local 'dev' branch pointer to match origin
echo "📍 Updating local 'dev' branch pointer..."
git fetch origin dev:dev --force

echo "✅ Synchronization complete: test == dev"
echo "✨ Your uncommitted changes on 'test' were never at risk."
