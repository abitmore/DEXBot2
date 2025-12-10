# DEXBot2 v0.1.2 - Multi-Bot Fund Allocation & Update Script

**Release Date:** 2025-12-10
**Tag:** `v0.1.2`
**Git Commits:** 5a1c967 (botFunds allocation), 04e3834 (update script)

## What Changed

### Feature: Multi-Bot Fund Allocation

When multiple bots share the same account with percentage-based botFunds allocations (e.g., Bot1: 90%, Bot2: 10%), each bot now correctly respects its allocated percentage of what's actually free on-chain.

**Problem Solved:**
- Previously, Bot2 would calculate 10% of the **total account balance** instead of 10% of the **free balance** after Bot1 committed funds
- This led to both bots claiming more funds than actually available
- Example: Bot1 takes 900 BTS of 1000 total, Bot2 still calculated 10% of 1000 (100 BTS) instead of 10% of 100 (10 BTS)

**Solution:**
- New method `applyBotFundsAllocation()` in OrderManager
- Called at grid initialization with actual on-chain free balances
- Each bot caps its available funds to its allocated percentage of chainFree
- During trading, funds are recalculated normally without constraint

**Impact:**
- Multiple bots can now share an account without fund allocation conflicts
- Each bot respects its percentage of what's actually available
- Better suited for production multi-bot deployments

### Improvement: Update Script

**Removed merge prompts:**
- Changed `git pull` to `git pull --rebase` in update.sh
- No more interactive commit message prompts
- Cleaner, automatic updates

**Fixed script permissions:**
- Made update.sh permanently executable via git config
- Survives clone/pull without needing chmod again

## Installation

### Option 1: Fresh Installation

```bash
git clone https://github.com/froooze/DEXBot2.git
cd DEXBot2
git checkout v0.1.2
npm install
npm run bootstrap:profiles
node dexbot.js keys
node dexbot.js bots
npm run pm2:unlock-start
```

### Option 2: Upgrade from v0.1.1

```bash
cd ~/DEXBot2
./scripts/update.sh
```

The script will automatically:
- Pull v0.1.2 changes (no merge prompts)
- Install dependencies
- Reload PM2 if running

## What's New in v0.1.2

- ✅ Multi-bot fund allocation for shared accounts
- ✅ Automatic merge prompt removal in update script
- ✅ Permanent executable permissions on update.sh
- ✅ Better handling of percentage-based botFunds with multiple bots

## Features from Earlier Versions (Still Included)

**v0.1.1:**
- Minimum delta enforcement for price-only order updates
- Automatic order adjustment toward market center
- Reduced wasted blockchain transactions

**v0.1.0:**
- Staggered order grids with geometric spacing
- Dynamic rebalancing after fills
- Multi-bot support on different trading pairs
- PM2 process management with auto-restart
- Partial order atomic moves
- Fill deduplication (5-second window)
- Master password security (encrypted storage, RAM-only)
- Price tolerance for blockchain rounding compensation
- Multi-API support with graceful fallbacks
- Dry-run mode for safe simulation

## Testing Multi-Bot Setup

Test with two bots sharing an account:

**bots.json example:**
```json
{
  "bots": [
    {
      "name": "Bot1",
      "dryRun": true,
      "botFunds": { "buy": "90%", "sell": "100%" }
    },
    {
      "name": "Bot2",
      "dryRun": true,
      "botFunds": { "buy": "10%", "sell": "100%" }
    }
  ]
}
```

**Expected behavior:**
- Bot1 starts: allocates 90% of chainFree
- Bot2 starts: allocates 10% of remaining chainFree
- No fund conflicts

## Quick Commands

```bash
# Update to latest (no prompts)
./scripts/update.sh

# View logs in real-time
pm2 logs <bot-name>

# Stop/restart
pm2 stop <bot-name>
pm2 restart <bot-name>

# Check status
pm2 status
```

## Documentation

- **README.md** - Complete feature overview and configuration guide
- **CHANGELOG.md** - Full version history
- **modules/** - Source code with inline documentation
- **tests/** - 25+ test files covering all functionality

## Support & Issues

- GitHub Issues: https://github.com/froooze/DEXBot2/issues
- Discussions: https://github.com/froooze/DEXBot2/discussions

## Security Notes

- Master password: encrypted, RAM-only
- Private keys: never written to disk
- Always use PM2 for production (handles crashes + restarts)
- Test with `dryRun: true` before enabling live trading
- Keep `profiles/` directory excluded from version control

## Known Issues

None at this time.

## Release Checklist

- ✅ Multi-bot fund allocation implemented
- ✅ Update script improved (no merge prompts)
- ✅ CHANGELOG.md updated
- ✅ Git commits pushed
- ✅ v0.1.2 tag created
- ✅ GitHub release published
- ✅ Documentation current
- ✅ No uncommitted changes
