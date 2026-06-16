$srcDir  = 'C:\Users\Youssef Aoufi\Pexip Dev\VideoShare2\branding-package'
$zipPath = 'C:\Users\Youssef Aoufi\Pexip Dev\VideoShare2\branding.zip'

if (Test-Path $zipPath) { Remove-Item $zipPath }

Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')

Get-ChildItem -Path $srcDir -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($srcDir.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relative) | Out-Null
}

$zip.Dispose()

$check = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
Write-Host "Done: $($check.Entries.Count) entries"
$check.Entries | ForEach-Object { Write-Host $_.FullName }
$check.Dispose()
