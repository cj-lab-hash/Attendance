# ChronoTrack Checker

Simple local site that shows a crew table and a Node endpoint to check ChronoTrack logs for employee IDs.

Quick start:

1. Install:

```bash
cd site
npm install
```

2. Set a ChronoTrack session cookie if the search pages require authentication:

On Windows PowerShell:

```powershell
$env:CHRONO_COOKIE = "PHPSESSID=...; other=..."
npm start
```

On Unix/macOS:

```bash
export CHRONO_COOKIE='PHPSESSID=...; other=...'
npm start
```

3. Open http://localhost:3000 in a browser and click "Check All".

Notes:
- The server implements a best-effort `checkEmployee` routine in `server.js` that attempts to find and submit the search form or do a simple GET with an `id` query parameter.
- If ChronoTrack requires a login, provide a valid session cookie via `CHRONO_COOKIE` or adjust `server.js` to perform programmatic login.
