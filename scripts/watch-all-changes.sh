#!/bin/bash
# Watch all changes: uncommitted, committed, and pushed - fzf with clear navigation

# Check and install required packages
check_dependencies() {
    local missing_packages=()

    # Check for delta
    if ! command -v delta &> /dev/null; then
        missing_packages+=("git-delta")
    fi

    # Check for fzf
    if ! command -v fzf &> /dev/null; then
        missing_packages+=("fzf")
    fi

    # Check for batcat (bat on Ubuntu)
    if ! command -v batcat &> /dev/null && ! command -v bat &> /dev/null; then
        missing_packages+=("bat")
    fi

    # Install missing packages
    if [ ${#missing_packages[@]} -gt 0 ]; then
        echo "Installing missing dependencies: ${missing_packages[@]}"
        sudo apt-get update -qq
        sudo apt-get install -y -qq "${missing_packages[@]}"
        echo "Dependencies installed successfully!"
        sleep 1
    fi
}

check_dependencies

clear_screen() {
    printf "\033[2J\033[H"
}

cleanup() {
    clear_screen
    # Reset terminal to normal mode
    stty sane 2>/dev/null || true
    echo "Exiting..."
    exit 0
}

# Handle Ctrl+C gracefully
trap cleanup INT TERM

show_menu() {
    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo "CONTROLS:"
    echo "  [1] View all changes       [2] Search uncommitted"
    echo "  [3] Search committed       [4] Search pushed"
    echo "  [q] Quit"
    echo "═══════════════════════════════════════════════════════"
}

show_all_changes() {
    clear_screen
    echo "=== Complete Git Changes Monitor ==="
    echo "Last update: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "=================================================="
    echo ""

    current_branch=$(git rev-parse --abbrev-ref HEAD)
    remote_branch="origin/$current_branch"
    echo "Current branch: $current_branch | Remote: $remote_branch"
    echo ""

    echo "========== 1. UNCOMMITTED (All changes not yet committed) =========="
    echo "--- Staged changes ---"
    git diff --staged | delta || echo "No staged changes"
    echo ""
    echo "--- Unstaged changes ---"
    git diff | delta || echo "No unstaged changes"
    echo ""
    echo "--- Untracked files ---"
    git ls-files --others --exclude-standard || echo "No untracked files"

    echo ""
    echo "========== 2. COMMITTED (Local commits not yet pushed) =========="
    echo "Commits:"
    git log origin/$(git rev-parse --abbrev-ref HEAD)..HEAD --oneline 2>/dev/null || echo "No committed unpushed changes"
    echo ""
    echo "Diff:"
    git diff origin/$(git rev-parse --abbrev-ref HEAD)..HEAD 2>/dev/null | delta || echo "No diff in unpushed commits"

    echo ""
    echo "========== 3. PUSHED (On remote branch) =========="
    echo "Latest pushed commits:"
    git log origin/$(git rev-parse --abbrev-ref HEAD) --oneline -10 2>/dev/null || echo "Remote branch not found"

    show_menu
}

search_uncommitted() {
    clear_screen
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║  SEARCH MODE - Type to filter files"
    echo "║  UP/DOWN arrows select | ENTER opens file | ESC back"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo ""

    staged=$(git diff --staged --name-only)
    unstaged=$(git diff --name-only)
    untracked=$(git ls-files --others --exclude-standard)
    files=$(echo -e "$staged\n$unstaged\n$untracked" | grep -v "^$" | sort -u)

    if [ -z "$files" ]; then
        echo "No uncommitted files"
        sleep 2
        show_all_changes
        return
    fi

    while true; do
        selected=$(echo "$files" | fzf --ansi --preview 'batcat --color=always --line-range :100 {} 2>/dev/null || head -100 {}' --preview-window=right:67% --bind 'esc:abort')

        if [ -z "$selected" ]; then
            # ESC pressed, go back to main menu
            show_all_changes
            return
        fi

        if [ -n "$selected" ]; then
            view_mode="full"
            while true; do
                clear_screen
                echo "╔═══════════════════════════════════════════════════════╗"
                echo "║  VIEWING: $selected"
                echo "║  Display: $([ "$view_mode" = "diff" ] && echo "DIFF ONLY" || echo "FULL FILE")"
                echo "╚═══════════════════════════════════════════════════════╝"
                echo ""
                echo "⚠️  DO NOT TYPE - Use SINGLE KEYS only:"
                echo "   [f]=Full  [d]=Diff  [q]=Back to search  [b]=Main menu"
                echo ""
                echo "────────────────────────────────────────────────────────"
                echo ""

                if [ "$view_mode" = "diff" ]; then
                    if git ls-files --error-unmatch "$selected" 2>/dev/null; then
                        git diff --color=always "$selected" 2>/dev/null | delta || echo "No changes in this file"
                    else
                        echo "File is untracked (new file) - no diff to show"
                    fi
                else
                    batcat --color=always "$selected" 2>/dev/null || cat "$selected"
                fi

                echo ""
                echo "════════════════════════════════════════════════════════"
                read -n 1 -s key

                case $key in
                    f) view_mode="full" ;;
                    d) view_mode="diff" ;;
                    q) break ;;
                    b) show_all_changes; return ;;
                esac
            done
        fi
    done
}

