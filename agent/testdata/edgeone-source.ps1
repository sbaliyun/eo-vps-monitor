param([string]$Installer, [string]$Root, [ValidateSet('build', 'checksum', 'no-go')][string]$Case)
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput((Get-Content -LiteralPath $Installer -Raw), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw $parseErrors[0].Message }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}

$Server = 'https://panel.example/'
$scriptDir = $Root
$env:TEMP = $Root
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$repository = 'sbaliyun/cf-vps-monitor'
$branch = 'main'
$releaseBase = Resolve-ReleaseBase
$BinaryPath = ''; $BinaryUrl = ''; $ChecksumUrl = ''; $BinaryBaseUrl = ''; $SourceUrl = ''
$BuildFromSource = $false; $DryRun = $false; $autoBinaryUrl = $false
$InstallGhproxy = 'https://github-proxy.example'
$requests = [Collections.Generic.List[string]]::new()
$compiledDirectory = ''
$checksumChecked = $false

function Invoke-DownloadFile {
  param([string]$Url, [string]$OutFile)
  $requests.Add($Url)
  if ($Url -eq 'https://panel.example/agent/source.zip') {
    Copy-Item -LiteralPath (Join-Path $Root 'agent/source.zip') -Destination $OutFile
  } elseif ($Case -eq 'checksum') {
    Set-Content -LiteralPath $OutFile -Value 'downloaded bytes'
  } else {
    throw 'Synthetic Release HTTP 404'
  }
}
function Test-DownloadedChecksum {
  $script:checksumChecked = $true
  throw 'Synthetic checksum mismatch'
}
function Get-Command {
  if ($Case -eq 'no-go') { return $null }
  return @{ Name = 'go' }
}
function go {
  if (-not (Test-Path -LiteralPath 'go.mod') -or -not (Test-Path -LiteralPath 'main.go')) { throw 'Go inputs missing' }
  $script:compiledDirectory = (Get-Location).Path
  Set-Content -LiteralPath $buildOut -Value 'synthetic executable'
  $global:LASTEXITCODE = 0
}

$failure = $null
try {
  foreach ($prefix in @(
    'if ($BinaryPath -eq "" -and $BinaryUrl -eq "" -and -not $BuildFromSource)',
    'if ($BinaryPath -eq "" -and $BinaryUrl -ne "")',
    'if ($BinaryPath -eq "" -and $BuildFromSource)'
  )) {
    $block = $ast.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith($prefix) }, $false)
    if (-not $block) { throw "Installer branch not found: $prefix" }
    . ([scriptblock]::Create($block.Extent.Text))
  }
} catch {
  $failure = $_.Exception.Message
}
[pscustomobject]@{
  error = $failure
  requests = $requests.ToArray()
  compiled_directory = $compiledDirectory
  binary_selected = [bool]$BinaryPath
  checksum_checked = $checksumChecked
} | ConvertTo-Json -Compress
