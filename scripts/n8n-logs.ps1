<#
.SYNOPSIS
    Tails logs from the running n8n container.
.DESCRIPTION
    Wraps `docker compose -f docker-compose.n8n.yml logs -f`.
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    docker compose -f docker-compose.n8n.yml logs -f
}
finally {
    Pop-Location
}
