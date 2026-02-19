# Opencode Development Context - DEXBot2

## Branch Strategy
**Pipeline: `test` → `dev` → `main`** (ONE DIRECTION ONLY!)

- **test**: Primary development branch (where work happens)
- **dev**: Integration/staging (merged from test)
- **main**: Production-ready (merged from dev)

⚠️ **KEY RULE**: Always merge **test → dev**, NEVER dev → test
⚠️ **KEY RULE**: See **Absolute Git Action Gate** below for all write-action authorization rules.
⚠️ **KEY RULE**: Default to manual merge/push flow for branch promotion when requested, unless the user specifically asks to use one of the sync scripts.

## Absolute Git Action Gate (User-Directed Writes)

The agent may run git write actions when the user clearly requests them.

Git write actions include:
- `git add`
- `git commit`
- `git commit --amend`
- `git reset` (any mode)
- `git rebase`
- `git merge`
- `git push`
- `git tag`
- `git checkout` / `git switch` to another branch

Branch-promotion scripts include:
- `npm run ptest`
- `npm run pdev`
- `npm run pmain`

Read-only git commands are always allowed (for example: `git status`, `git diff`, `git log`, `git show`).

Interpretation rules:
1. If a user clearly asks for a git write action, execute it.
2. Short approvals like "yes", "ok", "do it", or "go ahead" are valid confirmation when they clearly refer to the immediately previous proposed action.
3. If wording is ambiguous, ask one clarifying question before running destructive actions.
4. `git commit --amend` is allowed when explicitly requested by the user.
5. Before a git write action, restate the user authorization in one short line.

See `docs/WORKFLOW.md` for detailed workflow guide.

## Commit Quality Standard
When creating commits, prefer high-context commit messages for non-trivial fixes/features.

- **Subject**: concise conventional prefix (`fix:`, `feat:`, `docs:`) with clear scope.
- **Body required for substantial changes**: explain **why**, not only what changed.
- **Structure**:
  1. Short problem statement/context
  2. Per-fix sections with file path(s) and behavioral impact
  3. Risk/edge-case notes when relevant
  4. Validation/testing notes (commands or scenario checks)
- **Formatting**: use readable markdown headers/bullets in commit body for scanability.
- **CLI formatting safety**:
  - Never use `/n` or literal `\\n` text as a newline placeholder in commit/PR bodies.
  - Always pass real newlines to Git/GitHub (multi-line body), not escaped newline text.
  - Prefer heredocs for reliability when using `git commit` and `gh pr create`.
- **Atomicity**: keep unrelated edits out of the commit; document only included changes.

Recommended CLI patterns (newline-safe):

```bash
# Commit message with proper markdown/newlines
git commit -F- <<'EOF'
fix: <short summary>

<context>

## <Fix area>
- Problem:
- Impact:
- Solution:

## Testing Notes
- <test command>
EOF

# PR body with proper markdown/newlines
gh pr create --title "<title>" --body-file - <<'EOF'
## Summary
- <item>

## Testing
- <command>
EOF
```

Recommended template:

```text
fix: <short summary>

<1-2 line context>

## <Fix area 1>
File: <path>
- Problem:
- Impact:
- Solution:

## <Fix area 2>
File: <path>
- Problem:
- Impact:
- Solution:

## Testing Notes
- <test/verification>
```

## Current Status
| Branch | Commits Ahead | Status |
|--------|---|--------|
| test | 100 | ✓ Synced with origin/test |
| dev | 100 | ✓ Synced with origin/dev |
| Both | Equal | ✓ Fully synchronized |

## Key Modules
- `dexbot.js` - Entry point
- `modules/dexbot_class.js` - Core bot class
- `modules/order/` - Order management (manager, strategy, grid, accounting, sync_engine)
- `modules/chain_orders.js`, `account_orders.js`, `account_bots.js` - Chain interaction
- `modules/constants.js` - Configuration

## Quick Commands
```bash
# Create feature
git checkout test && git pull
git checkout -b feature/my-feature test

# Merge to test
git checkout test && git pull && git merge --no-ff feature/my-feature && git push

# Integrate to dev
git checkout dev && git pull && git merge --no-ff test && git push

# Release to main
git checkout main && git pull && git merge --no-ff dev && git push
```

## Key Files

### Entry Points
- `dexbot.js` - Main CLI entry point (executable)
- `bot.js` - Alternative bot starter
- `pm2.js` - PM2 process management

### Core Bot
- `modules/dexbot_class.js` - Core bot class and logic (1424 lines)
- `modules/constants.js` - Centralized configuration and tuning parameters

### Order Management (`modules/order/`)
- `manager.js` - Order lifecycle and state management (2852+ lines)
- `grid.js` - Grid calculation, placement, and management
- `strategy.js` - Trading strategy (anchor & refill, consolidation)
- `accounting.js` - Fee accounting and fund tracking
- `sync_engine.js` - Blockchain synchronization
- `startup_reconcile.js` - Startup order reconciliation
- `utils.js` - Utility functions (1254+ lines)
- `index.js` - Module exports
- `logger.js` - Order logging
- `runner.js` - Order execution runner
- `async_lock.js` - Concurrency control

### Blockchain Interaction
- `modules/chain_orders.js` - Blockchain order operations (269+ lines)
- `modules/account_orders.js` - Account order queries (454+ lines)
- `modules/account_bots.js` - Account bot data management (314+ lines)

### Configuration & Examples
- `examples/bots.json` - Bot configuration examples
- `profiles/ecosystem.config.js` - PM2 ecosystem configuration
- `package.json` - Dependencies and npm scripts

### Testing
- `tests/` - Comprehensive test suite including integration tests and ported unit logic:
  - `test_accounting_logic.js` - Ported from accounting.test.js
  - `test_strategy_logic.js` - Ported from strategy.test.js
  - `test_sync_logic.js` - Ported from sync_engine.test.js
  - `test_grid_logic.js` - Ported from grid.test.js
  - `test_manager_logic.js` - Ported from manager.test.js
  - `test_bts_fee_logic.js` - Ported from bts_fee_settlement.test.js
  - Scenario and integration tests (fills, grid, manager, etc.)

## Documentation
- `README.md` - Full documentation
- `docs/WORKFLOW.md` - Branch workflow
- `docs/architecture.md` - System architecture and module relationships
- `docs/developer_guide.md` - Developer quick start and glossary
- `docs/TEST_UPDATES_SUMMARY.md` - Recent test coverage improvements
- `FUND_MOVEMENT_AND_ACCOUNTING.md` - (In docs/) Unified fund accounting and grid mechanics
- `CHANGELOG.md` - Version history
