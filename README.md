# Wi-Fi Endoscope Viewer

A local desktop viewer for Wi-Fi endoscope cameras that stream JPEG frames over a private Wi-Fi network. The app is designed for cameras that create an open SSID similar to `HNDEC_55-XXXXXX` and use a local gateway such as `192.168.1.1`.

This project includes only independent source code, custom SVG artwork, and local launcher scripts. It does not include browser profiles, logs, packaged mobile apps, or device-specific private data.

## Features

- Live camera preview from supported Wi-Fi endoscope devices
- Automatic scan for UDP JPEG, MJPEG, HTTP, and RTSP-style endpoints
- 0-360 degree auto-rotation from camera sensor packets when available
- Manual calibration, reverse direction, mirror, snapshot, and WebM recording
- Local-only server bound to `127.0.0.1`
- No cloud service and no external account required

## Requirements

- Node.js 18 or newer
- A laptop with Wi-Fi
- A supported Wi-Fi endoscope camera
- Windows, macOS, or Linux

Automatic Wi-Fi connection from the app is available on Windows. On macOS and Linux, connect to the camera Wi-Fi manually first, then use Scan.

## Quick Start

1. Install Node.js LTS from https://nodejs.org.
2. Turn on the endoscope camera.
3. Connect the laptop to the camera Wi-Fi. The SSID usually looks like `HNDEC_55-XXXXXX`.
4. Start the app:
   - Windows: double-click `start.bat`
   - PowerShell: run `.\start.ps1`
   - macOS/Linux/Git Bash: run `bash start.bash`
   - Any OS: run `node server.js`, then open `http://127.0.0.1:47855/`
5. Open Settings.
6. Press Scan camera.
7. If the image is not upright, press Calibrate upright.
8. If the rotation direction is reversed, press Reverse direction.

## Configuration

The default SSID pattern is `HNDEC_55-XXXXXX`. If a device uses a different SSID, set `CAMERA_SSID` before starting:

```powershell
$env:CAMERA_SSID="YOUR_CAMERA_SSID"
.\start.ps1
```

```bash
CAMERA_SSID="YOUR_CAMERA_SSID" bash start.bash
```

The default local port is `47855`. To change it:

```powershell
$env:PORT="48000"
.\start.ps1
```

```bash
PORT="48000" bash start.bash
```

## Privacy

The server only listens on `127.0.0.1`, so it is accessible from the local laptop only. The private IPs used by the camera, such as `192.168.1.1`, are local network addresses and are not public internet addresses.

## Repository Safety

Only upload the source files in this folder. Do not upload runtime files such as browser profiles, process IDs, logs, packaged mobile apps, or analysis output.

Recommended upload contents:

- `server.js`
- `public/`
- `README.md`
- `start.bat`
- `start.bash`
- `start.ps1`
- `.gitignore`

## Notes

This is an independent local viewer for compatible Wi-Fi endoscope devices. It uses generic network behavior observed from supported camera hardware and does not require any original mobile application files.
