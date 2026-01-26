#!/bin/bash
set -e

echo "🔄 Starting rebase-based branch synchronization..."

git fetch origin

# Update test branch
echo "📍 Updating test branch..."
git checkout test
git pull origin test

# Rebase dev on test
echo "📍 Rebasing dev on test..."
git checkout dev
git pull origin dev
if ! git rebase test; then
  echo "❌ Dev rebase failed. Fix conflicts manually and retry."
  exit 1
fi
git push -f origin dev

# Rebase main on dev to bring it up to date
echo "📍 Rebasing main on dev..."
git checkout main
git pull origin main
if ! git rebase dev; then
  echo "❌ Main rebase failed. Fix conflicts manually and retry."
  exit 1
fi
git push -f origin main

git checkout test
echo "✅ Branch synchronization complete!"
