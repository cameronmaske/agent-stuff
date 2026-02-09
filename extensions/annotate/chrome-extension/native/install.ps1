param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HostScript = Join-Path $ScriptDir "host.cjs"
$WrapperPath = Join-Path $ScriptDir "host-wrapper.cmd"

function Resolve-NodePath {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    return $nodeCommand.Source
  }

  $fallbacks = @(
    "$env:ProgramFiles\\nodejs\\node.exe",
    "$env:ProgramFiles(x86)\\nodejs\\node.exe"
  )

  foreach ($candidate in $fallbacks) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return $null
}

$nodePath = Resolve-NodePath
if (-not $nodePath) {
  Write-Error "Could not find node.exe. Please install Node.js."
  exit 1
}

$wrapperContent = "@echo off`r`n`"$nodePath`" `"$HostScript`" %*`r`n"
Set-Content -Path $WrapperPath -Value $wrapperContent -Encoding ASCII

$manifestDir = Join-Path $env:LOCALAPPDATA "pi-annotate"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
$manifestPath = Join-Path $manifestDir "com.pi.annotate.json"

$manifest = @{
  name = "com.pi.annotate"
  description = "Pi Annotate native messaging host"
  path = $WrapperPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3

Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8

$regPath = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.pi.annotate"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(default)" -Value $manifestPath

Write-Host "Installed native host manifest to: $manifestPath"
Write-Host "Registered at: $regPath"
Write-Host "Restart Chrome for changes to take effect."
