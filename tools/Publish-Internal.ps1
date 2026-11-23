<#
.SYNOPSIS
  Sash の新しい版を、社内の共有フォルダに配置する（インターネットに出られない PC 向けの更新元）。

.DESCRIPTION
  GitHub のリリースからダウンロードした Sash-<版>-win-x64.exe を共有フォルダにコピーし、
  照合値（SHA256）を計算して latest.json を書く。利用者の Sash は、この latest.json を見て更新する。
  latest.json は exe のコピーが終わってから最後に書き換えるので、配置の途中で利用者が更新しても壊れない。

.EXAMPLE
  .\Publish-Internal.ps1 -Exe .\Sash-0.2.0-win-x64.exe -Destination \\fileserver\tools\Sash -Notes "Backstage の表示を修正"
#>
param(
    [Parameter(Mandatory)] [string] $Exe,
    [Parameter(Mandatory)] [string] $Destination,
    [string] $Notes = ""
)

$ErrorActionPreference = 'Stop'

$name = Split-Path $Exe -Leaf
if ($name -notmatch '^Sash-(\d+\.\d+\.\d+)-win-x64\.exe$') {
    throw "ファイル名は Sash-<版>-win-x64.exe の形にしてください（今は $name）"
}
$version = $Matches[1]

New-Item -ItemType Directory -Force $Destination | Out-Null
Copy-Item $Exe (Join-Path $Destination $name) -Force

$hash = (Get-FileHash (Join-Path $Destination $name) -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $Destination "$name.sha256"), "$hash  $name`n")

$manifest = [ordered]@{ version = $version; file = $name; sha256 = $hash; notes = $Notes } | ConvertTo-Json
$tmp = Join-Path $Destination "latest.json.tmp"
[IO.File]::WriteAllText($tmp, $manifest)
Move-Item $tmp (Join-Path $Destination "latest.json") -Force

Write-Host "配置しました：$Destination（版 $version、SHA256 $hash）"
