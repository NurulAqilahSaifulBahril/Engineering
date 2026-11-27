# Eternalgy O&M Dashboard

Generates Operation & Maintenance reports from bill and solar figures (key them in, or load a sample), with print / save as PDF.

## Install

Download `Eternalgy-OM-Dashboard-Setup-<version>.exe` from [Releases](https://github.com/NurulAqilahSaifulBahril/Engineering/releases/latest) and run it. The installed app checks for updates on launch (or Help → Check for Updates).

## Develop

```powershell
npm install
npm start          # run as a desktop app
npm run web        # or serve in the browser on http://localhost:5174 (set $env:PORT to change)
npm run dist       # build the installer into dist/
```

## Release

Bump `version` in `package.json`, commit, then tag and push:

```powershell
git tag v1.0.1
git push origin main v1.0.1
```

The **Release installer** GitHub Action builds the Windows installer and publishes it as a GitHub Release.
