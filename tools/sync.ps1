<#
.SYNOPSIS
    Copy dsh-agent-bridge into a DSH profile and install it there.

.DESCRIPTION
    A DSH profile loads a plugin from its own `plugins/` directory, not from
    wherever the source lives. Editing the source therefore does nothing until the
    change is copied across — and pnpm's `file:` dependency hard-links the copied
    files, so an edit made after the copy does not reach the profile either.

    This script does the copy and the install in one step, and refuses to run if
    the profile's manifest does not actually list the plugin, because a copy alone
    changes nothing.

    The DSH desktop application manages its own profile, so it has to be restarted
    after this script runs.

.PARAMETER Profile
    The profile name under `$env:USERPROFILE\.dsh\profiles`. Defaults to `desktop`.

.PARAMETER Source
    The plugin source directory. Defaults to the parent of this script.

.EXAMPLE
    .\tools\sync.ps1
    .\tools\sync.ps1 -Profile bridgecheck2
#>
[CmdletBinding()]
param(
    [string] $Profile = 'desktop',
    [string] $Source = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'Stop'

$profileRoot = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path $profileRoot)) {
    throw "Profile '$Profile' does not exist at $profileRoot."
}
if (-not (Test-Path (Join-Path $Source 'package.json'))) {
    throw "No package.json under $Source - is that the plugin root?"
}

# The manifest is what makes the profile *load* the plugin. A copy without it
# produces a plugin directory that nothing ever reads, which is the single most
# confusing outcome this script exists to prevent.
$manifestPath = Join-Path $profileRoot 'package.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($manifest.dsh.profile.bundles -notcontains 'dsh-agent-bridge') {
    throw @"
Profile '$Profile' does not list dsh-agent-bridge in dsh.profile.bundles.

Add it by hand, then re-run this script:

  "dependencies": {
    "dsh-agent-bridge": "file:./plugins/dsh-agent-bridge"
  },
  "dsh": { "profile": { "bundles": [ ..., "dsh-agent-bridge" ] } }

Do not add it if another plugin in this profile already serves one of the same
vendors: DSH accepts one adapter per provider id, so the second registration is
rejected. (This plugin degrades that vendor to "not offered" and keeps the rest.)
"@
}

# robocopy with the two things it does not do for you:
#
#   1. **Success is not zero.** It exits 1..7 for "copied something", 0 for "nothing
#      to do", and only >= 8 is a real failure. Treating a non-zero code as failure
#      would fail on every run that actually copied a file.
#   2. **It can lose a race with the installer.** pnpm has just rewritten the very
#      directory being mirrored, and a file still in `delete pending` makes robocopy
#      give up with 16 — intermittently, which is the worst kind of failure to see
#      once. So the mirror is retried a couple of times before it is believed.
#
# `$LASTEXITCODE` is cleared on the way out: PowerShell exits with the last native
# exit code, and leaving a 3 behind makes a successful run look failed to any
# caller that checks the status.
function Invoke-Robocopy {
    param(
        [Parameter(Mandatory)] [string] $From,
        [Parameter(Mandatory)] [string] $To,
        [Parameter(Mandatory)] [string[]] $Exclude,
        [switch] $Mirror
    )
    $arguments = @($From, $To)
    $arguments += if ($Mirror) { '/MIR' } else { '/E' }
    $arguments += '/XD'
    $arguments += $Exclude
    $arguments += @('/NFL', '/NDL', '/NJH', '/NJS', '/NP')

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $global:LASTEXITCODE = 0
        & robocopy @arguments | Out-Null
        $code = $LASTEXITCODE
        if ($code -lt 8) { break }
        if ($attempt -lt 3) {
            Write-Host "robocopy reported $code; letting the installer settle and retrying ($attempt/3)"
            Start-Sleep -Milliseconds 500
        }
    }
    $global:LASTEXITCODE = 0
    if ($code -ge 8) { throw "robocopy $From -> $To failed with exit code $code after 3 attempts" }
    return $code
}

$target = Join-Path $profileRoot 'plugins\dsh-agent-bridge'
Write-Host "Copying $Source -> $target"
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Path $target -Force | Out-Null

# `_scratch`, `_probe`, `_handover`, `out` and `node_modules` are development-only:
# scratch probes, the one-off protocol probes with their captured snapshots, the
# original construction material this plugin was built from, the preview pages and
# screenshots the probe renders, and the local package stub used by the integration
# harness. None of them belongs in a profile.
Invoke-Robocopy -From $Source -To $target -Exclude @('_scratch', '_probe', '_handover', 'out', 'node_modules', '.git') | Out-Null

