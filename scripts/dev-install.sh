#!/bin/bash

##############################################################################
# DEXBot2 Development Environment Setup
#
# This script prepares the environment for contributors.
# Testing is now NATIVE to Node.js (no heavy dependencies like Jest).
#
# Usage:
#   ./scripts/dev-install.sh
##############################################################################

set -e  # Exit on any error

echo "=========================================="
echo "DEXBot2 - Development Environment"
echo "=========================================="
echo ""
echo "This project uses NATIVE Node.js assert for testing."
echo "No extra development dependencies (like Jest) are required."
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "ERROR: npm is not installed. Please install Node.js and npm first."
    echo "Visit: https://nodejs.org/"
    exit 1
fi

echo "Current Node.js version: $(node --version)"
echo "Current npm version: $(npm --version)"
echo ""

echo "Installing production dependencies..."
npm install

echo ""
echo "=========================================="
echo "✓ Environment ready!"
echo "=========================================="
echo ""
echo "You can now run:"
echo "  npm test             - Run all native logic and integration tests"
echo "  node tests/test_*.js - Run a specific test file directly"
echo ""
