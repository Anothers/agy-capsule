param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'uninstall')]
    [string]$Action,
    [string]$PluginsDirectory = (Join-Path $env:USERPROFILE '.gemini\config\plugins')
)

$ErrorActionPreference = 'Stop'
# Messages print as an [English] block, then a [中文] block.
# Keep this file UTF-8 with BOM so Windows PowerShell 5.1 reads the Chinese correctly.
function Format-Bilingual([string[]]$english, [string[]]$chinese) { (@('[English]') + $english + @('[中文]') + $chinese) -join [Environment]::NewLine }
function Say([string[]]$english, [string[]]$chinese) { Write-Host (Format-Bilingual $english $chinese) }
$pluginRoot = [IO.Path]::GetFullPath($PluginsDirectory).TrimEnd('\', '/')
$destination = [IO.Path]::GetFullPath((Join-Path $pluginRoot 'agy-capsule'))

# Validate the exact recursive-copy/delete target; never traverse a plugin link.
if ((Split-Path -Parent $destination) -ne $pluginRoot -or (Split-Path -Leaf $destination) -ne 'agy-capsule') {
    throw (Format-Bilingual "Invalid plugin destination: $destination" "插件目标路径无效：$destination")
}
if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw (Format-Bilingual "Plugin destination is a link. Remove the link manually first: $destination" "插件目标路径是一个链接，请先手动删除这个链接：$destination")
}

if ($Action -eq 'uninstall') {
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
        $removedEn = "Removed agy-capsule from $destination"; $removedZh = "已从 $destination 移除 agy-capsule"
    } else {
        $removedEn = "Not installed: $destination"; $removedZh = "未安装：$destination"
    }
    Say @($removedEn, 'Preferences were kept. Reload open Antigravity pages to clear any remaining UI.') @($removedZh, '已保留设置。重新加载已打开的 Antigravity 页面即可清除残留界面。')
    exit 0
}

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\agy-capsule')).Path
if (-not (Test-Path -LiteralPath (Join-Path $source 'plugin.json'))) {
    throw (Format-Bilingual "Source plugin manifest missing: $source\plugin.json" "缺少源插件清单：$source\plugin.json")
}
if ($source -eq $destination) { throw (Format-Bilingual 'Source and destination must be different directories.' '源目录和目标目录不能相同。') }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$marker = Join-Path $destination '.update-in-progress'
Set-Content -LiteralPath $marker -Value 'Updating agy-capsule' -Encoding ASCII
try {
    & robocopy.exe $source $destination /MIR /XJ /XF .update-in-progress /NFL /NDL /NJH /NJS /NP /R:2 /W:1
    if ($LASTEXITCODE -ge 8) { throw (Format-Bilingual "Plugin copy failed (robocopy exit code $LASTEXITCODE)." "插件复制失败（robocopy 退出码 $LASTEXITCODE）。") }
} finally {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}
Say @("Installed/updated agy-capsule at $destination", 'Enable it in Antigravity Plugins on first install. Updates auto-restart a running reload-enabled version.') @("已安装/更新 agy-capsule 到 $destination", '首次安装需在 Antigravity 的 Plugins 面板中启用。更新后，支持自动重载的插件会自动重启。')
exit 0
