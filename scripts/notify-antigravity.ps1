param (
  [Parameter(Mandatory=$true)]
  [ValidateSet('SUCCESS', 'BLOCKED', 'FAILED')]
  [string]$Status,

  [Parameter(Mandatory=$true)]
  [string]$Task,

  [Parameter(Mandatory=$false)]
  [string]$Message,

  [Parameter(Mandatory=$false)]
  [string]$Summary
)

$ErrorActionPreference = 'SilentlyContinue'

$msgText = $Message
if (-not $msgText -or $msgText.Trim().Length -eq 0) {
  $msgText = $Summary
}
if (-not $msgText -or $msgText.Trim().Length -eq 0) {
  if ($Status -eq 'SUCCESS') { $msgText = 'Concluida com sucesso.' }
  elseif ($Status -eq 'BLOCKED') { $msgText = 'Acao humana necessaria.' }
  else { $msgText = 'Erro durante a execucao.' }
}

$title = ''
$toastAudio = 'ms-winsoundevent:Notification.Default'
$freqs = @(1000, 1500)
$beepDuration = 120

if ($Status -eq 'SUCCESS') {
  $title = [char]0x2705 + ' ANTIGRAVITY - TASK CONCLUIDA'
  $toastAudio = 'ms-winsoundevent:Notification.Default'
  $freqs = @(1000, 1400, 1800)
  $beepDuration = 120
} elseif ($Status -eq 'BLOCKED') {
  $title = [char]0x26A0 + ' ANTIGRAVITY - ACAO NECESSARIA'
  $toastAudio = 'ms-winsoundevent:Notification.Reminder'
  $freqs = @(700, 700, 700)
  $beepDuration = 200
} else {
  $title = [char]0x274C + ' ANTIGRAVITY - TASK FALHOU'
  $toastAudio = 'ms-winsoundevent:Notification.Default'
  $freqs = @(400, 300, 200)
  $beepDuration = 300
}

# 1. Alerta Sonoro do Windows
try {
  foreach ($f in $freqs) {
    [System.Console]::Beep($f, $beepDuration)
    Start-Sleep -Milliseconds 40
  }
} catch {
  [System.Media.SystemSounds]::Asterisk.Play()
}

# 2. Notificacao Toast Nativa do Windows 10/11 (WinRT / Windows.UI.Notifications)
$toastSent = $false
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

  $escapedTitle = [System.Security.SecurityElement]::Escape($title)
  $escapedTask = [System.Security.SecurityElement]::Escape($Task)
  $escapedMsg = [System.Security.SecurityElement]::Escape($msgText)

  $template = @"
<toast duration="long">
    <visual>
        <binding template="ToastGeneric">
            <text>$escapedTitle</text>
            <text>$escapedTask</text>
            <text>$escapedMsg</text>
        </binding>
    </visual>
    <audio src="$toastAudio" />
</toast>
"@

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($template)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}WindowsPowerShell1.0powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  $toastSent = $true
} catch {
  # Fallback para Windows Forms NotifyIcon
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $notify = New-Object System.Windows.Forms.NotifyIcon
    $notify.Icon = [System.Drawing.SystemIcons]::Information
    $notify.BalloonTipTitle = $title
    $notify.BalloonTipText = "$Task`n$msgText"
    $notify.Visible = $true
    $notify.ShowBalloonTip(8000)
    Start-Sleep -Milliseconds 200
    $notify.Dispose()
    $toastSent = $true
  } catch {}
}

# 3. Banner Terminal
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
if ($Status -eq 'SUCCESS') {
  Write-Host "  $title" -ForegroundColor Green
} elseif ($Status -eq 'BLOCKED') {
  Write-Host "  $title" -ForegroundColor Yellow
} else {
  Write-Host "  $title" -ForegroundColor Red
}
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "TASK:       $Task" -ForegroundColor White
$statusColor = 'Red'
if ($Status -eq 'SUCCESS') { $statusColor = 'Green' }
if ($Status -eq 'BLOCKED') { $statusColor = 'Yellow' }
Write-Host "STATUS:     $Status" -ForegroundColor $statusColor
Write-Host "MENSAGEM:   $msgText" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
