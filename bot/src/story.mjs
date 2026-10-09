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

const CHAPTER_LINE = /^\s*[-•*]?\s*[[(]?(?:\d{1,2}:)?\d{1,2}:\d{2}[\])]?\s*[-–—|:]?\s+\S/;
const MIN_CHAPTER_SEC = 10;

/**
 * Dựng chapters từ timeline thực tế (sau retimeSegments). YouTube yêu cầu mốc đầu là 0:00
 * và mỗi chương >= 10 giây, nên cảnh quá ngắn được gộp vào chương kế tiếp.
 */
function buildChapterLines(segments) {
  const retimed = segments.some((s) => s.end > 0);
  const startOf = (s) => (retimed ? s.start : s.origStart);
  const last = segments[segments.length - 1];
  const total = retimed ? last?.end || 0 : (last?.origStart || 0) + (last?.origDuration || 0);

  const chapters = [];
  segments.forEach((seg, i) => {
    const start = i === 0 ? 0 : Math.floor(startOf(seg) || 0);
    const title = String(seg.title).replace(/\s+/g, " ").trim();
    const prev = chapters[chapters.length - 1];
    if (prev && start - prev.start < MIN_CHAPTER_SEC) {
      if (chapters.length > 1) prev.title = title;
      return;
    }
    chapters.push({ start, title });
  });
  if (chapters.length > 1 && total - chapters[chapters.length - 1].start < MIN_CHAPTER_SEC) chapters.pop();
  return chapters.map((c) => `${formatTimestamp(c.start)} ${c.title}`);
}

/**
 * Xoá mọi dòng mốc thời gian cũ trong mô tả (kể cả "00:00 ..." do AI viết sẵn) và chèn
 * chapters mới vào đúng vị trí cũ; nếu chưa có thì chèn trước dòng hashtag.
 */
function replaceChapters(desc, segments) {
  const chapterLines = buildChapterLines(segments);
  const kept = [];
  let insertAt = -1;
  for (const line of desc.split("\n")) {
    if (CHAPTER_LINE.test(line)) {
      if (insertAt < 0) insertAt = kept.length;
      continue;
    }
    kept.push(line);
  }
  if (!chapterLines.length) return kept.join("\n").trim();

  if (insertAt < 0) {
    const heading = kept.findIndex((l) => /timestamps|chapters|mốc thời gian/i.test(l));
    if (heading >= 0) insertAt = heading + 1;
  }
  if (insertAt >= 0) {
    kept.splice(insertAt, 0, ...chapterLines);
  } else {
    const block = ["Chapters:", ...chapterLines, ""];
    const tagLine = kept.findIndex((l) => /^\s*#\S/.test(l));
    if (tagLine >= 0) kept.splice(tagLine, 0, ...block);
    else kept.push("", ...block.slice(0, -1));
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

  const description = truncateBytes(replaceChapters(cleanText(meta.description), story.segments), 4900);

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
