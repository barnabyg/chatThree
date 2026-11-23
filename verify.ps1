#!/usr/bin/env pwsh
# Canonical verification for the repository: every gate, in order, changing no tracked file.
# Needs only `uv` on PATH. No GPU or model files are required.
#
# Gates that do not apply: there is no separate compile step for Python, and
# secret scanning is left to GitHub push protection.

$ErrorActionPreference = 'Stop'

$buildDir = Join-Path ([System.IO.Path]::GetTempPath()) "chatthree-verify-build-$PID"
$gates = [ordered]@{
    'lockfile matches pyproject' = { uv lock --check }
    'formatting'                 = { uv run --locked ruff format --check . }
    'lint and static analysis'   = { uv run --locked ruff check . }
    'type checking'              = { uv run --locked pyright --warnings }
    'tests'                      = {
        # CI stops at the first failure; local runs report every failure.
        if ($env:CI) { uv run --locked pytest -q --maxfail=1 } else { uv run --locked pytest -q }
    }
    'dependency audit'           = { uv audit --locked --preview-features audit-command }
    'package build'              = { uv build --out-dir $buildDir }
}

Push-Location (Join-Path $PSScriptRoot 'engine')
try {
    foreach ($gate in $gates.GetEnumerator()) {
        Write-Host "== $($gate.Key)" -ForegroundColor Cyan
        & $gate.Value
        if ($LASTEXITCODE -ne 0) { throw "Verification failed at: $($gate.Key)" }
    }
    Write-Host 'Verification passed.' -ForegroundColor Green
}
finally {
    Pop-Location
    Remove-Item -Recurse -Force $buildDir -ErrorAction SilentlyContinue
}
