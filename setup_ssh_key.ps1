# Setup SSH Key Authentication for VPS
# This eliminates the need for password entry

Write-Host "=== TingaTalk VPS SSH Key Setup ===" -ForegroundColor Cyan
Write-Host ""

# Check if SSH key exists
$sshKeyPath = "$env:USERPROFILE\.ssh\id_rsa"
if (-not (Test-Path $sshKeyPath)) {
    Write-Host "Creating new SSH key..." -ForegroundColor Yellow
    ssh-keygen -t rsa -b 4096 -f $sshKeyPath -N '""'
    Write-Host "✅ SSH key created at $sshKeyPath" -ForegroundColor Green
} else {
    Write-Host "✅ SSH key already exists at $sshKeyPath" -ForegroundColor Green
}

# Copy public key to VPS
Write-Host ""
Write-Host "Copying SSH key to VPS..." -ForegroundColor Yellow
Write-Host "You will be prompted for the VPS password: CSILDTjU+02TXhgQ)w'5" -ForegroundColor Cyan
Write-Host ""

$publicKey = Get-Content "$sshKeyPath.pub"
$command = "mkdir -p ~/.ssh && echo '$publicKey' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"

# This will prompt for password
ssh root@147.79.66.33 $command

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✅ SSH key successfully installed!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Test passwordless connection:" -ForegroundColor Cyan
    Write-Host "  ssh root@147.79.66.33 'echo Success'" -ForegroundColor White
} else {
    Write-Host ""
    Write-Host "❌ Failed to install SSH key" -ForegroundColor Red
    Write-Host "Please try manual setup or check VPS access" -ForegroundColor Yellow
}
