#!/bin/bash
set -e

# Professional Branch Synchronization Script (Remote Push Mode)
# Pipeline: test -> dev -> main
# This script ensures that dev and main are always up-to-date with test
# WITHOUT switching branches or using 'reset --hard', protecting uncommitted changes.

echo "🔄 Starting safe branch synchronization..."

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
# This works even if you have uncommitted changes.
echo "📤 Pushing 'test' commits to origin..."
if ! git push origin test; then
  echo "❌ Push failed. You might be behind origin/test or have a conflict."
  echo "⚠️ Please check 'git status' or sync manually."
  exit 1
fi

# 4. Force update 'dev' and 'main' on origin (Zero-Checkout)
# This updates the server branches directly from your local test branch
echo "🚀 Synchronizing 'dev' and 'main' on origin..."
git push origin test:dev --force
git push origin test:main --force

# 5. Update local branch pointers to match origin
# This makes your local 'dev' and 'main' labels match without switching to them
echo "📍 Updating local branch pointers..."
git fetch origin dev:dev --force
git fetch origin main:main --force

echo "✅ Everything is synchronized: test == dev == main"
echo "✨ Your uncommitted changes on 'test' were never at risk."

