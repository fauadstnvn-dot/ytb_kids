import vm from "node:vm";
import { StoryError as StepError, formatTimestamp } from "./utils.mjs";

const STEP = "Đọc kịch bản";

/**
 * Chạy file kịch bản trong sandbox giống trình duyệt (window = global) và lấy ra:
 *   - Storyboard (SEGMENTS, init, drawScene, YOUTUBE_METADATA)  — định dạng chính
 *   - hoặc window.KICHBAN_SCRIPT có drawScene                   — định dạng phụ của index.php
 */
export function loadStory(code, filename) {
  const sandbox = {
    console: { log() {}, info() {}, debug() {}, warn: console.warn, error: console.error },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  try {
    vm.runInContext(code, sandbox, { filename, timeout: 15_000 });
  } catch (e) {
    throw new StepError(STEP, `File ${filename} bị lỗi cú pháp/khi chạy: ${e.message}`, e);
  }

  const sb = sandbox.Storyboard;
  const kb = sandbox.KICHBAN_SCRIPT;
  let api = null;

  if (sb && Array.isArray(sb.SEGMENTS) && typeof sb.drawScene === "function") {
    api = {
      segments: sb.SEGMENTS,
      init: typeof sb.init === "function" ? sb.init.bind(sb) : () => {},
      drawScene: sb.drawScene.bind(sb),
      meta: sb.YOUTUBE_METADATA || {},
    };
  } else if (kb && typeof kb.drawScene === "function") {
    const segs = Array.isArray(kb.SEGMENTS) ? kb.SEGMENTS : kb.segments;
    if (Array.isArray(segs)) {
      api = {
        segments: segs,
        init: typeof kb.init === "function" ? kb.init.bind(kb) : () => {},
        drawScene: kb.drawScene.bind(kb),
        meta: kb.YOUTUBE_METADATA || {
          title: kb.youtube_title || kb.title,
          description: kb.youtube_description || kb.description,
          tags: kb.tags,
        },
      };
    }
  }

  if (!api) {
    throw new StepError(
      STEP,
      `File ${filename} không có Storyboard.SEGMENTS + Storyboard.drawScene (hoặc window.KICHBAN_SCRIPT.drawScene). Không thể dựng hình.`
    );
  }
  if (!api.segments.length) throw new StepError(STEP, `File ${filename} có SEGMENTS rỗng.`);

  const segments = api.segments.map((seg, i) => {
    const start = Number(seg.start);
    const end = Number(seg.end);
    let dur = Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN;
    if (!(dur > 0)) dur = 10;
    return {
      raw: seg,
      index: i,
      key: String(seg.key || `scene_${i + 1}`),
      title: String(seg.title || `Scene ${i + 1}`),
      narrationText: String(seg.action || "").trim(),
      origStart: Number.isFinite(start) ? start : 0,
      origDuration: dur,
      start: 0,
      end: 0,
      narration: null,
    };
  });

  return { ...api, segments, filename };
}

const NARR_PAD = 0.7;

/** Kéo dài mỗi cảnh để >= thời lượng giọng đọc + đệm (giống retimeTimeline của index.php). */
export function retimeSegments(segments, minTotal = 0) {
  let cursor = 0;
  for (const seg of segments) {
    const narr = seg.narration?.duration || 0;
    const dur = Math.max(seg.origDuration, narr > 0 ? narr + NARR_PAD : seg.origDuration);
    seg.start = cursor;
    seg.end = cursor + dur;
    // Script vẽ dựa trên start/end của chính object cảnh.
    seg.raw.start = seg.start;
    seg.raw.end = seg.end;
    cursor += dur;
  }
  // Có mp3 riêng dài hơn tổng các cảnh: kéo dài cảnh cuối để video không cắt ngang mp3.
  const last = segments[segments.length - 1];
  if (last && cursor < minTotal) {
    cursor = minTotal;
    last.end = cursor;
    last.raw.end = cursor;
  }
  return cursor;
}

function cleanText(s) {
  return String(s || "")
    .replace(/[<>]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function truncateBytes(str, maxBytes) {
  const enc = new TextEncoder();
  if (enc.encode(str).length <= maxBytes) return str;
  let out = "";
  for (const ch of str) {
    if (enc.encode(out + ch).length > maxBytes) break;
    out += ch;
  }
  return out.trimEnd();
}

/**
 * Lấy title/description/tags từ YOUTUBE_METADATA trong file .js.
 * Mốc chương (chapters) được tính lại theo timeline mới sau khi kéo dài cảnh cho giọng đọc.
 */
export function buildYouTubeMeta(story, fallbackName) {
  const meta = story.meta || {};
  let title = cleanText(meta.title) || fallbackName;
  title = title.replace(/\s+/g, " ");
  if ([...title].length > 100) title = [...title].slice(0, 100).join("").trimEnd();

  const chapterMap = new Map();
  for (const seg of story.segments) {
    chapterMap.set(`${formatTimestamp(seg.origStart)} ${seg.title}`, `${formatTimestamp(seg.start)} ${seg.title}`);
  }
  const description = truncateBytes(
    cleanText(meta.description)
      .split("\n")
      .map((line) => chapterMap.get(line.trim()) ?? line)
      .join("\n"),
    4900
  );

  const seen = new Set();
  const tags = [];
  for (const t of Array.isArray(meta.tags) ? meta.tags : []) {
    const tag = cleanText(t).replace(/[,\n]/g, " ").replace(/\s+/g, " ");
    const k = tag.toLowerCase();
    if (!tag || seen.has(k)) continue;
    seen.add(k);
    tags.push(tag);
  }
  return { title, description, tags };
}
