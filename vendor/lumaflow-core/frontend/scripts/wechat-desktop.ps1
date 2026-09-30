[CmdletBinding()]
param(
    [ValidateSet('probe', 'connect', 'read')][string]$Action = 'probe',
    [int]$ProcessId = 0,
    [ValidateRange(1, 20)][int]$Limit = 5,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedChat = ''
)
# Original read-only UI Automation adapter. No database/key extraction,
# keystrokes, clipboard access, scrolling, message sending or external network.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Emit($value) { $value | ConvertTo-Json -Depth 7 -Compress }
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $processes = @(Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue)
    $windows = @($processes | Where-Object { $_.MainWindowHandle -ne 0 })
    $publicWindows = @($windows | ForEach-Object {
        @{ processId = $_.Id; version = $_.FileVersion; application = $_.ProcessName }
    })
    if ($Action -eq 'probe') {
        Emit @{ running = $processes.Count -gt 0; windows = $publicWindows; state = 'detected'; canRead = $false }
        exit 0
    }
    $target = $windows | Where-Object { $_.Id -eq $ProcessId } | Select-Object -First 1
    if (-not $target) { Emit @{ state = 'window_unavailable'; canRead = $false }; exit 0 }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
    if ($window.Current.ClassName -ne 'mmui::MainWindow') {
        Emit @{ state = 'unsupported_window'; canRead = $false }; exit 0
    }
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $idProperty = [System.Windows.Automation.AutomationElement]::AutomationIdProperty
    $messages = $window.FindFirst($scope, [System.Windows.Automation.PropertyCondition]::new($idProperty, 'chat_message_list'))
    $input = $window.FindFirst($scope, [System.Windows.Automation.PropertyCondition]::new($idProperty, 'chat_input_field'))
    if (-not $messages -or -not $input -or $messages.Current.IsOffscreen) {
        Emit @{ state = 'open_chat_required'; canRead = $false }; exit 0
    }
    $chatLabel = $input.Current.Name
    if ([string]::IsNullOrWhiteSpace($chatLabel)) {
        Emit @{ state = 'chat_identity_unavailable'; canRead = $false }; exit 0
    }
    function ChatFingerprint {
        $identity = "$($target.Id)|$($target.StartTime.ToUniversalTime().Ticks)|$($window.GetRuntimeId() -join ',')|$($input.Current.Name)"
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
    }
    $chatFingerprint = ChatFingerprint
    $items = @($messages.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) |
        Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem })
    $result = @{ state = 'ready'; canRead = $true; processId = $target.Id; version = $target.FileVersion; chatLabel = $chatLabel; chatFingerprint = $chatFingerprint; loadedItems = $items.Count }
    if ($Action -eq 'read') {
        if (-not $ExpectedChat -or $ExpectedChat -ne $chatFingerprint) {
            Emit @{ state = 'chat_changed'; canRead = $false }; exit 0
        }
        $entries = @($items | Select-Object -Last $Limit | ForEach-Object {
            $class = $_.Current.ClassName
            $isText = $class -eq 'mmui::ChatTextItemView'
            $isSystem = $class -eq 'mmui::ChatItemView'
            # Attachment controls are not evidence of their file contents.
            @{ kind = $(if ($isText) { 'text' } elseif ($isSystem) { 'system' } else { 'attachment-unread' });
               text = $(if ($isText -or $isSystem) { $_.Current.Name } else { '[Attachment content not read]' }) }
        })
        # Fail closed if the user changed chats while the read was in flight.
        if ((ChatFingerprint) -ne $ExpectedChat) { Emit @{ state = 'chat_changed'; canRead = $false }; exit 0 }
        $result.entries = $entries
    }
    Emit $result
} catch {
    # Do not expose control names, message contents or file paths in failures.
    Emit @{ state = 'accessibility_unavailable'; canRead = $false }
}
