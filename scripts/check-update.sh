#!/bin/bash

##############################################################################
# DEXBot2 Update Status Checker (Cross-platform compatible)
# Verifies if the user is on the latest branch and auto-update worked
# Works on: Linux, macOS, Windows (WSL/Git Bash/MSYS2)
##############################################################################

# Detect OS for better compatibility
OS_TYPE="$(uname -s)"
case "$OS_TYPE" in
    Linux*) PLATFORM="Linux" ;;
    Darwin*) PLATFORM="macOS" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="Windows" ;;
    *) PLATFORM="Unknown" ;;
esac

# Colors for output (using printf for cross-platform compatibility)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Emoji markers
PASS="✓"
FAIL="✗"
INFO="ℹ"
WARN="⚠"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

##############################################################################
# Helper Functions - Cross-platform compatible
##############################################################################

# Portable echo with color support (works on all platforms)
_echo_color() {
    local color=$1
    local text=$2
    printf "%b%s%b\n" "$color" "$text" "$NC"
}

print_header() {
    _echo_color "$BLUE" "╔════════════════════════════════════════════════════════════╗"
    printf "%b║%b %s\n" "$BLUE" "$NC" "$1"
    _echo_color "$BLUE" "╚════════════════════════════════════════════════════════════╝"
}

print_check() {
    local status=$1
    local message=$2
    case "$status" in
        pass)
            printf "%b%s%b %s\n" "$GREEN" "$PASS" "$NC" "$message"
            ;;
        fail)
            printf "%b%s%b %s\n" "$RED" "$FAIL" "$NC" "$message"
            ;;
        warn)
            printf "%b%s%b %s\n" "$YELLOW" "$WARN" "$NC" "$message"
            ;;
        *)
            printf "%b%s%b %s\n" "$BLUE" "$INFO" "$NC" "$message"
            ;;
    esac
}

# Portable sed function (handles both GNU and BSD sed)
_portable_sed() {
    local pattern=$1
    local input=$2

    if [ "$PLATFORM" = "macOS" ]; then
        # BSD sed on macOS requires -E for extended regex
        printf '%s\n' "$input" | sed -E "$pattern"
    else
        # GNU sed on Linux/Windows
        printf '%s\n' "$input" | sed "$pattern"
    fi
}

##############################################################################
# Main Checks
##############################################################################

ISSUES=0

print_header "DEXBot2 Update Status Check"
echo ""

# 1. Check current branch
printf "📍 Branch Status:\n"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
printf "%b%s%b Current branch: %b%s%b\n" "$BLUE" "$INFO" "$NC" "$YELLOW" "$CURRENT_BRANCH" "$NC"

# Verify branch is valid (portable version without [[ ]])
case "$CURRENT_BRANCH" in
    main|dev|test) ;;
    *)
        print_check "warn" "Branch is not one of the main deployment branches (main/dev/test)"
        ISSUES=$((ISSUES + 1))
        ;;
esac
printf "\n"

# 2. Check if up-to-date with remote
printf "🔄 Remote Sync Status:\n"
git fetch origin 2>/dev/null || true

LOCAL_COMMIT=$(git rev-parse HEAD)
REMOTE_COMMIT=$(git rev-parse origin/"$CURRENT_BRANCH" 2>/dev/null || echo "UNKNOWN")

