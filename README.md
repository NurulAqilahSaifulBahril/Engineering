# Eternalgy O&M Dashboard

The Engineering department's desktop app for operation & maintenance and engineering records: site issues and technician visits, rectification and solar saving reports, drawings, load profile jobs, O&M manuals, T&C reports, and summary exports.

**Install & update guide (3 pages):** [docs/Eternalgy-OM-Dashboard-User-Guide.pdf](docs/Eternalgy-OM-Dashboard-User-Guide.pdf), also attached to each release. **Full manual** (every screen): [docs/Eternalgy-OM-Dashboard-Full-Manual.pdf](docs/Eternalgy-OM-Dashboard-Full-Manual.pdf).

## Install

Download `Eternalgy-OM-Dashboard-Setup-<version>.exe` from [Releases](https://github.com/NurulAqilahSaifulBahril/Engineering/releases/latest) and run it. The installed app checks for updates on launch (or Help → Check for Updates).

## Shared data (NUrul_DB)

Connected PCs share every record through NUrul_DB, in two tables the app creates and owns: `public.om_docs` (one row per record) and `public.om_blobs` (pictures). It never touches any other table.

The release build bundles the key into the installer from GitHub Actions secrets `NURUL_PG_PROXY_URL`, `NURUL_PG_PROXY_DATABASE` and `NURUL_PG_PROXY_TOKEN` (Settings → Secrets and variables → Actions), so installed PCs connect with no setup. The workflow checks the keys connect before it builds. Local builds (`npm run dist`) take them from `.env` in this folder or the one above; without one the build has no key and PCs save locally.

A PC can still use a different connection file via **File → Database Connection…**. The key is only used in the Electron main process (`om-db.js`); the page reaches the database through a fixed set of operations, never raw SQL.

> **Note:** this repo and its releases are public, so anyone who downloads the installer can read the bundled key, which has full access to NUrul_DB. Making the repo private and rotating the key is recommended.

## Develop

```powershell
npm install
npm start          # run as a desktop app
npm run web        # or serve in the browser on http://localhost:5174 (set $env:PORT to change)
npm run dist       # build the installer into dist/
npm run guide      # rebuild both PDFs: guide.src.html (install & update) and manual.src.html (full manual)
```

`index.html` is the whole dashboard and also runs inside Claude. In the desktop app, `om-shim.js` (added to the page by `main.js`) stands in for the Claude runtime's `db`, `user` and `assets` services and backs them with NUrul_DB.

## Release

Bump `version` in `package.json`, commit, then tag and push:

```powershell
git tag v1.1.1
git push origin main v1.1.1
```

The **Release installer** GitHub Action builds the Windows installer and publishes it, with the user guide, as a GitHub Release.
