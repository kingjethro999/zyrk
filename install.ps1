# install.ps1 - Install zyrk package manager via npm
# Usage: irm https://raw.githubusercontent.com/kingjethro999/zyrk/main/install.ps1 | iex

Write-Host "Installing zyrk..."
npm install -g zyrk

Write-Host ""
Write-Host "zyrk installed successfully."
Write-Host "Run 'zyrk --help' to get started."
Write-Host "Global installs via zyrk itself are not supported; use npm directly for global packages."
