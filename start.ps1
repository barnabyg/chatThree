#!/usr/bin/env pwsh
# Start chatThree: install what the app needs, build the UI, start the server
# and open the UI in the default browser. Arguments are passed to the server
# (for example `--port 4000` or `--no-open`). Press Ctrl+C to stop.

$ErrorActionPreference = 'Stop'

# On Windows, PowerShell must call npm's .cmd shim: the .ps1 shim can be
# blocked by the execution policy.
$npm = if ($IsWindows) { 'npm.cmd' } else { 'npm' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js was not found. Install Node.js 24.12 or newer from https://nodejs.org and run this again.'
}

Push-Location (Join-Path $PSScriptRoot 'app')
try {
    # Install only when the lockfile is newer than what is installed.
    $lock = Get-Item 'package-lock.json'
    $installed = Get-Item 'node_modules/.package-lock.json' -ErrorAction SilentlyContinue
    if (-not $installed -or $installed.LastWriteTimeUtc -lt $lock.LastWriteTimeUtc) {
        Write-Host 'Installing the app''s dependencies...' -ForegroundColor Cyan
        & $npm ci --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed.' }
    }

    & $npm run --silent build -- --logLevel warn
    if ($LASTEXITCODE -ne 0) { throw 'Building the UI failed.' }

    node src/server/main.ts @args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
