# Operation & Maintenance Dashboard

Generates O&M reports from bill and solar figures (key them in, or load a sample), with print / save as PDF.

## Run locally

```powershell
$env:PORT=4425; node server.js
```

Then open http://localhost:4425. Without `PORT` it listens on 5174.
