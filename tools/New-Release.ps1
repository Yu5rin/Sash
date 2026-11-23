<#
.SYNOPSIS
  リリースの配布物を手元（Windows）で作って確かめる。リリースの経路としては使わない。

.DESCRIPTION
  UI のビルド、単一 exe の発行、照合値ファイル（.sha256）、リリース本文の下書きまでを1コマンドで行う。
  正規のリリースは .github/workflows/release.yml（タグの push）で作る。ここで作ったものを
  GitHub Release へ添付しないこと（docs/リリース手順.md「手元で試すとき」）。

.EXAMPLE
  cd C:\Users\YUGO\Sash
  powershell -ExecutionPolicy Bypass -File tools\New-Release.ps1
#>
param(
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not $Force -and (git status --porcelain)) {
    throw "作業ツリーに未コミットの変更があります。問題なければ -Force を付けて実行してください"
}

[xml]$props = Get-Content Directory.Build.props
$version = ($props.Project.PropertyGroup | Where-Object { $_.Version } | Select-Object -First 1).Version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Directory.Build.props の <Version> を 1.2.3 の形にしてください（今は $version）"
}

$out = Join-Path $root 'publish\release'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null

Push-Location ui
try {
    npm ci
    npm test
    npm run build
}
finally {
    Pop-Location
}

dotnet test Sash.slnx -c Release
dotnet publish src/Sash.App -p:PublishProfile=win-x64

$name = "Sash-$version-win-x64.exe"
$exe = Join-Path $out $name
Copy-Item artifacts\publish\win-x64\Sash.exe $exe

$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$exe.sha256", "$hash  $name`n")

# 本文の下書き（テンプレートに、変更履歴の節とダウンロードの表を差し込む）
$changelog = Get-Content docs\変更履歴.md -Raw -Encoding UTF8
$section = [regex]::Match($changelog, "(?ms)^## $([regex]::Escape($version))\r?\n(.*?)(?=^## |\z)").Groups[1].Value
$section = [regex]::Replace($section, "(?ms)^### バージョン\r?\n- ``[^``]*``\s*$", '').Trim()
$sizeMb = '{0:N1} MB' -f ((Get-Item $exe).Length / 1MB)
$table = "| ファイル | サイズ | SHA256 |`n|---|---|---|`n| ``$name`` | $sizeMb | ``$hash`` |"
$body = (Get-Content docs\リリース説明_テンプレート.md -Raw -Encoding UTF8).Replace('{CHANGES}', $section).Replace('{DOWNLOADS}', $table)
[IO.File]::WriteAllText((Join-Path $out 'リリース説明.md'), $body, (New-Object Text.UTF8Encoding $false))

Write-Host ""
Write-Host "配布物：$exe"
Write-Host "SHA256：$hash"
Write-Host "本文の下書き：$(Join-Path $out 'リリース説明.md')"
Write-Host "（ここで作ったものはリリースに添付しないでください。リリースはタグの push で作ります）"
