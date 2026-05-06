const state = {
  audioFile: null,
  audioUrl: "",
  audioDuration: 0,
  transcriptText: "",
  wordChunks: [],
  subtitles: [],
  transcriber: null,
  ffmpeg: null,
  previewRafId: 0,
  downloadUrl: "",
};

const els = {
  audioFile: document.getElementById("audio-file"),
  fileName: document.getElementById("file-name"),
  audioDuration: document.getElementById("audio-duration"),
  fontSize: document.getElementById("font-size"),
  fontSizeValue: document.getElementById("font-size-value"),
  bottomPadding: document.getElementById("bottom-padding"),
  bottomPaddingValue: document.getElementById("bottom-padding-value"),
  wordsPerLine: document.getElementById("words-per-line"),
  wordsPerLineValue: document.getElementById("words-per-line-value"),
  transcribeButton: document.getElementById("transcribe-button"),
  previewButton: document.getElementById("preview-button"),
  exportButton: document.getElementById("export-button"),
  previewExportButton: document.getElementById("preview-export-button"),
  downloadSrtButton: document.getElementById("download-srt-button"),
  statusText: document.getElementById("status-text"),
  progressBar: document.getElementById("progress-bar"),
  previewCanvas: document.getElementById("preview-canvas"),
  previewClock: document.getElementById("preview-clock"),
  previewAudio: document.getElementById("preview-audio"),
  transcriptOutput: document.getElementById("transcript-output"),
  segmentCount: document.getElementById("segment-count"),
  downloadPanel: document.getElementById("download-panel"),
  downloadLink: document.getElementById("download-link"),
  downloadFileName: document.getElementById("download-file-name"),
  downloadHint: document.getElementById("download-hint"),
  hideDownloadPanel: document.getElementById("hide-download-panel"),
};

const ctx = els.previewCanvas.getContext("2d");

if (els.previewAudio.controlsList) {
  els.previewAudio.controlsList.add("nodownload");
  els.previewAudio.controlsList.add("noremoteplayback");
}

function setStatus(message, progress = null) {
  els.statusText.textContent = message;
  if (progress === null) {
    els.progressBar.style.width = "0%";
    return;
  }

  const clamped = Math.max(0, Math.min(100, progress));
  els.progressBar.style.width = `${clamped}%`;
}

function updateSliderLabels() {
  els.fontSizeValue.textContent = `${els.fontSize.value}px`;
  els.bottomPaddingValue.textContent = `${els.bottomPadding.value}px`;
  els.wordsPerLineValue.textContent = els.wordsPerLine.value;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "00:00";
  }

  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const secs = (total % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function blobToObjectUrl(blob) {
  return URL.createObjectURL(blob);
}

function outputBaseName() {
  const fallback = "green-screen-subtitles";
  const name = state.audioFile?.name ?? fallback;
  return name.replace(/\.[^/.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || fallback;
}

async function decodeAudio(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();

  try {
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const mono = new Float32Array(decoded.length);

    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < decoded.length; i += 1) {
        mono[i] += data[i] / decoded.numberOfChannels;
      }
    }

    return {
      data: resampleAudio(mono, decoded.sampleRate, 16000),
      duration: decoded.duration,
      sampleRate: 16000,
    };
  } finally {
    await audioContext.close();
  }
}

function resampleAudio(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    return input;
  }

  const ratio = sourceRate / targetRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const sourceIndex = i * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, input.length - 1);
    const weight = sourceIndex - before;
    output[i] = input[before] * (1 - weight) + input[after] * weight;
  }

  return output;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function buildSubtitleSegments(chunks, maxWordsPerCard) {
  const cards = [];
  let current = null;

  for (const chunk of chunks ?? []) {
    const text = normalizeWhitespace(chunk.text ?? "");
    const [rawStart, rawEnd] = chunk.timestamp ?? [];
    if (!text || !Number.isFinite(rawStart)) {
      continue;
    }

    const start = Math.max(0, rawStart);
    const end = Number.isFinite(rawEnd) ? rawEnd : start + 0.8;
    const wordCount = text.split(" ").length;

    if (
      !current ||
      current.words + wordCount > maxWordsPerCard ||
      start - current.end > 0.35 ||
      end - current.start > 3.4
    ) {
      current = {
        start,
        end,
        text,
        words: wordCount,
      };
      cards.push(current);
      continue;
    }

    current.text = `${current.text} ${text}`;
    current.end = end;
    current.words += wordCount;
  }

  return cards.map(({ start, end, text }) => ({
    start,
    end,
    text: normalizeWhitespace(text),
  }));
}

