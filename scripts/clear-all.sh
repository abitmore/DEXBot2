#!/bin/bash
# Clear persisted order files and log files in one operation.
#
# This combines the behavior of clear-orders.sh and clear-logs.sh while using
# a single confirmation prompt.
# Usage: ./scripts/clear-all.sh or bash scripts/clear-all.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ORDERS_DIR="${PROJECT_ROOT}/profiles/orders"
LOGS_DIR="${PROJECT_ROOT}/profiles/logs"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_info "=========================================="
log_info "DEXBot2 Clear All Script"
log_info "=========================================="
log_info "Orders Directory: $ORDERS_DIR"
log_info "Logs Directory: $LOGS_DIR"
log_info ""
log_warning "WARNING: This will delete all persisted order state files and .log files!"
log_warning "Bots will regenerate their grids on the next run."
log_info ""

# Check directories and count files
ORDER_COUNT=0
LOG_COUNT=0

if [ -d "$ORDERS_DIR" ]; then
    ORDER_COUNT=$(find "$ORDERS_DIR" -type f 2>/dev/null | wc -l)
else
    log_warning "Orders directory does not exist: $ORDERS_DIR"
fi

if [ -d "$LOGS_DIR" ]; then
    LOG_COUNT=$(find "$LOGS_DIR" -type f -name "*.log" 2>/dev/null | wc -l)
else
    log_warning "Logs directory does not exist: $LOGS_DIR"
fi

TOTAL_COUNT=$((ORDER_COUNT + LOG_COUNT))

if [ "$TOTAL_COUNT" -eq 0 ]; then
    log_info "No matching files found to delete."
    exit 0
fi

log_info "Found $ORDER_COUNT order file(s) and $LOG_COUNT log file(s) to delete"
log_info ""

# Show what will be deleted
if [ "$ORDER_COUNT" -gt 0 ]; then
    log_info "Order files to be deleted:"
    find "$ORDERS_DIR" -type f 2>/dev/null | while read -r file; do
        SIZE=$(du -h "$file" | cut -f1)
        echo -e "${BLUE}  -${NC} $(basename "$file") ($SIZE)"
    done
    log_info ""
fi

if [ "$LOG_COUNT" -gt 0 ]; then
    log_info "Log files to be deleted:"
    find "$LOGS_DIR" -type f -name "*.log" 2>/dev/null | while read -r file; do
        SIZE=$(du -h "$file" | cut -f1)
        echo -e "${BLUE}  -${NC} $(basename "$file") ($SIZE)"
    done
    log_info ""
fi

# Ask for confirmation
read -p "Delete all listed order and log files? (y/n): " -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    log_warning "Cancelled"
    exit 0
fi

# Delete files
if [ "$ORDER_COUNT" -gt 0 ]; then
    find "$ORDERS_DIR" -type f 2>/dev/null -delete
fi

if [ "$LOG_COUNT" -gt 0 ]; then
    find "$LOGS_DIR" -type f -name "*.log" 2>/dev/null -delete
fi

# Re-count to confirm
REMAINING_ORDERS=0
REMAINING_LOGS=0

if [ -d "$ORDERS_DIR" ]; then
    REMAINING_ORDERS=$(find "$ORDERS_DIR" -type f 2>/dev/null | wc -l)
fi

if [ -d "$LOGS_DIR" ]; then
    REMAINING_LOGS=$(find "$LOGS_DIR" -type f -name "*.log" 2>/dev/null | wc -l)
fi

log_info "=========================================="
if [ "$REMAINING_ORDERS" -eq 0 ] && [ "$REMAINING_LOGS" -eq 0 ]; then
    log_success "All order and log files cleared!"
    log_info "Total deleted: $TOTAL_COUNT (orders: $ORDER_COUNT, logs: $LOG_COUNT)"
    log_info ""
    log_info "Next steps:"
    log_info "- Bots will regenerate their grids on next run"
    log_info "- Start bots normally: pm2 start all (or specific bot name)"
    log_info "- Monitor startup with: pm2 logs"
else
    log_warning "Cleanup incomplete. Remaining order files: $REMAINING_ORDERS, remaining log files: $REMAINING_LOGS"
fi
log_info "=========================================="

exit 0
