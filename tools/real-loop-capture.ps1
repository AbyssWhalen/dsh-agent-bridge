<#
.SYNOPSIS
    Run the real DSH agent loop repeatedly and keep the transcript of every run that
    does not behave.

.DESCRIPTION
    `real-loop-check.ps1` counts failures; this keeps them. The three outcomes it
    separates cannot be told apart from a pass/fail count:

      tool-ran, no markup        good
      no markup, no token        the tool never executed — but *why* is in the transcript:
                                 no call was written, a call was written and refused, or
                                 a call was written and silently dropped
      markup in the transcript   the call was written and lost, the visible half

    Every transcript is written to `-OutDir` no matter how the run went, so a failure can
    be read afterwards rather than re-run for. Re-running is not free: it burns real
    quota and the failure is intermittent.

.EXAMPLE
    pwsh -File tools/real-loop-capture.ps1 -Runs 8 -Provider qoder -DshHome $env:TEMP\dsh-r4
#>
param(
    [string]$Profile = 'e2e',
    [int]$Runs = 8,
    [ValidateSet('workbuddy', 'qoder')]
    [string]$Provider = 'qoder',
    # Empty means "a cheap model on whichever vendor was asked for". A single hardcoded
    # default cannot be right for both: the ids come from each vendor's own catalog, so
    # `-Provider workbuddy` with the Qoder default fails every run with
    # `model "qmodel_38max" is not in the catalog` — eight runs, eight identical failures,
    # and nothing measured. The picks below are the cheapest usable ones per the live
    # catalog (see docs/verification.md).
    [string]$Model = '',
    [string]$DshHome = "$env:TEMP\dsh-r4",
    [string]$DshBin = 'D:\CodeEditor\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js',
    [string]$OutDir = '',
    [string]$Prompt = 'Run the pwsh tool to list the files in the current directory, then report their exact names.'
)

$ErrorActionPreference = 'Stop'

if ($Model -eq '') {
    $Model = if ($Provider -eq 'workbuddy') { 'deepseek-v4.1-flash' } else { 'qmodel_38max' }
    Write-Host "model: $Model (default for $Provider)"
}

if ($OutDir -eq '') { $OutDir = Join-Path (Get-Location) '.real-loop-capture' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$work = Join-Path $OutDir 'work'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null

$overlay = Join-Path $OutDir 'provider.yml'
@"
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: $Provider
    model: $Model
"@ | Set-Content -Path $overlay -Encoding utf8

$env:DSH_HOME = $DshHome
$rows = @()

for ($i = 1; $i -le $Runs; $i++) {
    $token = -join ((48..57) + (97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
    $name = "tok-$token.txt"
    Set-Content -Path (Join-Path $work $name) -Value "T=$token"

    Push-Location $work
    try {
        $transcript = (& node $DshBin --profile $Profile --patch $overlay headless $Prompt 2>&1) -join "`n"
    }
    finally {
        Pop-Location
    }

    # Leak detection reads the *answer*, not the model's thinking.
    #
    # The old rule was `invoke|parameter name=|｜{2,}` over the whole transcript, and it produced
    # false alarms: a reasoning channel that says "I made a malformed invoke" in plain English
    # tripped it while the turn was perfectly fine — the tool ran and the answer was correct.
    # Measured on `kmodel_latest`: 2/4 runs reported as leaks, one of which was this exact
    # sentence inside `dsh: reasoning:`.
    #
    # A real leak is a *marker*, and every marker this plugin recovers spells one of these: the
    # fullwidth-bar form `｜｜DSML`, the tag form `<｜｜invoke`, or a bar-run `parameter name=`.
    # So: strip the reasoning paragraphs, then look for marker shapes only. Each paragraph is a
    # `dsh: reasoning:` title line followed by its body, and stripping exactly those keeps an
    # answer that arrives *after* a reasoning block in view — which is where a leak would be.
    $answerOnly = $transcript -replace '(?m)^dsh: reasoning:[^\n]*\n(?:[^\n]+\n)*', ''
    $leaked = $answerOnly -match '｜{2,}\s*DSML|<｜{2,}\s*invoke|parameter name=\s*[｜|]'
    $ran = $transcript -match [regex]::Escape($name)
    $file = Join-Path $OutDir ("run-{0:d2}-{1}.log" -f $i, $(if ($ran -and -not $leaked) { 'ok' } else { 'bad' }))
    # The planted name goes into the file. Without it a saved failure cannot be re-read
    # against what was actually asked for, and a verdict of "the tool did not run" is
    # unfalsifiable: the transcript may well contain the name in a form the regex missed.
    @("# planted: $name", "# tool-ran: $ran", "# leaked: $leaked", '') + @($transcript) |
        Set-Content -Path $file -Encoding utf8

    $rows += [pscustomobject]@{ Run = $i; Ran = $ran; Leaked = $leaked; Bytes = $transcript.Length; File = $file }
    Write-Host ("  run {0}/{1}: tool-ran={2} leaked={3} bytes={4} -> {5}" -f $i, $Runs, $ran, $leaked, $transcript.Length, (Split-Path -Leaf $file))
    Remove-Item (Join-Path $work $name) -ErrorAction SilentlyContinue
}

Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue

$bad = @($rows | Where-Object { -not ($_.Ran -and -not $_.Leaked) })
Write-Host ''
Write-Host ("{0}/{1} good, {2} bad" -f ($Runs - $bad.Count), $Runs, $bad.Count)
foreach ($row in $bad) { Write-Host ("  bad run {0}: {1}" -f $row.Run, $row.File) }
Write-Host ''
$rows | Format-Table -AutoSize | Out-String | Write-Host
if ($bad.Count -eq 0) { exit 0 }
exit 1