function getTimestampBounds(chunk, fallbackDuration) {
  const timestamp = chunk?.timestamp;
  let start = null;
  let end = null;

  if (Array.isArray(timestamp)) {
    [start, end] = timestamp;
  } else if (timestamp && typeof timestamp === "object") {
    start = timestamp.start ?? timestamp[0] ?? null;
    end = timestamp.end ?? timestamp[1] ?? null;
  }

  if (!Number.isFinite(start)) {
    return null;
  }

  const maxDuration = Number.isFinite(fallbackDuration) ? fallbackDuration : null;
  const safeStart = Math.max(0, Number(start));
  if (maxDuration !== null && safeStart >= maxDuration) {
    return null;
  }

  const rawEnd = Number.isFinite(end) ? Number(end) : safeStart + 0.8;
  const safeEnd = Math.max(safeStart + 0.05, rawEnd);

  return {
    start: safeStart,
    end: maxDuration === null ? safeEnd : Math.min(maxDuration, safeEnd),
  };
}

function sanitizeChunks(chunks, fallbackDuration) {
  return (chunks ?? [])
    .map((chunk) => {
      const bounds = getTimestampBounds(chunk, fallbackDuration);
      const text = normalizeWhitespace(chunk?.text ?? "");

      if (!bounds || !text) {
        return null;
      }

      return {
        text,
        timestamp: [bounds.start, bounds.end],
      };
    })
    .filter(Boolean);
}

function buildApproximateChunks(text, duration) {
  const words = normalizeWhitespace(text).split(" ").filter(Boolean);
  if (words.length === 0 || !Number.isFinite(duration) || duration <= 0) {
    return [];
  }

  const secondsPerWord = duration / words.length;
  return words.map((word, index) => ({
    text: word,
    timestamp: [
      index * secondsPerWord,
      Math.min(duration, (index + 1) * secondsPerWord),
    ],
  }));
}

function rebuildSubtitles() {
  if (state.wordChunks.length === 0) {
    state.subtitles = [];
    renderTranscriptText();
    els.segmentCount.textContent = "0 subtitle cards";
    updateActionState();
    drawFrame(els.previewAudio.currentTime || 0);
    return;
  }

  state.subtitles = buildSubtitleSegments(state.wordChunks, Number(els.wordsPerLine.value));
  renderTranscriptText();
  els.segmentCount.textContent = `${state.subtitles.length} subtitle cards`;
  updateActionState();
  drawFrame(els.previewAudio.currentTime || 0, { showFirstSubtitle: els.previewAudio.currentTime === 0 });
}

function subtitleAt(time) {
  return state.subtitles.find((item) => time >= item.start && time <= item.end) ?? null;
}

function drawFrame(time, options = {}) {
  const subtitle = subtitleAt(time) ?? (options.showFirstSubtitle ? state.subtitles[0] : null);
  drawSubtitleCanvas(ctx, els.previewCanvas, subtitle);
}

function drawSubtitleCanvas(context, canvas, subtitle) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#00ff00";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (!subtitle) {
    return;
  }

  const fontSize = Number(els.fontSize.value);
  const bottomPadding = Number(els.bottomPadding.value);
  const maxWidth = canvas.width * 0.82;
  const lines = wrapText(subtitle.text, maxWidth, fontSize, context);
  const lineHeight = fontSize * 1.16;
  const boxPaddingX = fontSize * 0.44;
  const boxPaddingY = fontSize * 0.28;
  const textBlockHeight = lines.length * lineHeight;
  const boxHeight = textBlockHeight + boxPaddingY * 2;
  const boxWidth = Math.min(
    maxWidth + boxPaddingX * 2,
    Math.max(...lines.map((line) => measureText(line, fontSize, context))) + boxPaddingX * 2,
  );
  const boxX = (canvas.width - boxWidth) / 2;
  const boxY = canvas.height - bottomPadding - boxHeight;

  context.fillStyle = "rgba(0, 0, 0, 0.88)";
  roundRect(context, boxX, boxY, boxWidth, boxHeight, 24);
  context.fill();

  context.textAlign = "center";
  context.textBaseline = "top";
  context.font = `700 ${fontSize}px Segoe UI`;
  context.fillStyle = "#ffffff";

  lines.forEach((line, index) => {
    const y = boxY + boxPaddingY + index * lineHeight;
    context.fillText(line, canvas.width / 2, y);
  });
}

