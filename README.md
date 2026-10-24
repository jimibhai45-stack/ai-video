# ClipForge AI — 3-video highlight montage maker

A GitHub-ready React + Vite starter app. Upload three videos, choose a target length and format, then the app cuts a segment from each source and combines them into one MP4 using FFmpeg.wasm in your browser.

## Important current limitation

This version implements **real browser-side video cutting and merging** and scores short audio windows locally to select livelier moments. Audio energy is only a heuristic: it does **not semantically understand what is happening** and may select loud noise rather than the most meaningful moment. For semantic AI highlight detection and Urdu/English subtitles, add a transcription/scene-analysis backend and select timestamped segments from its results.

Browser-based video processing can be memory-intensive. Start with short MP4 videos and a modern desktop browser. The first run downloads FFmpeg assets from a CDN. GitHub Pages hosts the frontend; it does not provide a private backend or AI compute.

## Run locally

Install Node.js 20 or later, then:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Build and test production bundle

```bash
npm run build
npm run preview
```

## Deploy to GitHub Pages

1. Create a new GitHub repository, for example `clipforge-ai`.
2. Upload all project files and folders from this project to the repository root. Do not upload `node_modules`.
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment**, select **GitHub Actions** as the source.
5. The workflow in `.github/workflows/deploy.yml` installs dependencies, builds the app, and deploys `dist/`.
6. Open the Actions tab and wait for the Pages deployment workflow to finish. Your site URL will be shown in the workflow summary and Pages settings.

The Vite `base: "./"` setting supports repository subpaths on GitHub Pages.

## How it works

- File metadata and previews are handled in the browser.
- FFmpeg.wasm is lazy-loaded only when the user starts editing.
- The app scores audio energy in short windows to choose livelier moments from each source video.
- It cuts a segment from each of the three videos, normalizes audio, scales/crops to the selected format, then merges the segments into an MP4.
- Files are processed locally in the browser after the FFmpeg core has loaded. The app does not upload videos to an AI provider.
- Semantic scene understanding and automatic Urdu/English subtitles are not implemented. They require a speech-to-text and highlight-analysis pipeline.

## Copyright note

Editing a video does not remove copyright and cannot guarantee that a platform will not make a claim. Only use source videos and audio you own or are authorized to use.

## Troubleshooting

- **First run is slow:** FFmpeg core and WebAssembly files must load from the CDN. Later loads may be cached by your browser.
- **Out of memory:** use shorter or smaller source videos, or add a server-side FFmpeg worker for large files.
- **Codec errors:** try converting the source files to MP4 (H.264 video + AAC audio).
- **GitHub Pages build:** check the Actions tab for errors and ensure Pages is set to GitHub Actions.
