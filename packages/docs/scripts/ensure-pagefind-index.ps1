$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$distDir = Join-Path $repoRoot 'packages\docs\dist'
$pagefindDir = Join-Path $distDir 'pagefind'

if (Test-Path $pagefindDir) {
  exit 0
}

$bunStore = Join-Path $repoRoot 'node_modules\.bun'
$pagefindExe = Get-ChildItem $bunStore -Recurse -File |
  Where-Object { $_.Name -in @('pagefind.exe', 'pagefind_extended.exe') } |
  Sort-Object FullName |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $pagefindExe) {
  throw "Unable to find a local Pagefind executable under $bunStore"
}

& $pagefindExe --site $distDir

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