function wrapText(text, maxWidth, fontSize, context = ctx) {
  context.font = `700 ${fontSize}px Segoe UI`;
  const words = text.split(" ");
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function measureText(text, fontSize, context = ctx) {
  context.font = `700 ${fontSize}px Segoe UI`;
  return context.measureText(text).width;
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function renderTranscriptText() {
  els.transcriptOutput.value = state.subtitles
    .map((subtitle, index) => {
      return `${index + 1}. [${formatTime(subtitle.start)} - ${formatTime(subtitle.end)}] ${subtitle.text}`;
    })
    .join("\n");
}

function updateActionState() {
  const hasFile = Boolean(state.audioFile);
  const hasSubtitles = state.subtitles.length > 0;
  els.transcribeButton.disabled = !hasFile;
  els.previewButton.disabled = !hasFile || !hasSubtitles;
  els.exportButton.disabled = !hasFile || !hasSubtitles;
  els.previewExportButton.disabled = !hasFile || !hasSubtitles;
  els.downloadSrtButton.disabled = !hasSubtitles;
}

async function ensureTranscriber() {
  if (state.transcriber) {
    return state.transcriber;
  }

  setStatus("Loading Whisper model for browser transcription. This can take a moment the first time.", 8);

  const { pipeline, env } = await import("https://esm.sh/@xenova/transformers@2.17.2");
  env.allowLocalModels = false;

  state.transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", {
    quantized: true,
    progress_callback: (info) => {
      if (typeof info.progress === "number") {
        setStatus(`Loading model files: ${info.file ?? "assets"}`, info.progress * 100);
      }
    },
  });

  return state.transcriber;
}

async function ensureFfmpeg() {
  if (state.ffmpeg) {
    return state.ffmpeg;
  }

  setStatus("Loading the in-browser video exporter.", 10);

  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import("https://esm.sh/@ffmpeg/ffmpeg@0.12.10"),
    import("https://esm.sh/@ffmpeg/util@0.12.1"),
  ]);

  const ffmpeg = new FFmpeg();
  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

  ffmpeg.on("progress", ({ progress }) => {
    setStatus("Encoding MP4 in the browser.", 55 + progress * 40);
  });

  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });

  state.ffmpeg = { ffmpeg, fetchFile };
  return state.ffmpeg;
}

async function transcribeCurrentAudio() {
  if (!state.audioFile) {
    return;
  }

  els.transcribeButton.disabled = true;
  state.subtitles = [];
  updateActionState();
  drawFrame(0);

  try {
    setStatus("Reading audio in the browser.", 5);
    const audio = await decodeAudio(state.audioFile);
    state.audioDuration = audio.duration;
    els.audioDuration.textContent = `${audio.duration.toFixed(1)}s`;

    const transcriber = await ensureTranscriber();
    setStatus("Transcribing audio. Keep this tab open while it works.", 18);

    const result = await transcriber(audio.data, {
      chunk_length_s: 29,
      stride_length_s: 5,
      return_timestamps: "word",
    });

    state.transcriptText = normalizeWhitespace(result.text ?? "");
    state.wordChunks = sanitizeChunks(result.chunks, audio.duration);

    if (state.wordChunks.length === 0) {
      setStatus("Word timings were unreliable, retrying with segment timings.", 55);
      const fallbackResult = await transcriber(audio.data, {
        chunk_length_s: 29,
        stride_length_s: 5,
        return_timestamps: true,
      });
      state.wordChunks = sanitizeChunks(fallbackResult.chunks, audio.duration);
    }

    if (state.wordChunks.length === 0 && state.transcriptText) {
      state.wordChunks = buildApproximateChunks(state.transcriptText, audio.duration);
    }

    if (state.wordChunks.length === 0) {
      throw new Error("No usable subtitle timings were returned for this audio.");
    }

    rebuildSubtitles();
    setStatus("Transcription complete. Preview or export when you're ready.", 100);
    drawFrame(0, { showFirstSubtitle: true });
  } catch (error) {
    console.error(error);
    setStatus(`Transcription failed: ${error.message}`, null);
  } finally {
    els.transcribeButton.disabled = false;
  }
}

