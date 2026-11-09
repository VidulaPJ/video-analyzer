\# Video Analyzer



A Windows desktop app that records and analyzes gaming clips from \*\*League of Legends\*\* (PC) and \*\*Wild Rift\*\*, then gives performance feedback and exports the best moments as ready-to-share highlight clips.



\## Features



\- \*\*One-click recording\*\*: launches OBS and starts/stops recording automatically

\- \*\*Game detection\*\*: detects when a supported game is running

\- \*\*Clip analysis\*\*: reviews a match clip and reports what went well and what could be improved

\- \*\*Ranked highlights\*\*: picks the top 3–5 moments from each clip

\- \*\*Flexible export\*\*: choose native or vertical framing at export time; each highlight is exported both with and without audio

\- \*\*Reports\*\*: saves the performance report as Word or PDF

\- \*\*Resource monitoring\*\*: tracks system usage while recording



\## Tech stack



\- \[Electron](https://www.electronjs.org/) (JavaScript) for the desktop app

\- \[OBS Studio](https://obsproject.com/) for recording

\- \[FFmpeg](https://ffmpeg.org/) for trimming and exporting clips

\- \[Tesseract OCR](https://github.com/tesseract-ocr/tesseract) for reading on-screen game text



\## Project structure



| File | Purpose |

|------|---------|

| `app/main.js` | Electron main process |

| `app/renderer.js`, `app/index.html` | App interface |

| `app/preload.js` | Bridge between interface and main process |

| `app/obs.js` | Controls OBS recording |

| `app/game.js`, `app/processes.js` | Detects running games |

| `app/analyze.js`, `app/end\_stats.js` | Clip and match analysis |

| `app/export.js` | Highlight clip export |

| `app/report.js`, `app/report\_export.js` | Performance reports (Word/PDF) |

| `app/resource\_monitor.js` | System resource tracking |

| `app/settings.json` | App settings |



\## Setup



\### Requirements

\- Windows 10/11

\- \[Node.js](https://nodejs.org/) (LTS version)

\- \[OBS Studio](https://obsproject.com/) with WebSocket enabled \[CHECK]

\- \[FFmpeg](https://ffmpeg.org/download.html)

\- Tesseract English language data: download `eng.traineddata` from \[tessdata](https://github.com/tesseract-ocr/tessdata) and place it in the project root



\### Install and run

```

cd app

npm install

npm start

```

\[CHECK: confirm the start command from package.json]



\### Build the Windows app

```

cd app

npm run build

```

\[CHECK: confirm the build command]



\## Roadmap



\- \[ ] \[CHECK: add features you still plan to build]

\- \[ ] \[CHECK]

\- \[ ] \[CHECK]



\## Status



Actively in development. Built as a personal project.