# Verify the exclusion rather than trusting it. The stub under `node_modules` mirrors
# `@deepseek-ai/dsh-llm` so the integration harness can import the plugin outside DSH;
# if it were ever copied in, it would shadow the real package inside the profile and
# the plugin would run against a stand-in with the same name. That failure would look
# like a harness bug rather than a packaging one, so it is checked here by name.
$leakedStub = Join-Path $target 'node_modules\@deepseek-ai\dsh-llm'
if (Test-Path $leakedStub) {
    Remove-Item (Join-Path $target 'node_modules') -Recurse -Force
    throw @"
The development stub at node_modules\@deepseek-ai\dsh-llm was copied into the profile
and has been removed. It must never ship: it shadows the real package that DSH provides.

Check that the robocopy /XD list above still contains `node_modules`, then re-run.
"@
}

# pnpm, in the order that produces the fewest surprises:
#
#   1. the copy bundled with the desktop app — the same one the app installs its
#      own profile with, so the lockfile it writes matches what the app expects;
#   2. a machine-wide pnpm on PATH;
#   3. nothing, in which case say so instead of failing halfway through a copy.
#
# The desktop app is not in a fixed place: it is a portable extract for some users
# and a per-user install for others. So the bundled copy is looked for through one
# override and a short list of usual roots rather than being assumed.
$candidates = @()
if ($env:DSH_DESKTOP_DIR) { $candidates += (Join-Path $env:DSH_DESKTOP_DIR 'resources\runtime\pnpm\bin\pnpm.cjs') }
foreach ($root in @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness'),
    (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness'),
    'D:\CodeEditor\DeepSeek Harness',
    'C:\CodeEditor\DeepSeek Harness'
)) {
    if ($root) { $candidates += (Join-Path $root 'resources\runtime\pnpm\bin\pnpm.cjs') }
}

$pnpm = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$viaBundled = $null -ne $pnpm
if (-not $viaBundled) {
    $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
}
if (-not $pnpm) {
    throw @"
pnpm was not found.

Looked for the copy bundled with the DSH desktop app under: $($candidates -join ', ')
and for `pnpm` on PATH.

Either add pnpm to PATH (npm install -g pnpm), or point this script at the app:

    `$env:DSH_DESKTOP_DIR = '<the folder that contains resources\runtime>'; .\tools\sync.ps1
"@
}
Write-Host "Using pnpm: $pnpm$(if ($viaBundled) { ' (bundled with the desktop app)' } else { ' (from PATH)' })"

Write-Host "Installing dependencies in $profileRoot"
Push-Location $profileRoot
try {
    & node $pnpm install --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

if (-not (Test-Path (Join-Path $profileRoot 'node_modules\dsh-agent-bridge'))) {
    throw 'The install finished but node_modules\dsh-agent-bridge is missing; the dependency did not resolve.'
}

# The copy under `node_modules` is the one the *loader* actually resolves: the
# profile's dependency is `file:./plugins/dsh-agent-bridge`, so pnpm materialises
# its own copy there and the entry name `dsh-agent-bridge` resolves to it, not to
# `plugins/`. pnpm calls the tree "already up to date" no matter how the source
# changed, so without the mirror below a profile keeps running whatever was
# installed the first time — which is indistinguishable, from the GUI, from the
# edit having done nothing at all. Mirror the source across and then prove the two
# agree; a stale runtime copy is the one failure this script must never report as
# success.
$runtime = Join-Path $profileRoot 'node_modules\dsh-agent-bridge'
Write-Host "Mirroring $target -> $runtime"
Invoke-Robocopy -From $target -To $runtime -Exclude @('node_modules', '.git') -Mirror | Out-Null

# Every file the loader can reach, not a sample. A stale copy of one driver file is
# as bad as a stale copy of the entry point, and the mirror above is the only thing
# that can differ; comparing all of them is cheap and answers the real question.
$compared = 0
foreach ($file in Get-ChildItem $target -Recurse -File) {
    $relative = $file.FullName.Substring($target.Length).TrimStart('\')
    if ($relative -like 'node_modules\*') { continue }
    $to = Join-Path $runtime $relative
    if (-not (Test-Path $to)) { throw "The loader copy is missing $relative; the mirror did not take." }
    if ((Get-FileHash $file.FullName).Hash -ne (Get-FileHash $to).Hash) {
        throw "The loader copy of $relative differs from the source; the runtime would load stale code."
    }
    $compared++
}

Write-Host ''
Write-Host "dsh-agent-bridge is installed in profile '$Profile' ($compared files verified)." -ForegroundColor Green
Write-Host 'Restart the DSH desktop application to load it.'

# Success is the exit status too, not just the last log line.
exit 0
