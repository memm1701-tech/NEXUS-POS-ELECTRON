# NEXUS POS - Script de Diagnostico de Red
# Ejecutar en CUALQUIER PC del sistema
# Uso: PowerShell -> .\diagnostico-red.ps1

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  NEXUS POS - Diagnostico de Red" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# 1. Leer config.json
$configPath = "$env:APPDATA\nexus-pos\data\config.json"
$config = $null

if (Test-Path $configPath) {
    $config = Get-Content $configPath | ConvertFrom-Json
    Write-Host "OK - config.json encontrado:" -ForegroundColor Green
    Write-Host "   isServer  : $($config.isServer)"
    Write-Host "   serverIP  : $($config.serverIP)"

    if ((-not $config.isServer) -and ($config.serverIP -eq "localhost" -or $config.serverIP -eq "" -or $null -eq $config.serverIP)) {
        Write-Host ""
        Write-Host "PROBLEMA: Esta PC es CLIENTE pero serverIP es localhost o vacio!" -ForegroundColor Red
        Write-Host "Debes configurar la IP real del servidor en la aplicacion." -ForegroundColor Yellow
    }
} else {
    Write-Host "ERROR: config.json NO encontrado en: $configPath" -ForegroundColor Red
}

# 2. IP de esta PC
Write-Host ""
Write-Host "IP de esta PC:" -ForegroundColor Cyan
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike "*Loopback*" }
foreach ($ip in $ips) {
    Write-Host "   $($ip.InterfaceAlias): $($ip.IPAddress)"
}

# 3. Verificar puerto 3000 local
Write-Host ""
Write-Host "Puerto 3000 en esta PC:" -ForegroundColor Cyan
$port3000 = netstat -ano | Select-String ":3000"
if ($port3000) {
    Write-Host "   ACTIVO - Puerto 3000 esta escuchando:" -ForegroundColor Green
    $port3000 | ForEach-Object { Write-Host "   $_" }
} else {
    Write-Host "   Puerto 3000 NO esta activo en esta PC" -ForegroundColor Yellow
    if ($config -and -not $config.isServer) {
        Write-Host "   (Normal para PC cliente)" -ForegroundColor Gray
    }
}

# 4. Ping al servidor (si es cliente)
if ($config -and (-not $config.isServer) -and $config.serverIP -ne "localhost" -and $config.serverIP -ne "") {
    Write-Host ""
    Write-Host "Ping al servidor ($($config.serverIP)):" -ForegroundColor Cyan
    $pingResult = Test-Connection -ComputerName $config.serverIP -Count 2 -Quiet
    if ($pingResult) {
        Write-Host "   OK - PING exitoso" -ForegroundColor Green
    } else {
        Write-Host "   ERROR - No hay respuesta de ping" -ForegroundColor Red
        Write-Host "   Verifica: 1) Servidor encendido  2) Misma red  3) Firewall" -ForegroundColor Yellow
    }

    # 5. Test HTTP
    Write-Host ""
    Write-Host "Test HTTP al servidor (puerto 3000):" -ForegroundColor Cyan
    try {
        $response = Invoke-WebRequest -Uri "http://$($config.serverIP):3000/api/maestro/verificar" -TimeoutSec 5 -UseBasicParsing
        $data = $response.Content | ConvertFrom-Json
        Write-Host "   OK - SERVIDOR RESPONDE:" -ForegroundColor Green
        Write-Host "   Estado: $($data.estado)"
        Write-Host "   Hora  : $($data.hora_servidor)"
    } catch {
        Write-Host "   ERROR - No se pudo conectar al puerto 3000" -ForegroundColor Red
        Write-Host "   $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "   SOLUCION FIREWALL (ejecutar en el SERVIDOR como Admin):" -ForegroundColor Cyan
        Write-Host "   netsh advfirewall firewall add rule name=NexusPOS dir=in action=allow protocol=TCP localport=3000" -ForegroundColor Green
    }
}

# 6. Test local si es servidor
if ($config -and $config.isServer) {
    Write-Host ""
    Write-Host "Test HTTP local (modo servidor):" -ForegroundColor Cyan
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/maestro/verificar" -TimeoutSec 5 -UseBasicParsing
        $data = $response.Content | ConvertFrom-Json
        Write-Host "   OK - Servidor local respondiendo:" -ForegroundColor Green
        Write-Host "   $($response.Content)"
    } catch {
        Write-Host "   ERROR - Servidor local NO responde en puerto 3000" -ForegroundColor Red
        Write-Host "   Verifica que Nexus POS este abierto en esta PC" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Diagnostico completado" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""