function refreshSubtitlesFromCurrentSettings() {
  rebuildSubtitles();
}

function updatePreviewClock() {
  els.previewClock.textContent = `${formatTime(els.previewAudio.currentTime)} / ${formatTime(state.audioDuration)}`;
}

function stopPreviewLoop() {
  if (state.previewRafId) {
    cancelAnimationFrame(state.previewRafId);
    state.previewRafId = 0;
  }
}

function startPreviewLoop() {
  stopPreviewLoop();

  const tick = () => {
    drawFrame(els.previewAudio.currentTime || 0);
    updatePreviewClock();

    if (!els.previewAudio.paused && !els.previewAudio.ended) {
      state.previewRafId = requestAnimationFrame(tick);
    } else {
      state.previewRafId = 0;
    }
  };

  tick();
}

function downloadBlob(blob, filename) {
  if (!blob || blob.size === 0) {
    throw new Error(`No data was generated for ${filename}.`);
  }

  showDownloadPanel(blob, filename);
  const url = blobToObjectUrl(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showDownloadPanel(blob, filename) {
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
  }

  state.downloadUrl = blobToObjectUrl(blob);
  els.downloadFileName.textContent = filename;
  els.downloadLink.href = state.downloadUrl;
  els.downloadLink.download = filename;
  els.downloadLink.textContent = `Download ${filename}`;
  els.downloadHint.textContent = "If no save window appears, use this button and check your browser downloads.";
  els.downloadPanel.hidden = false;
}

function showSavedFilePanel(result) {
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = "";
  }

  els.downloadFileName.textContent = result.filename;
  els.downloadLink.href = result.url;
  els.downloadLink.download = result.filename;
  els.downloadLink.textContent = `Open saved file`;
  els.downloadHint.textContent = `Saved on this PC: ${result.path}`;
  els.downloadPanel.hidden = false;
}

