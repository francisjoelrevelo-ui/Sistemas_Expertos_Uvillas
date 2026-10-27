# Servidor estático mínimo para probar la PWA en http://localhost:8080
# (los Service Workers requieren http://localhost o https; no funcionan con file://)
# Uso:  powershell -ExecutionPolicy Bypass -File servidor.ps1 [-Puerto 8080]
param([int]$Puerto = 8080)

$raiz = $PSScriptRoot
$tipos = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.bin' = 'application/octet-stream'
  '.webmanifest' = 'application/manifest+json'; '.ico' = 'image/x-icon'
}

# Si el puerto está ocupado (por otro servidor), se prueba el siguiente hasta 10 veces
$listener = $null
for ($p = $Puerto; $p -lt $Puerto + 10; $p++) {
  $intento = New-Object System.Net.HttpListener
  $intento.Prefixes.Add("http://localhost:$p/")
  try {
    $intento.Start()
    $listener = $intento
    $Puerto = $p
    break
  } catch {
    Write-Host "Puerto $p ocupado, probando el siguiente..."
  }
}
if (-not $listener) {
  Write-Host "No se encontró un puerto libre entre $Puerto y $($Puerto + 9). Cierre otros servidores e intente de nuevo." -ForegroundColor Red
  exit 1
}
Write-Host "UvillaDx disponible en http://localhost:$Puerto/  (Ctrl+C para detener)" -ForegroundColor Green

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $resp = $ctx.Response
    try {
      $ruta = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($ruta -eq '') { $ruta = 'index.html' }
      $archivo = [IO.Path]::GetFullPath((Join-Path $raiz $ruta))
      if ($archivo.StartsWith($raiz) -and (Test-Path $archivo -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($archivo)
        $ext = [IO.Path]::GetExtension($archivo).ToLower()
        $resp.ContentType = if ($tipos.ContainsKey($ext)) { $tipos[$ext] } else { 'application/octet-stream' }
        if ($ruta -eq 'sw.js') { $resp.Headers.Add('Cache-Control', 'no-cache') }
        $resp.ContentLength64 = $bytes.Length
        # Las peticiones HEAD no llevan cuerpo
        if ($ctx.Request.HttpMethod -ne 'HEAD') { $resp.OutputStream.Write($bytes, 0, $bytes.Length) }
      } else {
        $resp.StatusCode = 404
      }
    } catch {
      Write-Warning $_
    } finally {
      try { $resp.Close() } catch {}
    }
  }
} finally {
  try { $listener.Stop() } catch {}
}
