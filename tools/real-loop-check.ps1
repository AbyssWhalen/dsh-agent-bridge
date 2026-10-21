# Prove the bridge works inside a real DSH agent loop, not just at driver level.
#
# Every other test in this project drives a driver directly, which leaves one gap: the
# host's own message shapes, its tool dispatching, and its projection of history are not
# exercised. That gap is not theoretical — the letterless-delimiter defect (the model
# writing `<｜｜｜｜｜invoke …>` with no `DSML`) only appeared inside a real agent loop,
# because only there does the system prompt push the model to use tools at all.
#
# What is proven, per run:
#   - the tool *ran*: a file with an unguessable token in its name is planted, and the
#     token has to come back in the transcript, which is only possible if the call
#     executed and its output was fed back;
#   - no call markup reached the transcript, which is the visible half of the defect.
#
# Both are required. A run with no markup can simply mean the model never wrote an
# envelope, and a run with the right answer can still have leaked bars beside it.
#
# Prerequisites: an isolated DSH_HOME with this plugin bundled into a profile. Point the
# parameters at it, or copy the setup from docs/verification.md §十.
#
#   pwsh -File tools/real-loop-check.ps1 -Profile e2e -Runs 5 -Provider qoder
#
# Exit code 0 only when every run passed both checks.

param(
    [string]$Profile = 'e2e',
    [int]$Runs = 5,
    [ValidateSet('workbuddy', 'qoder')]
    [string]$Provider = 'qoder',
    [string]$Model = 'qmodel_38max',
    [string]$DshHome = "$env:USERPROFILE\.dsh",
    [string]$DshBin = '',
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

if ($DshBin -eq '') {
    # Inside the desktop app the CLI ships beside the resources directory.
    # `@(…)` is load-bearing: `Where-Object` on a one-item result returns a bare string,
    # and indexing a string yields its first character — `node D` — which fails in a way
    # that reads as "the tool never ran".
    $candidates = @(
        @(
            'D:\CodeEditor\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
        ) | Where-Object { Test-Path -LiteralPath $_ }
    )
    if ($candidates.Count -eq 0) {
        Write-Host 'real loop: cannot find the dsh CLI; pass -DshBin'
        exit 2
    }
    $DshBin = $candidates[0]
}

if ($OutDir -eq '') {
    # Under the working directory, not the system temp: DSH's file policy governs what
    # the agent's own tools may touch, and a planted file the tool cannot see makes every
    # run look like "the tool did not run".
    $OutDir = Join-Path (Get-Location) '.real-loop'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$work = Join-Path $OutDir 'work'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null

# The provider is chosen with a patch overlay rather than by rewriting the profile, so
# one profile can be booted against either vendor and nothing is left behind.
$overlay = Join-Path $OutDir 'provider.yml'
@"
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: $Provider
    model: $Model
"@ | Set-Content -Path $overlay -Encoding utf8

$env:DSH_HOME = $DshHome
$prompt = 'Run the pwsh tool to list the files in the current directory, then report their exact names.'

$ok = 0
$leakedRuns = 0
$missedRuns = 0

for ($i = 1; $i -le $Runs; $i++) {
    $token = -join ((48..57) + (97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
    $name = "tok-$token.txt"
    Set-Content -Path (Join-Path $work $name) -Value "T=$token"

    Push-Location $work
    try {
        $transcript = (& node $DshBin --profile $Profile --patch $overlay headless $prompt 2>&1) -join "`n"
    }
    finally {
        Pop-Location
    }

    # Two independent signals. Markup anywhere is a leak; the token is proof of execution.
    $leaked = $transcript -match 'invoke|parameter name=|｜{2,}'
    $ran = $transcript -match [regex]::Escape($name)

    if ($leaked) { $leakedRuns++ }
    if (-not $ran) { $missedRuns++ }
    if ($ran -and -not $leaked) { $ok++ }

    Write-Host ("  run {0}/{1} [{2}]: tool-ran={3} leaked-markup={4}" -f $i, $Runs, $Provider, $ran, $leaked)

    Remove-Item (Join-Path $work $name) -ErrorAction SilentlyContinue
}

Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $OutDir) {
    # Only the scratch directory this script made is removed.
    $left = Get-ChildItem -LiteralPath $OutDir -Force -ErrorAction SilentlyContinue
    if (-not $left -or @($left).Count -eq 0) { Remove-Item -LiteralPath $OutDir -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host ("real loop [{0}]: {1}/{2} clean, {3} leaked markup, {4} did not run the tool" -f `
    $Provider, $ok, $Runs, $leakedRuns, $missedRuns)

if ($ok -eq $Runs) { exit 0 }
exit 1