async function saveBlobToLocalServer(blob, filename) {
  const response = await fetch(`/save?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
    },
    body: blob,
  });

  if (!response.ok) {
    throw new Error(`Local save failed: ${response.status}`);
  }

  const result = await response.json();
  if (!result.ok || !result.path) {
    throw new Error("Local save did not return a file path.");
  }

  showSavedFilePanel(result);
  return result;
}

async function requestSaveHandle(filename, types) {
  if ("showSaveFilePicker" in window) {
    try {
      return {
        handle: await window.showSaveFilePicker({
          suggestedName: filename,
          types,
        }),
        status: "ready",
      };
    } catch (error) {
      if (error.name === "AbortError") {
        return { status: "cancelled" };
      }

      console.warn(error);
    }
  }

  return { status: "unavailable" };
}

async function writeBlobToHandle(blob, handle) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function saveBlobToUser(blob, filename, types, handleRequest = null) {
  if (!blob || blob.size === 0) {
    throw new Error(`No data was generated for ${filename}.`);
  }

  const request = handleRequest ?? (await requestSaveHandle(filename, types));

  if (request.status === "ready") {
    try {
      await writeBlobToHandle(blob, request.handle);
      return "picker";
    } catch (error) {
      console.warn(error);
    }
  }

  if (request.status === "cancelled") {
    return "cancelled";
  }

  try {
    await saveBlobToLocalServer(blob, filename);
    return "local";
  } catch (error) {
    console.warn(error);
  }

  downloadBlob(blob, filename);
  return "download";
}

async function saveBlobWithPicker(blob, filename, types) {
  if ("showSaveFilePicker" in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types,
      });
      await writeBlobToHandle(blob, handle);
      return "picker";
    } catch (error) {
      if (error.name === "AbortError") {
        return "cancelled";
      }

      console.warn(error);
    }
  }

  downloadBlob(blob, filename);
  return "download";
}

function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("Could not render subtitle frame."));
    }, type);
  });
}

async function canvasToBytes(canvas) {
  const blob = await canvasToBlob(canvas);
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderWebCodecsMp4() {
  if (!("VideoEncoder" in window) || !("VideoFrame" in window)) {
    throw new Error("Fast MP4 export needs a Chromium-based browser with WebCodecs support.");
  }

  setStatus("Starting fast MP4 encoder.", 8);
  const { Muxer, ArrayBufferTarget } = await import("https://esm.sh/mp4-muxer@5.2.0");
  const width = els.previewCanvas.width;
  const height = els.previewCanvas.height;
  const fps = 15;
  const frameCount = Math.max(1, Math.ceil(state.audioDuration * fps));
  const frameDuration = Math.round(1_000_000 / fps);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: "avc",
      width,
      height,
    },
    fastStart: "in-memory",
  });

  const configCandidates = [
    {
      codec: "avc1.42001f",
      width,
      height,
      bitrate: 2_500_000,
      framerate: fps,
    },
    {
      codec: "avc1.4d001f",
      width,
      height,
      bitrate: 2_500_000,
      framerate: fps,
    },
  ];

  let config = null;
  for (const candidate of configCandidates) {
    const support = await VideoEncoder.isConfigSupported(candidate);
    if (support.supported) {
      config = support.config;
      break;
    }
  }

  if (!config) {
    throw new Error("This browser cannot encode H.264 MP4 video.");
  }

  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = width;
  renderCanvas.height = height;
  const renderContext = renderCanvas.getContext("2d");
  if (!renderContext) {
    throw new Error("Could not create an export canvas.");
  }

  let rejectEncoding;
  const encodingError = new Promise((_, reject) => {
    rejectEncoding = reject;
  });
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => rejectEncoding(error),
  });
  encoder.configure(config);

  for (let index = 0; index < frameCount; index += 1) {
    const time = Math.min(state.audioDuration, index / fps);
    drawSubtitleCanvas(renderContext, renderCanvas, subtitleAt(time));

    const frame = new VideoFrame(renderCanvas, {
      timestamp: index * frameDuration,
      duration: frameDuration,
    });
    encoder.encode(frame, {
      keyFrame: index % (fps * 2) === 0,
    });
    frame.close();

    if (index % 12 === 0) {
      setStatus("Encoding chroma subtitle MP4.", 10 + (index / frameCount) * 78);
      await new Promise(requestAnimationFrame);
    }
  }

  await Promise.race([encoder.flush(), encodingError]);
  encoder.close();
  muxer.finalize();

  const buffer = muxer.target?.buffer ?? target.buffer;
  if (!buffer || buffer.byteLength === 0) {
    throw new Error("The MP4 encoder finished without producing video data.");
  }

  return new Blob([buffer], { type: "video/mp4" });
}

function chooseRecordingMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

async function recordPreviewWebm() {
  if (typeof els.previewCanvas.captureStream !== "function") {
    throw new Error("This browser does not support preview recording.");
  }

  if (typeof MediaRecorder === "undefined") {
    throw new Error("This browser does not support video recording.");
  }

  const fps = 30;
  const stream = els.previewCanvas.captureStream(fps);
  const mimeType = chooseRecordingMimeType();
  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 5_000_000,
  });

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const done = new Promise((resolve, reject) => {
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener("error", () => reject(new Error("Preview recording failed.")), { once: true });
  });

  let frame = 0;
  const totalFrames = Math.max(1, Math.ceil(state.audioDuration * fps));
  const renderNextFrame = () => {
    const time = Math.min(state.audioDuration, frame / fps);
    drawFrame(time);

    if (frame % 12 === 0) {
      setStatus("Recording preview frames.", 8 + (frame / totalFrames) * 42);
    }

    frame += 1;
    if (frame <= totalFrames) {
      requestAnimationFrame(renderNextFrame);
      return;
    }

    setTimeout(() => recorder.stop(), 120);
  };

  recorder.start(250);
  renderNextFrame();
  await done;

  stream.getTracks().forEach((track) => track.stop());
  const blob = new Blob(chunks, { type: mimeType || "video/webm" });
  if (blob.size === 0) {
    throw new Error("Preview recording produced no data.");
  }

  return blob;
}

async function convertPreviewToMp4(webmBlob, filename) {
  setStatus("Converting preview to Windows-compatible MP4.", 58);
  const response = await fetch(`/convert-preview?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: {
      "Content-Type": webmBlob.type || "video/webm",
    },
    body: webmBlob,
  });

  if (!response.ok) {
    throw new Error(`Preview conversion failed: ${response.status}`);
  }

  const result = await response.json();
  if (!result.ok || !result.path) {
    throw new Error("Preview conversion did not return a saved MP4.");
  }

  showSavedFilePanel(result);
  return result;
}

