# dynasty-startup.ps1
# Runs at boot via Task Scheduler (as SYSTEM, Highest privilege)
# Calls start-services.sh in WSL to launch both Node services

$ports = @(3000, 3001)

function Get-WslIp {
    try {
        $ip = (wsl -u tyler -- hostname -I 2>$null)
        if ($ip) { return $ip.Trim().Split(" ")[0] }
    } catch {}
    return $null
}

function Update-PortProxy {
    param($wslIp)
    foreach ($port in $ports) {
        $existing = netsh interface portproxy show v4tov4 | Select-String ":$port "
        if ($existing) {
            netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 | Out-Null
        }
        netsh interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$wslIp | Out-Null
        Write-Host "  Portproxy: 0.0.0.0:$port -> ${wslIp}:$port"
    }
}

function Ensure-Firewall {
    foreach ($port in $ports) {
        $ruleName = "Dynasty Calc $port"
        $exists = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if (-not $exists) {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
            Write-Host "  Firewall rule added for port $port"
        }
    }
}

function Test-Port {
    param($port)
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $port)
        $tcp.Close()
        return $true
    } catch {
        return $false
    }
}

# ── Retry loop ─────────────────────────────────────────────────────────────────
$maxAttempts = 5
$retryDelay  = 30

for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Attempt $attempt of $maxAttempts..."

    $wslIp = Get-WslIp
    if (-not $wslIp) {
        Write-Host "  WSL IP not ready, waiting ${retryDelay}s..."
        $end = (Get-Date).AddSeconds($retryDelay)
        while ((Get-Date) -lt $end) { Start-Sleep -Milliseconds 500 }
        continue
    }

    Write-Host "  WSL IP: $wslIp"
    Update-PortProxy -wslIp $wslIp
    Ensure-Firewall

    # Launch services via dedicated bash script — run as tyler, login shell
    # Start as background job because start-services.sh now blocks (sleep infinity)
    Write-Host "  Launching services..."
    Start-Process -FilePath "wsl.exe" -ArgumentList "-u tyler -- bash -l /home/tyler/dynasty-calc/start-services.sh" -WindowStyle Hidden

    # Wait for ports to bind
    Write-Host "  Waiting for services to bind..."
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }

    $p3000 = Test-Port -port 3000
    $p3001 = Test-Port -port 3001

    if ($p3000 -and $p3001) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Dynasty Calc is live at http://100.85.44.43:3000"
        exit 0
    }

    Write-Host "  Port check: 3000=$p3000, 3001=$p3001. Not ready yet."
    if ($attempt -lt $maxAttempts) {
        Write-Host "  Retrying in ${retryDelay}s..."
        $end = (Get-Date).AddSeconds($retryDelay)
        while ((Get-Date) -lt $end) { Start-Sleep -Milliseconds 500 }
    }
}

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] WARNING: Could not confirm services after $maxAttempts attempts."
