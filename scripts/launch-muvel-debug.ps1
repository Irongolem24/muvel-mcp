# Launch the Muvel desktop app with WebView2 remote debugging on 127.0.0.1 so muvel-mcp can
# refresh the open editor after AI edits. The variable is set for this process only, so other
# WebView2 apps are unaffected. While Muvel runs this way, other programs on this PC can also
# control it through the port; launch Muvel normally when you don't need live refresh.
param(
  [int]$Port = 9333,
  [string]$MuvelExe = "$env:LOCALAPPDATA\Muvel\muvel.exe"
)

$running = Get-Process muvel -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "Muvel is already running. Close it first (unsaved changes?), then run this again."
  exit 1
}

# Keep Tauri's default WebView2 flags; the variable replaces them rather than adding to them.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=$Port"
Start-Process $MuvelExe
