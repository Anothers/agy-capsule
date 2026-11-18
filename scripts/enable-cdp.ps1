# Adds --remote-debugging-port=0 to Antigravity shortcuts so the footer capsule can attach.
# Newer Antigravity builds no longer open this port on their own (issue #5).
# Run with -Undo to remove the switch again. Restart Antigravity afterwards.
param(
    [switch]$Undo,
    [string[]]$ShortcutDirectories = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('CommonDesktopDirectory'),
        [Environment]::GetFolderPath('StartMenu'),
        [Environment]::GetFolderPath('CommonStartMenu'),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
    )
)

$ErrorActionPreference = 'Stop'
$switchName = '--remote-debugging-port'
$switchText = "$switchName=0"
$shell = New-Object -ComObject WScript.Shell
$found = 0

foreach ($directory in $ShortcutDirectories | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique) {
    foreach ($file in Get-ChildItem -LiteralPath $directory -Recurse -Filter *.lnk -ErrorAction SilentlyContinue) {
        $link = $shell.CreateShortcut($file.FullName)
        if (-not $link.TargetPath -or (Split-Path -Leaf $link.TargetPath) -ne 'Antigravity.exe') { continue }
        $found++
        $arguments = [string]$link.Arguments
        $hasSwitch = $arguments -match "(^|\s)$([regex]::Escape($switchName))(=\S*)?(?=\s|$)"
        if ($Undo) {
            if (-not $hasSwitch) { Write-Host "Unchanged (no switch): $($file.FullName)"; continue }
            $next = ($arguments -replace "(^|\s)$([regex]::Escape($switchName))(=\S*)?(?=\s|$)", '').Trim()
        } else {
            if ($hasSwitch) { Write-Host "Already set: $($file.FullName)"; continue }
            $next = "$arguments $switchText".Trim()
        }
        try {
            $link.Arguments = $next
            $link.Save()
            Write-Host "Updated: $($file.FullName)"
        } catch {
            # All-users shortcuts need an elevated prompt; leave them and say so.
            Write-Warning "Could not update (try an administrator PowerShell): $($file.FullName)"
        }
    }
}

if ($found -eq 0) {
    Write-Warning "No Antigravity shortcuts found. Start Antigravity with: Antigravity.exe $switchText"
    exit 1
}
if (Get-Process -Name Antigravity -ErrorAction SilentlyContinue) {
    Write-Host 'Antigravity is running. Quit it completely, then open it from one of these shortcuts.'
} else {
    Write-Host 'Done. Open Antigravity from one of these shortcuts.'
}
exit 0