if [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
    print_check "pass" "Local is up-to-date with remote"
else
    print_check "fail" "Local is OUT OF SYNC with remote!"
    printf "  Local:  %b%s%b\n" "$YELLOW" "${LOCAL_COMMIT:0:8}" "$NC"
    printf "  Remote: %b%s%b\n" "$YELLOW" "${REMOTE_COMMIT:0:8}" "$NC"
    ISSUES=$((ISSUES + 1))
fi
printf "\n"

# 3. Check if working directory is clean
printf "📁 Working Directory Status:\n"
if git diff-index --quiet HEAD --; then
    print_check "pass" "Working directory is clean"
else
    print_check "warn" "Working directory has uncommitted changes"
    ISSUES=$((ISSUES + 1))
fi
printf "\n"

# 4. Check critical commits are present
printf "📝 Critical Commits:\n"
CRITICAL_COMMITS=(
    "160fa9a:fix(accounting): Unify BTS fee deduction"
    "94dd4fa:perf(core): Implement Memory-Only integer tracking"
    "b35946a:fix(core): Resolve 'Active No ID' corruption"
)

for commit_info in "${CRITICAL_COMMITS[@]}"; do
    HASH="${commit_info%%:*}"
    DESC="${commit_info#*:}"

    if git log --all --oneline | grep -q "^${HASH}"; then
        print_check "pass" "Found: $DESC"
    else
        print_check "fail" "MISSING: $DESC"
        ISSUES=$((ISSUES + 1))
    fi
done
printf "\n"

# 5. Check branch merge cleanliness (new commits after cleanup)
printf "🧹 Merge History Cleanliness:\n"
EXPECTED_MERGE_COMMITS=2  # f29b4af (main) and 2b4aa98 (dev)
ACTUAL_MERGE_COMMITS=$(git log --all --oneline --grep="Merge branch" | wc -l)

    if [ "$CURRENT_BRANCH" = "main" ]; then
    # Check if cleanup commit (f29b4af) is in history
    BRANCH_MERGES=$(git log --oneline --grep="Merge branch" | grep -c "Clean merge")
    if [ "$BRANCH_MERGES" -gt 0 ]; then
        print_check "pass" "Cleanup commit found in history"
    else
        print_check "warn" "Cleanup commit MISSING from history"
    fi
    elif [ "$CURRENT_BRANCH" = "dev" ]; then
    # Check if cleanup commit (2b4aa98) is in history
    BRANCH_MERGES=$(git log --oneline --grep="Merge branch" | grep -c "Clean merge")
    if [ "$BRANCH_MERGES" -gt 0 ]; then
        print_check "pass" "Cleanup commit found in history"
    else
        print_check "warn" "Cleanup commit MISSING from history"
    fi
else
    print_check "pass" "Test branch (no merge expected)"
fi
printf "\n"

# 6. Check package.json version
printf "📦 Package Status:\n"
if [ -f "package.json" ]; then
    # Portable version parsing (works on all platforms)
    PKG_VERSION=$(grep '"version"' package.json | head -1 | cut -d'"' -f4)
    [ -z "$PKG_VERSION" ] && PKG_VERSION="unknown"
    printf "%b%s%b Package version: %b%s%b\n" "$BLUE" "$INFO" "$NC" "$YELLOW" "$PKG_VERSION" "$NC"
else
    print_check "warn" "package.json not found"
fi
printf "\n"

# 7. Check npm dependencies
printf "🔧 Dependencies:\n"
if [ -d "node_modules" ]; then
    print_check "pass" "Node modules installed"

    # Check if node_modules is up to date
    if ! [ -f "node_modules/.package-lock.json" ]; then
        print_check "warn" "Consider running: npm install"
    fi
else
    print_check "fail" "Node modules NOT installed!"
    printf "  %bRun: npm install%b\n" "$YELLOW" "$NC"
    ISSUES=$((ISSUES + 1))
fi
printf "\n"

# 8. Check git tags (backup tags from cleanup)
printf "🏷️  Cleanup Verification:\n"
BACKUP_TAGS=$(git tag -l | grep "backup/" | wc -l)
if [ "$BACKUP_TAGS" -ge 3 ]; then
    print_check "pass" "Cleanup backup tags present ($BACKUP_TAGS)"
else
    print_check "info" "No cleanup backup tags found (first-time or already cleaned)"
fi
printf "\n"

# 9. Check recent commits
printf "📊 Recent Activity:\n"
LATEST_COMMIT=$(git log -1 --format="%h - %s (%ar)")
printf "%b%s%b Latest commit: %b%s%b\n" "$BLUE" "$INFO" "$NC" "$YELLOW" "$LATEST_COMMIT" "$NC"
printf "\n"

##############################################################################
# Summary
##############################################################################

if [ $ISSUES -eq 0 ]; then
    _echo_color "$GREEN" "╔════════════════════════════════════════════════════════════╗"
    printf "%b║%b ✓ All checks passed! You are up-to-date.                 %b║%b\n" "$GREEN" "$NC" "$GREEN" "$NC"
    _echo_color "$GREEN" "╚════════════════════════════════════════════════════════════╝"
    exit 0
else
    _echo_color "$YELLOW" "╔════════════════════════════════════════════════════════════╗"
    printf "%b║%b ⚠ Found %d issue(s). Please review above.           %b║%b\n" "$YELLOW" "$NC" "$ISSUES" "$YELLOW" "$NC"
    _echo_color "$YELLOW" "╚════════════════════════════════════════════════════════════╝"

    if git diff-index --quiet HEAD -- 2>/dev/null; then
        printf "\n"
        printf "💡 Quick fixes:\n"
        printf "  • Pull latest: %bgit pull origin %s%b\n" "$BLUE" "$CURRENT_BRANCH" "$NC"
        printf "  • Check status: %bgit status%b\n" "$BLUE" "$NC"
        printf "  • Install deps: %bnpm install%b\n" "$BLUE" "$NC"
    fi

    exit 1
fi
