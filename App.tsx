import { ChangeEvent, useEffect, useRef, useState } from "react";
import { Film, Upload, Sparkles, Download, Scissors, CheckCircle2, AlertTriangle, LoaderCircle, RotateCcw, Video, Clapperboard } from "lucide-react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

type Clip = { file: File; url: string; duration: number };
const CDN = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function formatSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function getDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => { const d = video.duration; URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
    video.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    video.src = url;
  });
}

// Fast, local highlight heuristic: score short windows by audio energy.
// This helps find lively moments, but it is not semantic AI and cannot know what a scene means.
async function findHighlightStart(file: File, duration: number, windowSeconds: number): Promise<number> {
  const fallback = Math.max(0, (duration - windowSeconds) / 2);
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return fallback;
    const context = new AudioContextClass();
    const bytes = await file.arrayBuffer();
    const audio = await context.decodeAudioData(bytes.slice(0));
    const channel = audio.getChannelData(0);
    const sampleRate = audio.sampleRate;
    const windowSize = Math.max(1, Math.floor(windowSeconds * sampleRate));
    const step = Math.max(1, Math.floor(sampleRate * 1.5));
    let bestStart = fallback;
    let bestScore = -1;
    for (let start = 0; start + Math.min(windowSize, channel.length) < channel.length; start += step) {
      const end = Math.min(channel.length, start + windowSize);
      let sum = 0;
      let peak = 0;
      // Sample at most ~5000 points per candidate for responsiveness.
      const stride = Math.max(1, Math.floor((end - start) / 5000));
      let count = 0;
      for (let i = start; i < end; i += stride) {
        const v = channel[i];
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
        count++;
      }
      const rms = Math.sqrt(sum / Math.max(1, count));
      const score = rms * 0.8 + peak * 0.2;
      if (score > bestScore) {
        bestScore = score;
        bestStart = start / sampleRate;
      }
    }
    await context.close();
    return Math.min(Math.max(0, duration - windowSeconds), bestStart);
  } catch {
    return fallback;
  }
}

