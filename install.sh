#!/usr/bin/env sh
# install.sh - Install zyrk package manager via npm
# Usage: curl -fsSL https://raw.githubusercontent.com/kingjethro999/zyrk/main/install.sh | sh

set -e

echo "Installing zyrk..."
npm install -g zyrk

echo ""
echo "zyrk installed successfully."
echo "Run 'zyrk --help' to get started."
echo "Global installs via zyrk itself are not supported; use npm directly for global packages."
