#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('probe', 'prepare', 'verify', 'publish')][string]$Action = 'probe',
    [string]$BodyBase64 = '',
    [string[]]$ImagePath = @()
)

# Visible Windows Weixin 4.1 text-only adapter. Unknown layouts, clipboard
# mismatches and foreground changes fail closed BEFORE clicking Publish.
# After the click, uncertainty must never invite an automatic retry.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, System.Runtime.WindowsRuntime
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LumaFlowMomentsUI {
  public delegate bool Callback(IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr w);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr w, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr w, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr w, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
'@
$null = [LumaFlowMomentsUI]::SetProcessDpiAwarenessContext([IntPtr](-4))
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
$script:AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
    $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1
} | Select-Object -First 1
$script:Engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
    [Windows.Globalization.Language]::new('zh-Hans-CN'))
$script:EnglishEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
    [Windows.Globalization.Language]::new('en-US'))
$script:PublishAttempted = $false
$script:OriginalClipboard = $null
$script:ClipboardChanged = $false
$script:Locked = $false
$script:Mutex = [Threading.Mutex]::new($false, 'Local\LumaFlow.Weixin.MomentsPublisher')

function Receipt([string]$status, [string]$message) {
    @{ status=$status; message=$message; provider='windows_desktop' } | ConvertTo-Json -Compress
}
function Await($operation, $type) {
    $task = $script:AsTask.MakeGenericMethod($type).Invoke($null, @($operation))
    if (-not $task.Wait(6000)) { throw 'OCR timeout' }
    $task.Result
}
function Rect([IntPtr]$handle) {
    $r = New-Object LumaFlowMomentsUI+RECT
    if (-not [LumaFlowMomentsUI]::GetWindowRect($handle, [ref]$r)) { throw 'Window unavailable' }
    $r
}
function Windows-For([int]$ownerId) {
    $items = New-Object 'System.Collections.Generic.List[object]'
    $callback = [LumaFlowMomentsUI+Callback]{ param($w,$l)
        $owner = [uint32]0
        $null = [LumaFlowMomentsUI]::GetWindowThreadProcessId($w, [ref]$owner)
        if ($owner -eq $ownerId -and [LumaFlowMomentsUI]::IsWindowVisible($w)) {
            $title = New-Object Text.StringBuilder 512
            $class = New-Object Text.StringBuilder 512
            $null = [LumaFlowMomentsUI]::GetWindowText($w, $title, 512)
            $null = [LumaFlowMomentsUI]::GetClassName($w, $class, 512)
            $items.Add([pscustomobject]@{Handle=$w;Title=$title.ToString();Class=$class.ToString();Rect=(Rect $w)})
        }
        return $true
    }
    $null = [LumaFlowMomentsUI]::EnumWindows($callback, [IntPtr]::Zero)
    $items.ToArray()
}
function Key([byte]$key) {
    [LumaFlowMomentsUI]::keybd_event($key,0,0,[UIntPtr]::Zero)
    [LumaFlowMomentsUI]::keybd_event($key,0,2,[UIntPtr]::Zero)
}
function Ctrl([byte]$key) {
    [LumaFlowMomentsUI]::keybd_event(17,0,0,[UIntPtr]::Zero)
    Key $key
    [LumaFlowMomentsUI]::keybd_event(17,0,2,[UIntPtr]::Zero)
}
function Focus([IntPtr]$handle) {
    $null = [LumaFlowMomentsUI]::ShowWindow($handle,9)
    Key 18
    $null = [LumaFlowMomentsUI]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 400
    Assert-Focus $handle
}
function Assert-Focus([IntPtr]$handle) {
    if ([LumaFlowMomentsUI]::GetForegroundWindow() -ne $handle) {
        throw 'Weixin is not in the foreground'
    }
}
function Click([IntPtr]$handle, [int]$x, [int]$y, [bool]$right=$false) {
    Assert-Focus $handle
    $r = Rect $handle
    if ($x -lt $r.Left -or $x -ge $r.Right -or $y -lt $r.Top -or $y -ge $r.Bottom) {
        throw 'Click outside verified window'
    }
    $null = [LumaFlowMomentsUI]::SetCursorPos($x,$y)
    Start-Sleep -Milliseconds 80
    $down=2; $up=4; if ($right) { $down=8; $up=16 }
    [LumaFlowMomentsUI]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
    [LumaFlowMomentsUI]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
}
function Capture($r) {
    $bitmap = New-Object Drawing.Bitmap ($r.Right-$r.Left),($r.Bottom-$r.Top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($r.Left,$r.Top,0,0,$bitmap.Size) }
    finally { $graphics.Dispose() }
    $bitmap
}
function Convert-OcrResult($result) {
    # Materialize WinRT collections before indexing. Each word must carry
    # scalar coordinates, even when the OCR line contains multiple words.
    [pscustomobject]@{
        Text=$result.Text
        Lines=@($result.Lines | ForEach-Object {
            [pscustomobject]@{
                Text=$_.Text
                Words=@($_.Words | ForEach-Object {
                    [pscustomobject]@{BoundingRect=[pscustomobject]@{
                        X=[double]$_.BoundingRect.X; Y=[double]$_.BoundingRect.Y
                        Width=[double]$_.BoundingRect.Width; Height=[double]$_.BoundingRect.Height
                    }}
                })
            }
        })
    }
}
function Menu-Point($menuRect, $ocrWord) {
    $box=$ocrWord.BoundingRect
    [pscustomobject]@{
        X=[int]([double]$menuRect.Left + [double]$box.X + [double]$box.Width/2)
        Y=[int]([double]$menuRect.Top + [double]$box.Y + [double]$box.Height/2)
    }
}
function Recognize($r, [bool]$enlarge=$false, [bool]$english=$false) {
    if (-not $script:Engine) { throw 'Install Windows Chinese OCR language' }
    $path = Join-Path ([IO.Path]::GetTempPath()) ('lumaflow-moments-' + [guid]::NewGuid().ToString('N') + '.png')
    $capture=$null; $stream=$null; $bitmap=$null
    try {
        $capture = Capture $r
        if ($enlarge) {
            $large=New-Object Drawing.Bitmap ($capture.Width*3),($capture.Height*3)
            $graphics=[Drawing.Graphics]::FromImage($large)
            try { $graphics.DrawImage($capture,0,0,$large.Width,$large.Height) }
            finally { $graphics.Dispose(); $capture.Dispose() }
            $capture=$large
        }
        $capture.Save($path,[Drawing.Imaging.ImageFormat]::Png)
        $file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
        $stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $engine=$script:Engine
        if ($english -and $script:EnglishEngine) { $engine=$script:EnglishEngine }
        $result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        # PowerShell 5.1 does not index WinRT IReadOnlyList reliably: Words[0]
        # can expose the entire collection, turning X/Y into Object[] values.
        # Materialize ordinary arrays and scalar coordinates at this boundary.
        Convert-OcrResult $result
    } finally {
        if ($bitmap) { $bitmap.Dispose() }
        if ($stream) { $stream.Dispose() }
        if ($capture) { $capture.Dispose() }
        if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
    }
}
function Compact([string]$text) { ($text -replace '\s','').ToLowerInvariant() }
function Compact-Name([string]$text) {
    # In Weixin's font uppercase I and lowercase l have the same vertical
    # stroke. Normalize that OCR ambiguity for account names ONLY, not body.
    Compact ($text.Replace('I','l'))
}
function Clipboard([string]$text) {
    [Windows.Forms.Clipboard]::SetText($text)
    $script:ClipboardChanged=$true
}
function Moments-Top([IntPtr]$main) {
    Assert-Focus $main
    $r=Rect $main
    $null=[LumaFlowMomentsUI]::SetCursorPos(($r.Right-100),($r.Top+300))
    [LumaFlowMomentsUI]::mouse_event(0x0800,0,0,7200,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 500
}
function Verify-Post([IntPtr]$main, [double]$scale, [string]$body, [int]$maxAgeMinutes=10) {
    Assert-Focus $main
    $r=Rect $main
    # Compare the first feed author's name to the logged-in profile displayed
    # on the cover. Weixin 4.1 shows an icon (not the word Delete) on own posts.
    $profile=[pscustomobject]@{Left=($r.Right-[int](180*$scale));Top=($r.Top+[int](307*$scale));Right=($r.Right-[int](105*$scale));Bottom=($r.Top+[int](338*$scale))}
    $profileName=Compact-Name (Recognize $profile $true $true).Text
    if (-not $profileName) { return $false }
    $feed=[pscustomobject]@{Left=($r.Left+[int](380*$scale));Top=($r.Top+[int](375*$scale));Right=($r.Right-[int](35*$scale));Bottom=([Math]::Min($r.Bottom-[int](30*$scale),$r.Top+[int](490*$scale)))}
    $ocr=Recognize $feed $true
    $lines=@($ocr.Lines | ForEach-Object { Compact $_.Text } | Where-Object { $_ })
    $author=[pscustomobject]@{Left=$feed.Left;Top=$feed.Top;Right=($feed.Left+[int](180*$scale));Bottom=($feed.Top+[int](38*$scale))}
    $authorName=Compact-Name (Recognize $author $true $true).Text
    if ($lines.Count -lt 3 -or $authorName -ne $profileName) { return $false }
    $text=Compact $ocr.Text
    $fresh=$text -match '(刚刚|\d{1,2}秒前)'
    $minutes=[regex]::Match($text,'(?<!\d)(\d{1,3})分钟前')
    if ($minutes.Success) { $fresh=[int]$minutes.Groups[1].Value -le $maxAgeMinutes }
    return $fresh -and $text.Contains((Compact $body))
}

try {
    $processes = @(Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -in @('微信','Weixin','WeChat') })
    if ($processes.Count -ne 1) { throw 'Need exactly one logged-in Weixin desktop window' }
    $process=$processes[0]; $main=$process.MainWindowHandle
    if (-not $process.MainModule.FileVersionInfo.FileVersion.StartsWith('4.1.')) {
        throw 'Only verified Weixin 4.1 layout is supported'
    }
    if ($Action -eq 'probe') { Receipt 'ready' '检测到 Windows 微信 4.1；发布前仍需检查编辑器与正文。'; return }
    if ($ImagePath.Count) { throw 'Images are not supported by this text publisher' }
    $body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BodyBase64))
    if ([string]::IsNullOrWhiteSpace($body)) { throw 'Empty body' }
    $script:Locked=$script:Mutex.WaitOne(1000)
    if (-not $script:Locked) { throw 'Another publication is in progress' }
    if (@(Windows-For $process.Id | Where-Object Title -eq '朋友圈').Count) {
        throw 'Close the existing Moments editor first'
    }
    if ([Windows.Forms.Clipboard]::ContainsText()) {
        $script:OriginalClipboard=[Windows.Forms.Clipboard]::GetText()
    }
    Focus $main
    $r=Rect $main; $scale=[LumaFlowMomentsUI]::GetDpiForWindow($main)/96.0
    if (($r.Right-$r.Left) -lt 700*$scale -or ($r.Bottom-$r.Top) -lt 500*$scale) {
        throw 'Weixin window is too small'
    }
    Click $main ($r.Left+[int](36*$scale)) ($r.Top+[int](256*$scale))
    Start-Sleep -Milliseconds 700
    Assert-Focus $main
    $r=Rect $main
    $nav=Recognize $r
    if ((Compact $nav.Text) -notmatch '朋友圈' -or (Compact $nav.Text) -notmatch '发现') {
        throw 'Moments navigation could not be verified'
    }
    Moments-Top $main
    if ($Action -eq 'verify') {
        if (Verify-Post $main $scale $body 60) {
            Receipt 'published_verified' '已核对当前微信账户的最新朋友圈正文与发布时间；本次仅核验，没有再次发表。'
        } else {
            Receipt 'submitted_unverified' '未能核对到当前账户1小时内的最新朋友圈；本次仅核验，没有再次发表。'
        }
        return
    }
    Click $main ($r.Right-[int](43*$scale)) ($r.Top+[int](55*$scale)) $true
    Start-Sleep -Milliseconds 350
    $menus=@(Windows-For $process.Id | Where-Object Class -match 'QWindowToolSaveBits')
    if ($menus.Count -ne 1) { throw 'Moments camera menu not found' }
    $menu=$menus[0]
    $ocr=Recognize $menu.Rect
    $line=@($ocr.Lines | Where-Object { (Compact $_.Text) -match '发表文字' })
    if ($line.Count -ne 1) { throw 'Text-only Moments menu not verified' }
    $point=Menu-Point $menu.Rect $line[0].Words[0]
    $foreground=[LumaFlowMomentsUI]::GetForegroundWindow()
    if ($foreground -ne $main -and $foreground -ne $menu.Handle) { throw 'Menu lost foreground' }
    $null=[LumaFlowMomentsUI]::SetCursorPos($point.X,$point.Y)
    [LumaFlowMomentsUI]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    [LumaFlowMomentsUI]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 650
    $editors=@(Windows-For $process.Id | Where-Object Title -eq '朋友圈')
    if ($editors.Count -ne 1) { throw 'Moments editor not found' }
    $editor=$editors[0]; $e=$editor.Rect
    if ([Math]::Abs(($e.Right-$e.Left)/$scale-410) -gt 15 -or
        [Math]::Abs(($e.Bottom-$e.Top)/$scale-450) -gt 15) { throw 'Unknown editor layout' }
    Focus $editor.Handle
    $ocr=Recognize $e; $text=Compact $ocr.Text
    if ($text -notmatch '提醒谁看' -or $text -notmatch '谁可以看') { throw 'Editor controls not verified' }
    Click $editor.Handle ($e.Left+[int](120*$scale)) ($e.Top+[int](75*$scale))
    Assert-Focus $editor.Handle
    Clipboard $body
    Ctrl 65; Ctrl 86
    Start-Sleep -Milliseconds 250
    Clipboard ('lumaflow-verify-' + [guid]::NewGuid().ToString('N'))
    Ctrl 65; Ctrl 67
    Start-Sleep -Milliseconds 250
    if ([Windows.Forms.Clipboard]::GetText().Replace("`r`n","`n") -cne $body.Replace("`r`n","`n")) {
        throw 'Editor body did not match confirmed text'
    }
    $buttonX=$e.Left+[int](145*$scale); $buttonY=$e.Top+[int](379*$scale)
    $capture=Capture $e
    try {
        $color=$capture.GetPixel([int](100*$scale),[int](379*$scale))
        if ($color.G -lt 100 -or $color.G -lt $color.R*1.3 -or $color.G -lt $color.B*1.1) {
            throw 'Publish button is not enabled'
        }
    } finally { $capture.Dispose() }
    Assert-Focus $editor.Handle
    if ($Action -eq 'prepare') {
        Receipt 'prepared' '正文与发表按钮已核对，本次检查不点击发表。'; return
    }
    $script:PublishAttempted=$true
    Click $editor.Handle $buttonX $buttonY
    for ($attempt=0; $attempt -lt 12; $attempt++) {
        Start-Sleep -Milliseconds 400
        if (-not [LumaFlowMomentsUI]::IsWindowVisible($editor.Handle)) { break }
    }
    if ([LumaFlowMomentsUI]::IsWindowVisible($editor.Handle)) {
        Receipt 'submitted_unverified' '已点击发表，但微信编辑器仍未关闭；请检查客户端，暂勿重复确认。'; return
    }
    Focus $main
    Moments-Top $main
    for ($attempt=0; $attempt -lt 5; $attempt++) {
        if (Verify-Post $main $scale $body) {
            Receipt 'published_verified' '已在当前登录微信的朋友圈顶部核对到本人账户、正文与发布时间。'; return
        }
        Start-Sleep -Milliseconds 500
    }
    Receipt 'submitted_unverified' '微信编辑器已关闭，但未能核对最新朋友圈；请检查朋友圈，暂勿重复确认。'
} catch {
    if ($script:PublishAttempted) {
        Receipt 'submitted_unverified' '发表操作已尝试，但核验中断；请检查朋友圈，暂勿重复确认。'
    } else {
        Receipt 'failed' ('尚未点击发表（步骤行 ' + $_.InvocationInfo.ScriptLineNumber + '）：' + $_.Exception.Message)
    }
} finally {
    if ($script:ClipboardChanged) {
        try {
            if ($null -ne $script:OriginalClipboard) {
                [Windows.Forms.Clipboard]::SetText($script:OriginalClipboard)
            } else { [Windows.Forms.Clipboard]::Clear() }
        } catch { }
    }
    if ($script:Locked) { $script:Mutex.ReleaseMutex() }
    $script:Mutex.Dispose()
}
