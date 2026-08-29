<#
.SYNOPSIS
    Stops and removes the n8n Docker Compose service (data volume is preserved).
.DESCRIPTION
    Wraps `docker compose -f docker-compose.n8n.yml down`. The named volume `n8n_data`
    is NOT removed by this script, so workflows/credentials survive a down/up cycle.
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    docker compose -f docker-compose.n8n.yml down
}
finally {
    Pop-Location
}
