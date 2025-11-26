# Manual SSH Key Installation

Your SSH key has been created successfully! 
Now you need to manually copy it to your VPS.

## Your SSH Public Key

```
ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDQ1gBjQRz47eeSkhgWeUmDC37iKXQpCYRiuTpXtI5iheyasLpkjxArNAkyl5DST00IraW+fr1TWq/4hIIOHmUPSvZ4YPFILXwcWi+K067pUupuR3tcw3DLrU28mWzvdntLnCY/eBfLB30I2SeHy4fPJNseSJaFTXnXdhQJEXv2RWwU78FRVFN27zB2/S9+FnvJH7MCppixyoxpmpiPpkJhHdv/6MlIBj4HmhhnTGoMDYlZ977g0sotDFkU3v0jG4+8AtHoeovtO+hBE2FFypkl/CJhdGm0jWHKVFdYwCu9cAlKiy0fRd+CqH+YOEvN4WXxEqmohyV3s6RCO28Xx0OcXtXSxjyIQC5VkgfsV+XhQhIa5FBKOUKQv3OqvflyY3OmE2nHaQ4f05kP5VWgxvitpn2zXQbjdP4qpiiDggZFL2EIotvx4wa86V3F+5W+QpyIcb9diyOsVOfRpzprRhwxGMK8CLIbLYG1pxPV7jIgackwYlLmeeGGBcW5SBNtOEcXDlYXKq+rYt6VH8s98OxY8nvFpiwKpox0sbPFYJ6ooB6eCaazHJXNWnL2oDWG5d1vwubag6XT8bYVNnZwWXJypE8h90hAFwvKtZMMU1JHjVmYsUeCplcgNCJtJnPy/7DUlyrV3+YoSAyuo/LESeMgI779ZrveR4foXWLL4J4FTQ== barani@LAPTOP-40IJEQU1
```

## Installation Steps

### Option A: Using ssh-copy-id (Simplest)

Open **PowerShell** and run:

```powershell
# This will prompt for password once
type C:\Users\Barani\.ssh\id_rsa.pub | ssh root@147.79.66.33 "cat >> ~/.ssh/authorized_keys"
```

Password: `CSILDTjU+02TXhgQ)w'5`

### Option B: Manual Copy-Paste (If Option A fails)

1. **SSH into your VPS:**
   ```powershell
   ssh root@147.79.66.33
   ```
   Password: `CSILDTjU+02TXhgQ)w'5`

2. **Once connected, run these commands:**
   ```bash
   # Create .ssh directory if it doesn't exist
   mkdir -p ~/.ssh
   chmod 700 ~/.ssh
   
   # Open the authorized_keys file
   nano ~/.ssh/authorized_keys
   ```

3. **Copy the SSH public key above and paste it into nano**
   - Press `Ctrl+Shift+V` to paste
   - Press `Ctrl+X` to exit
   - Press `Y` to save
   - Press `Enter` to confirm

4. **Set correct permissions:**
   ```bash
   chmod 600 ~/.ssh/authorized_keys
   ```

5. **Exit SSH:**
   ```bash
   exit
   ```

## Test Passwordless Connection

After installation, test it:

```powershell
ssh root@147.79.66.33 "echo 'Success! Passwordless SSH works!'"
```

If this works **without asking for a password**, you're all set! ✅

## Next Steps

Once SSH key is installed, you can proceed with automated deployment:
1. Upload backend server
2. Restart PM2
3. Configure firewall
4. Test endpoints

All of this can now be automated! 🚀