async function savePreviewMp4() {
  if (!state.audioFile || state.subtitles.length === 0) {
    return;
  }

  els.exportButton.disabled = true;
  els.previewExportButton.disabled = true;

  try {
    const filename = `${outputBaseName()}-preview-chroma.mp4`;
    const webmBlob = await recordPreviewWebm();
    const result = await convertPreviewToMp4(webmBlob, filename);
    setStatus(`Preview MP4 saved to exports: ${result.filename}`, 100);
  } catch (error) {
    console.error(error);
    setStatus(`Preview MP4 failed: ${error.message}`, null);
  } finally {
    updateActionState();
  }
}

function audioInputName(prefix) {
  const extension = state.audioFile?.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "audio";
  return `${prefix}-audio.${extension}`;
}

function buildExportTimeline() {
  const duration = Number.isFinite(state.audioDuration) ? state.audioDuration : 0;
  const timeline = [];
  let cursor = 0;

  const subtitles = [...state.subtitles].sort((a, b) => a.start - b.start);
  for (const subtitle of subtitles) {
    const start = Math.max(0, Math.min(duration, subtitle.start));
    const end = Math.max(start, Math.min(duration, subtitle.end));
    const effectiveStart = Math.max(cursor, start);

    if (start > cursor + 0.04) {
      timeline.push({ duration: start - cursor, subtitle: null });
    }

    if (end > effectiveStart + 0.04) {
      timeline.push({ duration: end - effectiveStart, subtitle });
      cursor = end;
    }
  }

  if (duration > cursor + 0.04) {
    timeline.push({ duration: duration - cursor, subtitle: null });
  }

  return timeline.filter((item) => item.duration > 0.04);
}

function toSrtTimestamp(seconds) {
  const millis = Math.max(0, Math.floor(seconds * 1000));
  const hours = Math.floor(millis / 3600000)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((millis % 3600000) / 60000)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor((millis % 60000) / 1000)
    .toString()
    .padStart(2, "0");
  const ms = (millis % 1000).toString().padStart(3, "0");
  return `${hours}:${minutes}:${secs},${ms}`;
}

async function downloadSrt() {
  const srt = state.subtitles
    .map((subtitle, index) => {
      return `${index + 1}\n${toSrtTimestamp(subtitle.start)} --> ${toSrtTimestamp(subtitle.end)}\n${subtitle.text}`;
    })
    .join("\n\n");

  const filename = `${outputBaseName()}.srt`;
  const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
  const result = await saveBlobWithPicker(blob, filename, [
    {
      description: "SubRip subtitle file",
      accept: {
        "text/plain": [".srt"],
      },
    },
  ]);

  if (result === "picker") {
    setStatus("SRT saved.", 100);
    return;
  }

  if (result === "local") {
    setStatus("SRT saved to the local exports folder.", 100);
    return;
  }

  if (result === "cancelled") {
    setStatus("SRT save cancelled.", 0);
    return;
  }

  setStatus("SRT ready. Use the visible download button if no popup appeared.", 100);
}

