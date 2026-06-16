param(
    [string]$Path = "$HOME\Documents\PowerShell\shared-profile.ps1"
)

$content = Get-Content -LiteralPath $Path -Raw

$helper = @'
function Start-CodexSession {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Args
    )

    [Console]::Out.Write($stopWeirdChars)

    if ($env:CODEX_PROFILE -and $env:CODEX_PROFILE.Trim()) {
        codex --profile $env:CODEX_PROFILE @Args
    } else {
        codex --profile auto @Args
    }

    [Console]::Out.Write($stopWeirdChars)
}
'@

if ($content -notmatch 'function Start-CodexSession\s*\{') {
    $needle = '$stopWeirdChars = "$([char]27)[?1004l$([char]27)[?2004l$([char]27)[?1000l$([char]27)[?1002l$([char]27)[?1003l$([char]27)[?1005l$([char]27)[?1006l"'
    if ($content.Contains($needle)) {
        $content = $content.Replace($needle, "$needle`r`n`r`n$helper")
    } else {
        throw "Could not find stopWeirdChars line in $Path"
    }
}

$replacements = @(
    @{
        Old = @'
function cod {
    [Console]::Out.Write($stopWeirdChars)
    codex -a never
    [Console]::Out.Write($stopWeirdChars)
}
'@
        New = @'
function cod {
    Start-CodexSession @args
}
'@
    },
    @{
        Old = @'
function casco {
    Set-Location 'C:\foo\casabio-expedition-planner'
    .\stopweirdchars.ps1
    codex -a never
    .\stopweirdchars.ps1
}
'@
        New = @'
function casco {
    Set-Location 'C:\foo\casabio-expedition-planner'
    Start-CodexSession @args
}
'@
    },
    @{
        Old = @'
function fuco {
    Set-Location 'C:\Foo\filenameupdate2'
    [Console]::Out.Write($stopWeirdChars)
    codex -a never
    [Console]::Out.Write($stopWeirdChars)
}
'@
        New = @'
function fuco {
    Set-Location 'C:\Foo\filenameupdate2'
    Start-CodexSession @args
}
'@
    },
    @{
        Old = @'
function snapco {
    Set-Location 'C:\Users\User\AndroidStudioProjects\CplusplusTest'
    .\stopweirdchars.ps1
    codex -a never
    .\stopweirdchars.ps1
}
'@
        New = @'
function snapco {
    Set-Location 'C:\Users\User\AndroidStudioProjects\CplusplusTest'
    Start-CodexSession @args
}
'@
    },
    @{
        Old = @'
function agtco {
    Set-Location 'C:\foo\agentick'
    .\stopweirdchars.ps1
    codex -a never
    .\stopweirdchars.ps1
}
'@
        New = @'
function agtco {
    Set-Location 'C:\foo\agentick'
    Start-CodexSession @args
}
'@
    },
    @{
        Old = @'
function etyco {
    Set-Location 'C:\Foo\Etymologies'
    .\stopweirdchars.ps1
    codex -a never
    .\stopweirdchars.ps1
}
'@
        New = @'
function etyco {
    Set-Location 'C:\Foo\Etymologies'
    Start-CodexSession @args
}
'@
    },
    @{
        Old = @'
function wasmco {
    Set-Location 'C:\Foo\raw-converter-wasm'
    [Console]::Out.Write($stopWeirdChars)
    codex -a never
    [Console]::Out.Write($stopWeirdChars)
}
'@
        New = @'
function wasmco {
    Set-Location 'C:\Foo\raw-converter-wasm'
    Start-CodexSession @args
}
'@
    }
)

foreach ($replacement in $replacements) {
    if ($content.Contains($replacement.Old)) {
        $content = $content.Replace($replacement.Old, $replacement.New)
    }
}

Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
Write-Host "Patched $Path"