search_committed() {
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    remote_branch="origin/$current_branch"

    clear_screen
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║  SEARCH COMMITTED (UNPUSHED)                          ║"
    echo "║  Use arrows to navigate | Enter to view full | Esc to back"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo ""

    commits=$(git log $remote_branch..HEAD --oneline 2>/dev/null)

    if [ -z "$commits" ]; then
        echo "No unpushed commits"
        sleep 2
        show_all_changes
        return
    fi

    while true; do
        selected=$(echo "$commits" | fzf --ansi --preview 'commit_hash=$(echo {} | awk "{print \$1}"); git show --color=always $commit_hash | head -100' --preview-window=right:67% --bind 'esc:abort')

        if [ -z "$selected" ]; then
            show_all_changes
            return
        fi

        if [ -n "$selected" ]; then
            commit_hash=$(echo "$selected" | awk '{print $1}')

            clear_screen
            echo "╔═══════════════════════════════════════════════════════╗"
            echo "║  COMMIT: $commit_hash"
            echo "║  Press [q] to go back, [b] to back to main menu"
            echo "╚═══════════════════════════════════════════════════════╝"
            echo ""
            git show --color=always "$commit_hash" | delta

            echo ""
            echo "════════════════════════════════════════════════════════"
            read -n 1 -p "Press [q] to search again, [b] for main menu: " key

            if [ "$key" = "b" ]; then
                show_all_changes
                return
            fi
        fi
    done
}

search_pushed() {
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    remote_branch="origin/$current_branch"

    clear_screen
    echo "╔═══════════════════════════════════════════════════════╗"
    echo "║  SEARCH PUSHED COMMITS (Latest 100)                   ║"
    echo "║  Use arrows to navigate | Enter to view full | Esc to back"
    echo "╚═══════════════════════════════════════════════════════╝"
    echo ""

    commits=$(git log $remote_branch --oneline -100 2>/dev/null)

    if [ -z "$commits" ]; then
        echo "No pushed commits found"
        sleep 2
        show_all_changes
        return
    fi

    while true; do
        selected=$(echo "$commits" | fzf --ansi --preview 'commit_hash=$(echo {} | awk "{print \$1}"); git show --color=always $commit_hash | head -100' --preview-window=right:67% --bind 'esc:abort')

        if [ -z "$selected" ]; then
            show_all_changes
            return
        fi

        if [ -n "$selected" ]; then
            commit_hash=$(echo "$selected" | awk '{print $1}')

            clear_screen
            echo "╔═══════════════════════════════════════════════════════╗"
            echo "║  PUSHED COMMIT: $commit_hash"
            echo "║  Press [q] to go back, [b] to back to main menu"
            echo "╚═══════════════════════════════════════════════════════╝"
            echo ""
            git show --color=always "$commit_hash" | delta

            echo ""
            echo "════════════════════════════════════════════════════════"
            read -n 1 -p "Press [q] to search again, [b] for main menu: " key

            if [ "$key" = "b" ]; then
                show_all_changes
                return
            fi
        fi
    done
}

# Cache for detecting changes
get_local_state() {
    local state=""
    state+="$(git diff --staged --stat 2>/dev/null)|||"
    state+="$(git diff --stat 2>/dev/null)|||"
    state+="$(git ls-files --others --exclude-standard 2>/dev/null)"
    echo "$state"
}

get_remote_state() {
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    remote_branch="origin/$current_branch"

    local state=""
    state+="$(git log $remote_branch..HEAD --oneline 2>/dev/null)|||"
    state+="$(git log $remote_branch --oneline -10 2>/dev/null)"
    echo "$state"
}

# Initial display
show_all_changes

# Initialize state caches and timers AFTER first display
previous_local_state=$(get_local_state)
previous_remote_state=$(get_remote_state)
last_update_time=$(date +%s)
last_remote_update_time=$(date +%s)

# Auto-refresh loop - only update display on actual changes
while true; do
    current_time=$(date +%s)

    # Check for keypress (non-blocking, 1 second timeout)
    read -t 1 -n 1 action

    if [ $? -eq 0 ]; then
        # Key was pressed
        case $action in
            1) show_all_changes ;;
            2) search_uncommitted ;;
            3) search_committed ;;
            4) search_pushed ;;
            q) cleanup ;;
        esac
    else
        # No key pressed, check for changes
        local_state=$(get_local_state)

        # Check local changes every 1 second
        if [ $((current_time - last_update_time)) -ge 1 ]; then
            if [ "$local_state" != "$previous_local_state" ]; then
                show_all_changes
                previous_local_state="$local_state"
            fi
            last_update_time=$current_time
        fi

        # Check remote changes every 15 seconds
        if [ $((current_time - last_remote_update_time)) -ge 15 ]; then
            remote_state=$(get_remote_state)
            if [ "$remote_state" != "$previous_remote_state" ]; then
                show_all_changes
                previous_remote_state="$remote_state"
            fi
            last_remote_update_time=$current_time
        fi
    fi
done
