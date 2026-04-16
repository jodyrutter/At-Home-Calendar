$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$modelfile = Join-Path $repoRoot "ai\hearthboard-assistant.Modelfile"
$assistantModel = "hearthboard-assistant"
$baseModel = "qwen2.5:7b"

if (-not (Test-Path -LiteralPath $modelfile)) {
  throw "Modelfile not found at $modelfile"
}

$ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaCommand) {
  throw "Ollama is not installed or not on PATH. Install it from https://ollama.com/download/windows and rerun this script."
}

Write-Host "Pulling $baseModel..."
& $ollamaCommand.Source pull $baseModel
if ($LASTEXITCODE -ne 0) {
  throw "ollama pull failed."
}

Write-Host "Creating $assistantModel from $modelfile..."
& $ollamaCommand.Source create $assistantModel -f $modelfile
if ($LASTEXITCODE -ne 0) {
  throw "ollama create failed."
}

Write-Host ""
Write-Host "Hearthboard local AI is ready."
Write-Host "You can verify it with:"
Write-Host "  ollama list"
Write-Host "  curl http://localhost:11434/api/tags"
