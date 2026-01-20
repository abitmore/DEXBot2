#!/bin/bash

##############################################################################
# DEXBot2 Bash Aliases Setup
# Add convenient aliases for common commands
##############################################################################

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "📝 Adding DEXBot2 aliases to your shell..."
echo ""

# Create a sourcing snippet
ALIAS_FILE="$REPO_ROOT/.dexbot-aliases"

cat > "$ALIAS_FILE" << 'EOF'
# DEXBot2 Convenient Aliases
# Source this file in your ~/.bashrc or ~/.zshrc

# Check if we're in the DEXBot repo
_is_dexbot_repo() {
    [ -f "$(dirname "${BASH_SOURCE[0]}")/../dexbot.js" ] 2>/dev/null && return 0
    return 1
}

# Update status check
alias dexcheck='$( cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd )/scripts/check-update.sh'

# Quick status
alias dexstatus='git status'

# Pull latest from current branch
alias dexpull='git pull origin $(git rev-parse --abbrev-ref HEAD)'

# Show recent commits
alias dexlog='git log --oneline --decorate -15'

# Show update logs
alias dexupdate-log='git log --oneline --grep="Merge\|fix\|perf" -20'

EOF

echo "✓ Created aliases file: $ALIAS_FILE"
echo ""
echo "To use these aliases, add this line to your shell config:"
echo ""
echo "  For ~/.bashrc (Linux/Git Bash):"
echo "  source $ALIAS_FILE"
echo ""
echo "  For ~/.zshrc (macOS zsh):"
echo "  source $ALIAS_FILE"
echo ""
echo "Available commands:"
echo "  dexcheck        - Run update status check"
echo "  dexstatus       - Show git status"
echo "  dexpull         - Pull from current branch"
echo "  dexlog          - Show recent commits"
echo "  dexupdate-log   - Show recent updates/fixes"
echo ""
