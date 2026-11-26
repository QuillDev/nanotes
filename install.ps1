param(
    [string]$Version = $env:NANOTES_VERSION
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'QuillDev/nanotes'
$Headers = @{ 'User-Agent' = 'nanotes-windows-installer' }

if ([string]::IsNullOrWhiteSpace($Version)) {
    $ReleaseUrl = "https://api.github.com/repos/$Repo/releases/latest"
} else {
    $Tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
    $ReleaseUrl = "https://api.github.com/repos/$Repo/releases/tags/$Tag"
}

Write-Host "Fetching release metadata from $Repo..."
$Release = Invoke-RestMethod -Uri $ReleaseUrl -Headers $Headers

$Asset = $Release.assets |
    Where-Object { $_.name -match 'x64-setup\.exe$' } |
    Select-Object -First 1

if (-not $Asset) {
    $Asset = $Release.assets |
        Where-Object { $_.name -match '-setup\.exe$' } |
        Select-Object -First 1
}

if (-not $Asset) {
    throw "No Windows installer (*-setup.exe) found on release $($Release.tag_name)."
}

$InstallerPath = Join-Path $env:TEMP $Asset.name

try {
    Write-Host "Downloading $($Asset.name) ($($Release.tag_name))..."
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $InstallerPath -Headers $Headers

    Write-Host 'Installing nanotes...'
    $Process = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru
    if ($Process.ExitCode -ne 0) {
        throw "Installer exited with code $($Process.ExitCode)."
    }

    Write-Host "Installed nanotes $($Release.tag_name). Launch it from the Start menu or press Alt+N once running."
} finally {
    if (Test-Path -LiteralPath $InstallerPath) {
        Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
    }
}
