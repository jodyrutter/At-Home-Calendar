# Crash Stabilization Checklist

Detected on this PC on 2026-04-10:

- Motherboard: MSI MPG Z490 GAMING EDGE WIFI (MS-7C79)
- BIOS: 1.C0, released 2022-06-09
- CPU: Intel Core i9-10900K
- GPU: NVIDIA GeForce RTX 5060 Ti
- NVIDIA driver installed: 32.0.15.9186
- RAM: 64 GB (4 x 16 GB G.Skill F4-3200C16-16GVK)
- Current RAM speed: 2133 MT/s
- Power plan: Balanced

What was changed already:

- Disabled Overwolf from Windows startup
- Added `league-stable-mode.ps1` to stop common overlays/background apps before League

Do these in order:

1. Update the motherboard BIOS from MSI support for the exact board above.
2. After the BIOS update, load BIOS defaults once.
3. Keep CPU settings fully stock:
   - no CPU overclock
   - no undervolt
   - no MSI Game Boost
   - no Multi Core Enhancement / Enhanced Turbo
4. Leave RAM at stock first.
5. Test stability for a few days before turning XMP back on.
6. Download the NVIDIA driver directly from NVIDIA, not Windows Update.
7. During the NVIDIA install, choose a clean install if the installer offers it.
8. Keep Overwolf disabled while testing.
9. Avoid running Parsec during testing unless you need it.
10. Run this before League:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\league-stable-mode.ps1"
```

If you are not using Parsec for that session:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\league-stable-mode.ps1" -StopParsec
```

If crashes still happen after BIOS update and stock settings:

1. Run MemTest86 overnight.
2. Run a CPU stability test at stock settings.
3. If WHEA errors continue at stock, suspect CPU, motherboard, or power delivery before blaming the GPU driver.
