param (
  [Parameter(Mandatory=$true)]
  [ValidateSet('SUCCESS', 'BLOCKED', 'FAILED')]
  [string]$Status,

  [Parameter(Mandatory=$true)]
  [string]$Task,

  [Parameter(Mandatory=$false)]
  [string]$Message,

  [Parameter(Mandatory=$false)]
  [string]$Summary,

  [Parameter(Mandatory=$false)]
  [string]$TaskId
)

$ErrorActionPreference = 'SilentlyContinue'

# 1. Deduplicacao estrita: 1 notificacao por tarefa de alto nivel
$id = $TaskId
if (-not $id -or $id.Trim().Length -eq 0) {
  $id = $Task.Trim().ToLower() -replace '[^a-z0-9]', '_'
}

$stateDir = [System.IO.Path]::Combine($env:TEMP, 'antigravity_notify')
if (-not (Test-Path $stateDir)) {
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}

$lockFile = [System.IO.Path]::Combine($stateDir, "$id.notified")
if (Test-Path $lockFile) {
  # Ja notificado para esta task de alto nivel - SILENCIO TOTAL
  exit 0
}

Set-Content -Path $lockFile -Value (Get-Date -Format 'o') -Force

# 2. Mensagem e Titulo
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
if ($Status -eq 'SUCCESS') {
  $title = [char]0x2705 + ' ANTIGRAVITY - TASK CONCLUIDA'
} elseif ($Status -eq 'BLOCKED') {
  $title = [char]0x26A0 + ' ANTIGRAVITY - ACAO NECESSARIA'
} else {
  $title = [char]0x274C + ' ANTIGRAVITY - TASK FALHOU'
}

# 3. Toast 100% Silencioso (audio silent="true", ZERO Beep, ZERO SystemSounds)
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

  $escapedTitle = [System.Security.SecurityElement]::Escape($title)
  $escapedTask = [System.Security.SecurityElement]::Escape($Task)
  $escapedMsg = [System.Security.SecurityElement]::Escape($msgText)

  $template = @"
<toast duration="short">
    <visual>
        <binding template="ToastGeneric">
            <text>$escapedTitle</text>
            <text>$escapedTask</text>
            <text>$escapedMsg</text>
        </binding>
    </visual>
    <audio silent="true" />
</toast>
"@

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($template)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
  # Fallback silencioso sem som
}

# 4. Banner Terminal
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
