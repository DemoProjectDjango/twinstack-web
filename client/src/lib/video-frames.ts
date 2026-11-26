// A video attached for the AI (a screen recording of a website, say) becomes still pictures, taken
// here in the browser: the AI reads pictures, not video, and a recording is often far too big to
// upload. Every half second or so is looked at, and a frame is kept when the screen has changed
// enough since the last one kept, so a slow scroll gives each part of the page once.

export const VIDEO_FILE = /\.(mp4|m4v|mov|webm|ogv|mkv)$/i;
export const isVideo = (file: File) => file.type.startsWith("video/") || VIDEO_FILE.test(file.name);

/** The most frames one video gives (the message takes 20 files). */
export const MAX_VIDEO_FRAMES = 12;
/** How long a video may be: beyond this only its first part is looked at. */
const MAX_SECONDS = 15 * 60;
/** The most moments looked at, however long the video. */
const MAX_SAMPLES = 240;
/** A kept frame's longest side, in pixels (the AI shrinks bigger ones to about this anyway). */
const FRAME_SIDE = 1600;
/** How different a frame must be from the last one kept (0–1, the share of brightness changed). */
const CHANGE = 0.045;
const SIG_W = 32;
const SIG_H = 18;

export class VideoError extends Error {}

export type VideoFrame = { file: File; at: number };

// "1m05s": file names keep to plain characters (the AI's file service refuses ":" and the like).
const clock = (seconds: number) => `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;

function once(target: HTMLVideoElement, event: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener("error", failed);
      resolve();
    };
    const failed = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      reject(new VideoError("This browser can't play that video. Try an MP4 file, or open the editor in Chrome or Safari."));
    };
    const timer = setTimeout(() => {
      target.removeEventListener(event, done);
      target.removeEventListener("error", failed);
      reject(new VideoError("The video took too long to read."));
    }, ms);
    target.addEventListener(event, done, { once: true });
    target.addEventListener("error", failed, { once: true });
  });
}

/** The video's real length; recordings made in a browser report Infinity until the end is sought. */
async function durationOf(video: HTMLVideoElement) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  video.currentTime = 1e7;
  await once(video, "seeked", 15000).catch(() => undefined);
  const length = Number.isFinite(video.duration) ? video.duration : video.currentTime;
  if (!(length > 0)) throw new VideoError("That video seems to be empty.");
  return length;
}

/** A tiny greyscale copy of the frame, to compare frames by. */
function signature(ctx: CanvasRenderingContext2D, video: HTMLVideoElement) {
  ctx.drawImage(video, 0, 0, SIG_W, SIG_H);
  const { data } = ctx.getImageData(0, 0, SIG_W, SIG_H);
  const out = new Float32Array(SIG_W * SIG_H);
  for (let i = 0; i < out.length; i++) out[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
  return out;
}

const difference = (a: Float32Array, b: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

/** A frame that is one flat colour (a black start, a fade) shows nothing worth keeping. */
const flat = (sig: Float32Array) => {
  let min = 1;
  let max = 0;
  for (const v of sig) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min < 0.04;
};

/** Picks `count` of `items` spread evenly, always the first and the last. */
export function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  if (count <= 1) return items.slice(0, count);
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]);
}

/**
 * The frames worth showing from a video file, as JPEG files named "<video> - frame N of M at 0m05s.jpg",
 * at most `limit`. `onProgress` gets 0–1 while it looks.
 */
export async function videoFrames(file: File, limit = MAX_VIDEO_FRAMES, onProgress?: (share: number) => void): Promise<VideoFrame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await once(video, "loadeddata", 30000);
    const length = Math.min(await durationOf(video), MAX_SECONDS);
    if (!video.videoWidth || !video.videoHeight) throw new VideoError("That file has no picture to look at.");

    const small = document.createElement("canvas");
    small.width = SIG_W;
    small.height = SIG_H;
    const smallCtx = small.getContext("2d", { willReadFrequently: true });
    const scale = Math.min(1, FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const big = document.createElement("canvas");
    big.width = Math.round(video.videoWidth * scale);
    big.height = Math.round(video.videoHeight * scale);
    const bigCtx = big.getContext("2d");
    if (!smallCtx || !bigCtx) throw new VideoError("This browser can't read video frames.");

    const samples = Math.max(2, Math.min(MAX_SAMPLES, Math.round(length / 0.5)));
    const kept: { blob: Blob; at: number }[] = [];
    let last: Float32Array | null = null;
    for (let i = 0; i < samples; i++) {
      const at = Math.min(length - 0.05, Math.max(0.05, (length * i) / (samples - 1)));
      video.currentTime = at;
      await once(video, "seeked", 10000);
      const sig = signature(smallCtx, video);
      onProgress?.((i + 1) / samples);
      if (flat(sig) || (last && difference(sig, last) < CHANGE)) continue;
      last = sig;
      bigCtx.drawImage(video, 0, 0, big.width, big.height);
      const blob = await new Promise<Blob | null>((resolve) => big.toBlob(resolve, "image/jpeg", 0.85));
      if (blob) kept.push({ blob, at });
    }
    if (!kept.length) throw new VideoError("Nothing could be seen in that video (it may be blank).");

    const chosen = spread(kept, Math.max(1, limit));
    const base = file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "video";
    return chosen.map(({ blob, at }, i) => ({
      at,
      file: new File([blob], `${base} - frame ${i + 1} of ${chosen.length} at ${clock(at)}.jpg`, { type: "image/jpeg" }),
    }));
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
