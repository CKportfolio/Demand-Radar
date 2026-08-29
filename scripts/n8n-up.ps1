<#
.SYNOPSIS
    Starts the n8n Docker Compose service for Market Demand Radar.
.DESCRIPTION
    Wraps `docker compose -f docker-compose.n8n.yml up -d`. Requires Docker Desktop to be
    running. No env file is required — docker-compose.n8n.yml needs zero secrets to start.
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    docker compose -f docker-compose.n8n.yml up -d

    Write-Host ""
    Write-Host "n8n is starting. Open http://127.0.0.1:5678 once it's ready."
    Write-Host "Check status/logs with: scripts\n8n-logs.ps1"
}
finally {
    Pop-Location
}