export default function App() {
  const [clips, setClips] = useState<(Clip | null)[]>([null, null, null]);
  const [targetSeconds, setTargetSeconds] = useState(30);
  const [aspect, setAspect] = useState("9:16");
  const [quality, setQuality] = useState("1080");
  const [status, setStatus] = useState("Add three videos to get started.");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [resultUrl, setResultUrl] = useState("");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => () => {
    clips.forEach(c => c && URL.revokeObjectURL(c.url));
    if (resultUrl) URL.revokeObjectURL(resultUrl);
  }, [clips, resultUrl]);

  const loadedCount = clips.filter(Boolean).length;
  const totalDuration = clips.reduce((sum, c) => sum + (c?.duration || 0), 0);

  async function onFile(index: number, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name)) {
      setError("Please choose a video file (MP4, MOV, WebM, M4V, or MKV).");
      event.target.value = "";
      return;
    }
    if (file.size > 700 * 1024 * 1024) {
      setError("This browser-based version supports files up to 700 MB each. Smaller files work best.");
      event.target.value = "";
      return;
    }
    const duration = await getDuration(file);
    if (!duration) {
      setError("Could not read this video's duration. Try an MP4 or WebM file.");
      return;
    }
    setClips(prev => {
      const next = [...prev];
      if (next[index]) URL.revokeObjectURL(next[index]!.url);
      next[index] = { file, url: URL.createObjectURL(file), duration };
      return next;
    });
    if (resultUrl) { URL.revokeObjectURL(resultUrl); setResultUrl(""); }
    event.target.value = "";
  }

  async function loadEngine() {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;
    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => setLogs(prev => [...prev.slice(-5), message]));
    ffmpeg.on("progress", ({ progress: p }) => setProgress(Math.min(96, Math.max(3, Math.round(p * 90)))));
    setStatus("Loading video engine (first time can take a little longer)…");
    const coreURL = await toBlobURL(`${CDN}/ffmpeg-core.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${CDN}/ffmpeg-core.wasm`, "application/wasm");
    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegRef.current = ffmpeg;
    setFfmpegReady(true);
    return ffmpeg;
  }

  async function createMontage() {
    if (clips.some(c => !c)) {
      setError("Please upload all three videos first.");
      return;
    }
    setBusy(true); setError(""); setProgress(1); setLogs([]);
    if (resultUrl) { URL.revokeObjectURL(resultUrl); setResultUrl(""); }
    let ffmpeg: FFmpeg | null = null;
    try {
      ffmpeg = await loadEngine();
      const selected = clips as Clip[];
      setStatus("Preparing your three videos…");
      for (let i = 0; i < selected.length; i++) {
        await ffmpeg.writeFile(`input${i}.mp4`, await fetchFile(selected[i].file));
      }

      // Allocate runtime across all sources, then rank lively windows using local audio energy.
      // This is a heuristic, not semantic AI scene understanding.
      const eachTarget = targetSeconds / 3;
      setStatus("Finding lively moments from audio…");
      const segments: { start: number; length: number }[] = [];
      for (const clip of selected) {
        const length = Math.min(eachTarget, clip.duration);
        const start = await findHighlightStart(clip.file, clip.duration, length);
        segments.push({ start, length });
      }
      const w = aspect === "9:16" ? (quality === "source" ? 720 : Number(quality)) : (aspect === "16:9" ? (quality === "source" ? 1280 : Number(quality)) : (quality === "source" ? 720 : Number(quality)));
      const h = aspect === "9:16" ? Math.round(w * 16 / 9) : (aspect === "16:9" ? Math.round(w * 9 / 16) : Math.round(w * 9 / 16));
      const filter = aspect === "9:16"
        ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
        : aspect === "16:9"
          ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
          : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
      const concatFiles: string[] = [];
      for (let i = 0; i < selected.length; i++) {
        setStatus(`Cutting highlight ${i + 1} of 3…`);
        const seg = segments[i];
        const out = `part${i}.mp4`;
        const result = await ffmpeg.exec([
          "-ss", seg.start.toFixed(3), "-i", `input${i}.mp4`,
          "-t", seg.length.toFixed(3),
          "-vf", filter,
          "-r", "30",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "21",
          "-c:a", "aac", "-b:a", "128k", "-af", "loudnorm",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart",
          "-y", out
        ]);
        if (result !== 0) throw new Error(`FFmpeg could not process video ${i + 1}. Try a smaller MP4 file.`);
        concatFiles.push(out);
        setProgress(10 + Math.round(((i + 1) / 4) * 60));
      }
      setStatus("Joining clips into one MP4…");
      const list = concatFiles.map(f => `file '${f}'`).join("\n");
      await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(list));
      const mergeCode = await ffmpeg.exec([
        "-f", "concat", "-safe", "0", "-i", "concat.txt",
        "-c", "copy", "-movflags", "+faststart", "-y", "highlight-montage.mp4"
      ]);
      if (mergeCode !== 0) throw new Error("Could not merge the clips. Please try MP4 source files.");
      setStatus("Preparing download…"); setProgress(98);
      const data = await ffmpeg.readFile("highlight-montage.mp4");
      const blob = new Blob([data as BlobPart], { type: "video/mp4" });
      if (blob.size < 1000) throw new Error("The exported video appears empty. Please try different source files.");
      setResultUrl(URL.createObjectURL(blob));
      setProgress(100);
      setStatus("Your highlight montage is ready!");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong while editing.");
      setStatus("Editing failed. Check the message below and try again.");
    } finally {
      setBusy(false);
    }
  }

  function resetAll() {
    clips.forEach(c => c && URL.revokeObjectURL(c.url));
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setClips([null, null, null]); setResultUrl(""); setError(""); setProgress(0); setStatus("Add three videos to get started.");
  }

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="./"><span className="brand-mark"><Clapperboard size={22}/></span><span>ClipForge <b>AI</b></span></a>
      <div className="top-pill"><span className="live-dot"/> Free browser editor</div>
    </header>

    <section className="hero">
      <div className="eyebrow"><Sparkles size={15}/> THREE VIDEOS. ONE GREAT CLIP.</div>
      <h1>Your best moments,<br/><span>automatically combined.</span></h1>
      <p>Upload three videos. ClipForge scans audio for lively moments, cuts a segment from each, combines them, and exports one MP4 montage.</p>
      <div className="hero-tags"><span><CheckCircle2 size={15}/> No signup</span><span><CheckCircle2 size={15}/> Local audio scoring</span><span><CheckCircle2 size={15}/> MP4 download</span></div>
    </section>

    <section className="workspace">
      <div className="section-heading"><div><span className="step-label">STEP 01</span><h2>Upload your videos</h2></div><span className="count">{loadedCount}/3 uploaded</span></div>
      <div className="upload-grid">
        {clips.map((clip, i) => <div className={`upload-card ${clip ? "has-file" : ""}`} key={i}>
          <input ref={el => { inputRefs.current[i] = el; }} type="file" accept="video/*,.mkv,.m4v" onChange={e => void onFile(i, e)} hidden/>
          {clip ? <>
            <video className="source-preview" src={clip.url} controls preload="metadata"/>
            <div className="file-info"><div className="file-icon"><Film size={18}/></div><div className="file-text"><b>{clip.file.name}</b><span>{formatTime(clip.duration)} · {formatSize(clip.file.size)}</span></div></div>
            <button className="change-file" onClick={() => inputRefs.current[i]?.click()}>Replace</button>
          </> : <button className="upload-prompt" onClick={() => inputRefs.current[i]?.click()}>
            <span className="upload-icon"><Upload size={22}/></span><b>Video {i + 1}</b><span>Tap to upload</span><small>MP4 · MOV · WebM</small>
          </button>}
        </div>)}
      </div>

      <div className="section-heading settings-heading"><div><span className="step-label">STEP 02</span><h2>Choose your output</h2></div><span className="small-note">Simple by default</span></div>
      <div className="settings-grid">
        <label className="field"><span>Final video length</span><select value={targetSeconds} onChange={e => setTargetSeconds(Number(e.target.value))}><option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={60}>60 seconds</option><option value={90}>90 seconds</option></select></label>
        <label className="field"><span>Video format</span><select value={aspect} onChange={e => setAspect(e.target.value)}><option value="9:16">Vertical · TikTok / Reels</option><option value="16:9">Landscape · YouTube</option><option value="original">Fit source · no crop</option></select></label>
        <label className="field"><span>Output resolution</span><select value={quality} onChange={e => setQuality(e.target.value)}><option value="720">720p · faster</option><option value="1080">1080p · HD</option><option value="source">Standard · lighter</option></select></label>
      </div>

      <div className="action-panel">
        <div className="action-copy"><div className="action-icon"><Scissors size={21}/></div><div><b>Ready to create your montage?</b><span>{loadedCount === 3 ? `Source duration: ${formatTime(totalDuration)} · target: ${targetSeconds}s` : `Upload ${3 - loadedCount} more video${3 - loadedCount === 1 ? "" : "s"} to begin`}</span></div></div>
        <button className="primary-btn" disabled={busy || loadedCount !== 3} onClick={() => void createMontage()}>{busy ? <><LoaderCircle className="spin" size={18}/> Editing…</> : <><Sparkles size={18}/> Create highlight video</>}</button>
      </div>

      {(busy || progress > 0) && <div className="progress-box"><div className="progress-line"><span>{status}</span><b>{progress}%</b></div><div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }}/></div>{!ffmpegReady && busy && <small>On the first run, the browser downloads the video engine. Keep this tab open.</small>}</div>}
      {error && <div className="error-box"><AlertTriangle size={18}/><span>{error}</span></div>}

      {resultUrl && <section className="result-panel">
        <div className="result-heading"><span className="success-icon"><CheckCircle2 size={20}/></span><div><h2>Your montage is ready</h2><p>Three segments combined into one MP4 file.</p></div></div>
        <video className="result-video" src={resultUrl} controls playsInline/>
        <div className="result-actions"><a className="primary-btn download-btn" href={resultUrl} download="clipforge-highlight.mp4"><Download size={18}/> Download MP4</a><button className="secondary-btn" onClick={resetAll}><RotateCcw size={16}/> Start again</button></div>
      </section>}
    </section>

    <section className="notice"><AlertTriangle size={18}/><div><b>How highlight selection works</b><p>This version scores audio energy locally to find livelier segments, then cuts and merges them. Loud audio does not always mean a moment is important, so semantic AI highlight detection and automatic Urdu/English subtitles still require a transcription/analysis service. Editing does not remove copyright or guarantee that a video is copyright-free.</p></div></section>
    {logs.length > 0 && <details className="debug"><summary>Processing log</summary><pre>{logs.join("\n")}</pre></details>}
    <footer><span>ClipForge AI</span><span>Built for quick highlight montages</span></footer>
  </main>;
}