async function renderFastMp4() {
  setStatus("Preparing subtitle frames.", 8);
  const { ffmpeg, fetchFile } = await ensureFfmpeg();
  const timeline = buildExportTimeline();

  if (timeline.length === 0) {
    throw new Error("No subtitle timeline is available for export.");
  }

  const prefix = `subtitle-export-${Date.now()}`;
  const framesListName = `${prefix}-frames.txt`;
  const outputName = `${prefix}-output.mp4`;
  const audioName = audioInputName(prefix);
  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = els.previewCanvas.width;
  renderCanvas.height = els.previewCanvas.height;
  const renderContext = renderCanvas.getContext("2d");
  if (!renderContext) {
    throw new Error("Could not create an export canvas.");
  }

  const frameLines = [];
  const writtenFiles = [framesListName, outputName, audioName];
  let lastFrameName = "";

  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index];
    const frameName = `${prefix}-frame-${index.toString().padStart(4, "0")}.png`;
    drawSubtitleCanvas(renderContext, renderCanvas, item.subtitle);
    await ffmpeg.writeFile(frameName, await canvasToBytes(renderCanvas));
    writtenFiles.push(frameName);
    frameLines.push(`file '${frameName}'`);
    frameLines.push(`duration ${item.duration.toFixed(3)}`);
    lastFrameName = frameName;

    setStatus("Rendering subtitle frames.", 12 + ((index + 1) / timeline.length) * 28);
  }

  frameLines.push(`file '${lastFrameName}'`);
  await ffmpeg.writeFile(framesListName, new TextEncoder().encode(frameLines.join("\n")));
  await ffmpeg.writeFile(audioName, await fetchFile(state.audioFile));

  setStatus("Building MP4 from subtitle frames.", 48);
  await ffmpeg.exec([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    framesListName,
    "-i",
    audioName,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-t",
    state.audioDuration.toFixed(3),
    "-r",
    "30",
    "-c:v",
    "mpeg4",
    "-q:v",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outputName,
  ]);

  const data = await ffmpeg.readFile(outputName);
  downloadBlob(new Blob([data.buffer], { type: "video/mp4" }), `${outputBaseName()}-chroma-subtitles.mp4`);

  for (const file of writtenFiles) {
    try {
      await ffmpeg.deleteFile(file);
    } catch {
      // Older ffmpeg.wasm builds can omit deleteFile; leftover virtual files are harmless.
    }
  }
}

async function renderRecordedMp4() {
  if (!state.audioFile || state.subtitles.length === 0) {
    return;
  }

  setStatus("Using real-time recording fallback.", 6);
  const { ffmpeg, fetchFile } = await ensureFfmpeg();

  if (typeof els.previewCanvas.captureStream !== "function") {
    throw new Error("This browser does not support canvas recording.");
  }

  const renderAudio = new Audio(state.audioUrl);
  renderAudio.crossOrigin = "anonymous";

  if (typeof renderAudio.captureStream !== "function") {
    throw new Error("This browser does not support audio stream capture for MP4 export.");
  }

  if (typeof MediaRecorder === "undefined") {
    throw new Error("This browser does not support MediaRecorder.");
  }

  await new Promise((resolve) => {
    if (renderAudio.readyState >= 2) {
      resolve();
      return;
    }

    renderAudio.addEventListener("loadeddata", resolve, { once: true });
  });

  const fps = 30;
  const canvasStream = els.previewCanvas.captureStream(fps);
  const audioStream = renderAudio.captureStream();
  const tracks = [...canvasStream.getVideoTracks(), ...audioStream.getAudioTracks()];
  const combinedStream = new MediaStream(tracks);
  const mimeType =
    MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";

  const recorderChunks = [];
  const recorder = new MediaRecorder(combinedStream, {
    mimeType,
    videoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 192_000,
  });

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      recorderChunks.push(event.data);
    }
  });

  const recordingDone = new Promise((resolve) => {
    recorder.addEventListener("stop", resolve, { once: true });
  });

  let rafId = 0;
  const tick = () => {
    drawFrame(renderAudio.currentTime);
    const progress = state.audioDuration
      ? 20 + (renderAudio.currentTime / state.audioDuration) * 35
      : 20;
    setStatus("Recording subtitle video in the browser.", progress);

    if (!renderAudio.paused && !renderAudio.ended) {
      rafId = requestAnimationFrame(tick);
    }
  };

  recorder.start(250);
  await renderAudio.play();
  tick();

  await new Promise((resolve) => {
    renderAudio.addEventListener(
      "ended",
      () => {
        cancelAnimationFrame(rafId);
        drawFrame(state.audioDuration);
        setTimeout(() => {
          recorder.stop();
          resolve();
        }, 250);
      },
      { once: true },
    );
  });

  await recordingDone;

  const webmBlob = new Blob(recorderChunks, { type: mimeType });
  setStatus("Encoding final MP4 download.", 68);

  await ffmpeg.writeFile("input.webm", await fetchFile(webmBlob));
  await ffmpeg.exec([
    "-i",
    "input.webm",
    "-c:v",
    "mpeg4",
    "-q:v",
    "2",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "output.mp4",
  ]);

  const data = await ffmpeg.readFile("output.mp4");
  downloadBlob(new Blob([data.buffer], { type: "video/mp4" }), `${outputBaseName()}-chroma-subtitles.mp4`);
}

