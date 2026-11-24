#!/usr/bin/env pwsh
# Canonical verification for the repository: every gate, in order, changing no tracked file.
# Needs `uv` and Node.js (see app/.node-version) on PATH. No GPU, model files or
# API keys are required: the app's tests use a fake engine and a fake OpenAI server.
# CI runs this same script (.github/workflows/verify.yml).
#
# Gates that do not apply: there is no separate compile step for Python, and
# secret scanning is left to GitHub push protection.

$ErrorActionPreference = 'Stop'

$buildDir = Join-Path ([System.IO.Path]::GetTempPath()) "chatthree-verify-build-$PID"
# On Windows, PowerShell must call npm's .cmd shims: the .ps1 shims can be
# blocked by the execution policy.
$npm = if ($IsWindows) { 'npm.cmd' } else { 'npm' }
$npx = if ($IsWindows) { 'npx.cmd' } else { 'npx' }

$engineGates = [ordered]@{
    'lockfile matches pyproject' = { uv lock --check }
    'formatting'                 = { uv run --locked ruff format --check . }
    'lint and static analysis'   = { uv run --locked ruff check . }
    'type checking'              = { uv run --locked pyright --warnings }
    'tests'                      = {
        # CI stops at the first failure; local runs report every failure.
        if ($env:CI) { uv run --locked pytest -q --maxfail=1 } else { uv run --locked pytest -q }
    }
    'dependency audit'           = {
        # Exceptions: both advisories are in setuptools' own build and install
        # paths (sdist creation on macOS; legacy wheel installation). The engine
        # never builds or installs with setuptools: it is present only because
        # Chatterbox's watermarker imports pkg_resources at runtime, which the
        # fixed releases (83+) no longer ship. Remove these when resemble-perth
        # stops importing pkg_resources or Chatterbox is replaced.
        uv audit --locked --preview-features audit-command `
            --ignore PYSEC-2026-3447 --ignore GHSA-xmj3-9gf7-h52w
    }
    'package build'              = { uv build --out-dir $buildDir }
}

# The unit and end-to-end runners stop at the first failure in CI and report
# every failure locally; that is set in vitest.config.ts and playwright.config.ts.
$appGates = [ordered]@{
    'dependencies match lockfile' = {
        # `npm ci` fails when package.json and the lockfile disagree. A warning
        # (a deprecated or unsupported package) fails the gate too.
        $output = & $npm ci --no-fund --no-audit 2>&1
        $output | Write-Host
        if ($LASTEXITCODE -eq 0 -and ($output -match 'npm warn')) {
            throw 'npm ci reported warnings'
        }
    }
    'formatting'                  = { & $npm run --silent format:check }
    'lint and static analysis'    = { & $npm run --silent lint }
    'type checking'               = { & $npm run --silent typecheck }
    'unit tests'                  = { & $npm run --silent test }
    'end-to-end test browser'     = { & $npx playwright install chromium --only-shell }
    # The end-to-end tests drive the built UI, so this gate builds it first.
    # The build gate at the end stays, so that a build failure is reported as
    # one and the order of gates matches the engine's.
    'end-to-end tests'            = { & $npm run --silent test:e2e }
    'dependency audit'            = { & $npm audit }
    'build'                       = { & $npm run --silent build }
}

function Invoke-Gates([string] $Project, [System.Collections.IDictionary] $Gates) {
    Push-Location (Join-Path $PSScriptRoot $Project)
    try {
        foreach ($gate in $Gates.GetEnumerator()) {
            Write-Host "== ${Project}: $($gate.Key)" -ForegroundColor Cyan
            & $gate.Value
            if ($LASTEXITCODE -ne 0) { throw "Verification failed at: ${Project}: $($gate.Key)" }
        }
    }
    finally {
        Pop-Location
    }
}

try {
    Invoke-Gates 'engine' $engineGates
    Invoke-Gates 'app' $appGates
    Write-Host 'Verification passed.' -ForegroundColor Green
}
finally {
    Remove-Item -Recurse -Force $buildDir -ErrorAction SilentlyContinue
}