async function renderMp4() {
  if (!state.audioFile || state.subtitles.length === 0) {
    return;
  }

  els.exportButton.disabled = true;
  els.previewExportButton.disabled = true;
  const filename = `${outputBaseName()}-chroma-subtitles.mp4`;
  const mp4Types = [
    {
      description: "MP4 video",
      accept: {
        "video/mp4": [".mp4"],
      },
    },
  ];

  try {
    const saveRequest = await requestSaveHandle(filename, mp4Types);
    if (saveRequest.status === "cancelled") {
      setStatus("MP4 save cancelled.", 0);
      return;
    }

    const mp4Blob = await renderWebCodecsMp4();
    const saveResult = await saveBlobToUser(mp4Blob, filename, mp4Types, saveRequest);
    if (saveResult === "picker") {
      setStatus("MP4 saved.", 100);
      return;
    }

    if (saveResult === "local") {
      setStatus("MP4 saved to the local exports folder.", 100);
      return;
    }

    setStatus("MP4 ready. Use the visible download button if no popup appeared.", 100);
  } catch (error) {
    console.error(error);
    setStatus(`Fast export failed: ${error.message}`, null);
  } finally {
    updateActionState();
  }
}

function updatePreviewSource() {
  if (!state.audioUrl) {
    return;
  }

  els.previewAudio.src = state.audioUrl;
}

els.audioFile.addEventListener("change", async (event) => {
  const [file] = event.target.files ?? [];
  state.audioFile = file ?? null;
  state.wordChunks = [];
  state.subtitles = [];
  state.transcriptText = "";
  els.transcriptOutput.value = "";
  els.segmentCount.textContent = "0 subtitle cards";
  updateActionState();

  if (!state.audioFile) {
    els.fileName.textContent = "None";
    els.audioDuration.textContent = "0.0s";
    setStatus("Choose an audio file to begin.");
    drawFrame(0);
    return;
  }

  if (state.audioUrl) {
    URL.revokeObjectURL(state.audioUrl);
  }

  state.audioUrl = blobToObjectUrl(state.audioFile);
  updatePreviewSource();
  els.fileName.textContent = state.audioFile.name;

  try {
    const audio = await decodeAudio(state.audioFile);
    state.audioDuration = audio.duration;
    els.audioDuration.textContent = `${audio.duration.toFixed(1)}s`;
    setStatus("Audio loaded. You can transcribe it now.", 0);
  } catch (error) {
    console.error(error);
    setStatus(`Could not read audio file: ${error.message}`, null);
  }
});

els.transcribeButton.addEventListener("click", transcribeCurrentAudio);
els.previewButton.addEventListener("click", async () => {
  if (!state.audioUrl || state.subtitles.length === 0) {
    return;
  }

  els.previewAudio.currentTime = 0;
  drawFrame(0, { showFirstSubtitle: true });
  updatePreviewClock();
  await els.previewAudio.play();
  startPreviewLoop();
});
els.exportButton.addEventListener("click", savePreviewMp4);
els.previewExportButton.addEventListener("click", savePreviewMp4);
els.downloadSrtButton.addEventListener("click", downloadSrt);
els.hideDownloadPanel.addEventListener("click", () => {
  els.downloadPanel.hidden = true;
});

els.previewAudio.addEventListener("timeupdate", () => {
  const currentTime = els.previewAudio.currentTime || 0;
  drawFrame(currentTime, { showFirstSubtitle: currentTime < 0.05 && els.previewAudio.paused });
  updatePreviewClock();
});

els.previewAudio.addEventListener("play", startPreviewLoop);
els.previewAudio.addEventListener("pause", () => {
  stopPreviewLoop();
  const currentTime = els.previewAudio.currentTime || 0;
  drawFrame(currentTime, { showFirstSubtitle: currentTime < 0.05 });
});

els.previewAudio.addEventListener("ended", () => {
  stopPreviewLoop();
  drawFrame(state.audioDuration);
  updatePreviewClock();
});

els.fontSize.addEventListener("input", () => {
  updateSliderLabels();
  drawFrame(els.previewAudio.currentTime || 0);
});

els.bottomPadding.addEventListener("input", () => {
  updateSliderLabels();
  drawFrame(els.previewAudio.currentTime || 0);
});

els.wordsPerLine.addEventListener("input", () => {
  updateSliderLabels();
  refreshSubtitlesFromCurrentSettings();
});

updateSliderLabels();
updateActionState();
drawFrame(0);
updatePreviewClock();
