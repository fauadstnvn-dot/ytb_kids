import vm from "node:vm";
import { createCanvas } from "@napi-rs/canvas";
import { browserLikeContext } from "./ctx-compat.mjs";
import { StoryError as StepError, formatTimestamp, log } from "./utils.mjs";

const STEP = "Đọc kịch bản";

export const DEFAULT_NARRATOR_PITCH = 5;
const DEFAULT_BUBBLE_COLORS = ["#fff4cf", "#d7e8c4", "#f9d6df", "#cfe3f5", "#e4dcf7", "#ffd0a8", "#c8f0ee"];

export function clampPitch(value, fallback = 0) {
  const n = Number(value);
  return Math.max(-12, Math.min(12, Math.round(Number.isFinite(n) ? n : fallback)));
}

/**
 * Cấu trúc mới: seg.dialogues = [{ speaker, label, text, pitch }] (hoặc [speaker, text, pitch]).
 * pitch là số nửa cung so với giọng Google Translate gốc (dương = cao hơn, âm = trầm hơn).
 */
export function normalizeDialogues(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    const o = Array.isArray(d) ? { speaker: d[0], text: d[1], pitch: d[2], x: d[3] } : d && typeof d === "object" ? d : null;
    if (!o) continue;
    const text = String(o.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const speaker = String(o.speaker || o.who || "voice").trim() || "voice";
    out.push({
      speaker,
      label: String(o.label || speaker).replace(/_/g, " ").trim(),
      text,
      pitch: clampPitch(o.pitch, 0),
      x: o.x === null || o.x === undefined || o.x === "" || !Number.isFinite(Number(o.x)) ? null : Math.max(0, Math.min(1, Number(o.x))),
      color: typeof o.color === "string" && /^#[0-9a-f]{3,8}$/i.test(o.color) ? o.color : null,
    });
  }
  // Màu bong bóng ổn định theo từng nhân vật nếu kịch bản không khai báo.
  const seen = new Map();
  for (const d of out) {
    if (!d.color) {
      if (!seen.has(d.speaker)) seen.set(d.speaker, DEFAULT_BUBBLE_COLORS[(hashStr(d.speaker) % DEFAULT_BUBBLE_COLORS.length)]);
      d.color = seen.get(d.speaker);
    }
  }
  return out;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Trình duyệt có `document.createElement("canvas")`; sandbox Node thì không. Hiệu ứng lật trang sách
 * (BookFlipKB) và cache layer của kịch bản đều cần canvas phụ, nếu thiếu nó sẽ ném lỗi ở MỌI khung
 * và tự tắt -> video chỉ còn cảnh gốc, không có lật trang. Shim này cấp canvas phụ giống trình duyệt.
 */
function makeDocumentShim() {
  const wrapped = new WeakMap();
  const patch = (canvas) => {
    const rawGetContext = canvas.getContext.bind(canvas);
    Object.defineProperty(canvas, "getContext", {
      configurable: true,
      value: (type, ...rest) => {
        const raw = rawGetContext(type, ...rest);
        if (!raw || type !== "2d") return raw;
        let proxy = wrapped.get(raw);
        if (!proxy) {
          proxy = browserLikeContext(raw);
          wrapped.set(raw, proxy);
        }
        return proxy;
      },
    });
    return canvas;
  };
  return {
    createElement(tag) {
      if (String(tag).toLowerCase() !== "canvas") {
        return { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} };
      }
      return patch(createCanvas(300, 150));
    },
    addEventListener() {},
    body: { appendChild() {} },
  };
}

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
    document: makeDocumentShim(),
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

  const kbSegs = kb && (Array.isArray(kb.SEGMENTS) ? kb.SEGMENTS : kb.segments);
  const hasFlip = !!(kb && (kb.__bookFlip || kb.__stageCurtain || kb.__filmClapper || kb.__comicPanel || kb.__polaroidAlbum || kb.__retroTv || kb.__slideProjector || kb.__scrollParchment || kb.__filmStrip || kb.__viewfinder) && typeof kb.drawScene === "function" && Array.isArray(kbSegs) && kbSegs.length);

  if (hasFlip) {
    // File đã chèn hiệu ứng lật sách: window.KICHBAN_SCRIPT là bản ĐÃ bọc (có bìa, lật trang, trang kết,
    // thời lượng mỗi cảnh đã cộng thêm). Phải dùng nó thay vì Storyboard gốc, nếu không sẽ mất hiệu ứng.
    let target = null;
    let tw = 1920;
    let th = 1080;
    api = {
      segments: kbSegs,
      init: (c, w, h) => {
        target = c;
        tw = w;
        th = h;
        if (sb && typeof sb.init === "function") sb.init(c, w, h);
        if (typeof kb.init === "function") kb.init(c, w, h);
      },
      drawScene: (seg, t) => kb.drawScene(target, tw, th, seg, t),
      meta: (sb && sb.YOUTUBE_METADATA) || kb.YOUTUBE_METADATA || {
        title: kb.youtube_title || kb.title,
        description: kb.youtube_description || kb.description,
        tags: kb.tags,
      },
      bookFlip: true,
      fx: {
        name: kb.__viewfinder ? "viewfinder" : kb.__filmStrip ? "filmStrip" : kb.__scrollParchment ? "scrollParchment" : kb.__slideProjector ? "slideProjector" : kb.__retroTv ? "retroTv" : kb.__polaroidAlbum ? "polaroidAlbum" : kb.__comicPanel ? "comicPanel" : kb.__filmClapper ? "filmClapper" : kb.__stageCurtain ? "stageCurtain" : "bookFlip",
        leadStory: Number(kb.fxTiming && kb.fxTiming.leadStory) || FLIP_LEAD_STORY,
        leadEdge: Number(kb.fxTiming && kb.fxTiming.leadEdge) || FLIP_LEAD_EDGE,
        extra: Number(kb.fxTiming && kb.fxTiming.extra) || FLIP_EXTRA,
      },
    };
    log.info(`Phát hiện hiệu ứng video (${kb.__viewfinder ? "ViewfinderKB - ống ngắm máy quay" : kb.__filmStrip ? "FilmStripKB - dải phim 35mm" : kb.__scrollParchment ? "ScrollParchmentKB - cuộn giấy da mở ngang" : kb.__slideProjector ? "SlideProjectorKB - máy chiếu slide" : kb.__retroTv ? "RetroTvKB - TV đời cũ chuyển kênh" : kb.__polaroidAlbum ? "PolaroidAlbumKB - album ảnh Polaroid" : kb.__comicPanel ? "ComicPanelKB - khung truyện tranh" : kb.__filmClapper ? "FilmClapperKB - bảng clapper điện ảnh" : kb.__stageCurtain ? "StageCurtainKB - rèm sân khấu" : "BookFlipKB - lật trang sách"}): dùng KICHBAN_SCRIPT, ${kbSegs.length} cảnh (gồm bìa + trang kết).`);
  } else if (sb && Array.isArray(sb.SEGMENTS) && typeof sb.drawScene === "function") {
    api = {
      segments: sb.SEGMENTS,
      init: typeof sb.init === "function" ? sb.init.bind(sb) : () => {},
      drawScene: sb.drawScene.bind(sb),
      meta: sb.YOUTUBE_METADATA || {},
    };
  } else if (kb && typeof kb.drawScene === "function" && Array.isArray(kbSegs)) {
    let target = null;
    let tw = 1920;
    let th = 1080;
    api = {
      segments: kbSegs,
      init: (c, w, h) => {
        target = c;
        tw = w;
        th = h;
        if (typeof kb.init === "function") kb.init(c, w, h);
      },
      // KICHBAN_SCRIPT.drawScene có chữ ký (ctx, W, H, seg, t), khác Storyboard.drawScene(seg, t).
      drawScene: (seg, t) => kb.drawScene(target, tw, th, seg, t),
      meta: kb.YOUTUBE_METADATA || {
        title: kb.youtube_title || kb.title,
        description: kb.youtube_description || kb.description,
        tags: kb.tags,
      },
    };
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
      // action = chỉ lời dẫn cảnh (giọng trẻ em); lời nhân vật nằm riêng trong dialogues.
      narrationText: String(seg.action || "").trim(),
      narratorPitch: clampPitch(seg.narratorPitch, DEFAULT_NARRATOR_PITCH),
      dialogues: normalizeDialogues(seg.dialogues),
      // Tùy chọn (kịch bản cũ không có thì = 0 / false): lặng X giây sau khi đọc xong để trẻ "suy nghĩ" (sau câu hỏi),
      // và đánh dấu cảnh hook mở đầu để chọn ảnh đại diện.
      holdAfterVoice: Math.max(0, Math.min(8, Number(seg.holdAfterVoice) || 0)),
      isHook: seg.hook === true || /^hook/i.test(String(seg.key || "")),
      // Camera tùy chọn: zoom / zoom_to = wide | mid | close | extreme_close (hoặc số), focus = [x, y] (0..1). Không có -> giữ nguyên.
      zoom: parseZoom(seg.zoom),
      zoomTo: parseZoom(seg.zoomTo ?? seg.zoom_to),
      focus: parseFocus(seg.focus),
      origStart: Number.isFinite(start) ? start : 0,
      origDuration: dur,
      start: 0,
      end: 0,
      narration: null,
      // Đoạn mở đầu (lật trang + phóng vào tranh) mà giọng đọc phải chờ; 0 nếu không có hiệu ứng sách.
      leadMax: api.bookFlip ? (i === 0 || i === api.segments.length - 1 ? api.fx.leadEdge : api.fx.leadStory) : 0,
      scalesWithDuration: !!api.bookFlip && i !== 0 && i !== api.segments.length - 1,
      lead: 0,
      fxExtra: api.bookFlip ? api.fx.extra : FLIP_EXTRA,
    };
  });

  applyAutoZoom(segments);

  // Phần kịch bản Short (tuỳ chọn). Script cũ không có thì = null và không dựng Short.
  const shortSpec = sb?.YOUTUBE_SHORT || kb?.YOUTUBE_SHORT || sandbox.YOUTUBE_SHORT || null;

  return { ...api, segments, filename, shortSpec };
}

const ZOOM_LEVELS = { wide: 1, mid: 1.12, close: 1.28, extreme_close: 1.5 };
// Cảnh có câu hỏi: bảng câu hỏi nằm gần mép trên nên không phóng quá mức để khỏi cắt mất.
const QUESTION_MAX_ZOOM = 1.1;

function parseZoom(v) {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number" || /^[\d.]+$/.test(String(v))) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(1, Math.min(1.8, n)) : 0;
  }
  const key = String(v).toLowerCase().replace(/[\s-]+/g, "_");
  return ZOOM_LEVELS[key] || 0;
}

function parseFocus(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = Number(v[0]);
  const y = Number(v[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
}

// Kịch bản cũ không khai báo zoom ở cảnh nào: tự luân phiên zoom gần dần / xa dần để các cảnh không đơn điệu.
// Tắt bằng biến môi trường AUTO_ZOOM=0.
const AUTO_ZOOM_PLAN = [
  ["wide", "mid"],
  ["close", "mid"],
  ["mid", "close"],
  ["wide", "close"],
  ["close", "wide"],
  ["mid", "wide"],
];

function applyAutoZoom(segments) {
  if (process.env.AUTO_ZOOM === "0") return;
  if (segments.some((s) => s.zoom || s.zoomTo)) return;
  segments.forEach((seg, i) => {
    if (i === 0 || i === segments.length - 1) return;
    const [a, b] = AUTO_ZOOM_PLAN[(i - 1) % AUTO_ZOOM_PLAN.length];
    seg.zoom = ZOOM_LEVELS[a];
    seg.zoomTo = ZOOM_LEVELS[b];
  });
}

/**
 * Ai đang nói thoại tại localT và miệng mở bao nhiêu (0..1) để drawScene vẽ nhép miệng.
 * Lời dẫn (narrator) không tính vì người kể không xuất hiện trong khung hình.
 */
export function talkingAt(seg, localT) {
  const parts = seg.raw?.voiceParts;
  const part = parts?.find((p) => p.kind === "dialogue" && localT >= p.start && localT < p.end);
  if (!part) return { speaker: null, mouth: 0 };
  const m = 0.25 + 0.75 * Math.abs(Math.sin(localT * 14)) * (0.6 + 0.4 * Math.abs(Math.sin(localT * 5.3 + 1)));
  return { speaker: part.speaker, mouth: Math.max(0, Math.min(1, m)) };
}

/** Camera của cảnh tại thời điểm localT: { scale, ox, oy } hoặc null nếu cảnh không dùng zoom. */
export function cameraAt(seg, localT, width, height) {
  if (!seg.zoom && !seg.zoomTo) return null;
  const hasQuestion = seg.holdAfterVoice > 0;
  const cap = (z) => (hasQuestion ? Math.min(z, QUESTION_MAX_ZOOM) : z);
  const z0 = cap(seg.zoom || seg.zoomTo);
  const z1 = cap(seg.zoomTo || seg.zoom);
  const dur = Math.max(0.1, seg.end - seg.start);
  const p = Math.max(0, Math.min(1, localT / dur));
  const e = p * p * (3 - 2 * p);
  const scale = z0 + (z1 - z0) * e;
  if (scale <= 1.0001) return null;
  const [fx, fy] = seg.focus || [0.5, 0.5];
  const ox = Math.max(width - width * scale, Math.min(0, width * fx - width * fx * scale));
  const oy = Math.max(height - height * scale, Math.min(0, height * fy - height * fy * scale));
  return { scale, ox, oy };
}

const NARR_PAD = 0.7;
// Khớp book-flip-kb.js: T_FLIP + T_HOLD + T_ZOOM_IN = 1.3 + 0.45 + 0.95; bìa/trang kết chỉ chờ T_FLIP.
// Giọng đọc bắt đầu khi trang lật xong + giữ (T_FLIP+T_HOLD), đúng lúc tranh bắt đầu phóng vào.
const FLIP_LEAD_STORY = 1.75;
const FLIP_LEAD_EDGE = 1.3;
const FLIP_EXTRA = 3.5;
// Khoảng lặng từ lúc đọc xong đến lúc bắt đầu lật sang cảnh sau (đã gồm cả đo���n thu nhỏ 0.8s cuối cảnh):
// luôn nằm trong [TAIL_GAP, TAIL_GAP + MAX_TAIL_SLACK] = 1.5-2.0s.
const TAIL_GAP = 1.5;
const MAX_TAIL_SLACK = 0.5;
const MIN_SCENE = 4;

/** Kéo dài mỗi cảnh để >= thời lượng giọng đọc + đệm (giống retimeTimeline của index.php). */
export function retimeSegments(segments, minTotal = 0) {
  let cursor = 0;
  for (const seg of segments) {
    const narr = seg.narration?.duration || 0;
    let lead = narr > 0 ? seg.leadMax : 0;
    const tail = (seg.leadMax ? TAIL_GAP : NARR_PAD) + (narr > 0 ? seg.holdAfterVoice || 0 : 0);
    const fit = (l) => {
      if (!(narr > 0)) return seg.origDuration;
      const need = l + narr + tail;
      // Cảnh có giọng đọc: kết thúc ngay sau khi đọc xong + đệm (không giữ thời lượng gốc của kịch bản, tránh chờ lâu mới chuyển cảnh).
      return Math.min(Math.max(MIN_SCENE, need), need + MAX_TAIL_SLACK);
    };
    let dur = fit(lead);
    if (lead && seg.scalesWithDuration) {
      // Hiệu ứng co đoạn mở đầu theo sc = min(1, D*0.55/EXTRA) khi cảnh ngắn; giải lặp cho khớp.
      for (let k = 0; k < 4; k++) {
        lead = seg.leadMax * Math.min(1, (dur * 0.55) / (seg.fxExtra || FLIP_EXTRA));
        dur = fit(lead);
      }
    }
    seg.lead = lead;
    seg.start = cursor;
    seg.end = cursor + dur;
    // Script vẽ dựa trên start/end của chính object cảnh.
    seg.raw.start = seg.start;
    seg.raw.end = seg.end;
    // Mốc giọng đọc thật (giây TRONG cảnh, đã cộng lead) để drawScene bám theo: câu hỏi, thần chú, vật ẩn...
    // Kịch bản cũ không đọc các trường này nên không bị ảnh hưởng.
    if (narr > 0 && seg.voiceParts?.length) {
      seg.raw.voiceParts = seg.voiceParts.map((p) => ({
        kind: p.kind,
        speaker: p.speaker,
        text: p.text,
        start: lead + p.start,
        end: lead + p.end,
      }));
      seg.raw.voiceStart = lead;
      seg.raw.voiceEnd = lead + narr;
    } else {
      delete seg.raw.voiceParts;
      delete seg.raw.voiceStart;
      delete seg.raw.voiceEnd;
    }
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

// Cách mép đầu/cuối cảnh tối thiểu (giây) để khung ảnh bìa luôn nằm trong cảnh quay thật:
// đầu cảnh là lật trang/rèm/clapper + phóng vào tranh, cuối cảnh là thu nhỏ + hiệu ứng chuyển cảnh.
const THUMB_HEAD_GUARD = 1.2;
const THUMB_TAIL_GUARD = 3.0;

/**
 * Chọn thời điểm (giây, theo timeline video) của khung hình dùng làm ảnh đại diện.
 * Chỉ lấy trong cảnh nội dung (bỏ bìa và trang kết nếu có hiệu ứng), ở giữa phần "tranh đứng yên",
 * tránh đoạn mở đầu (seg.lead) và đoạn cuối chứa hiệu ứng. Gọi SAU retimeSegments.
 */
export function pickThumbnailTime(story) {
  const segs = story.segments;
  const fx = !!story.bookFlip;
  const pool = fx && segs.length > 2 ? segs.slice(1, -1) : segs;
  // Ưu tiên khung hình của cảnh hook (nếu kịch bản có); kịch bản cũ không có thì giữ cách chọn cũ.
  const hook = segs.find((s) => s.isHook && s.end - s.start > 3);
  const seg = hook || pool[Math.min(Math.floor(pool.length / 3), pool.length - 1)];
  const dur = seg.end - seg.start;
  const head = fx ? Math.max(seg.lead || 0, seg.leadMax || 0) + THUMB_HEAD_GUARD : 0.5;
  const tail = fx ? THUMB_TAIL_GUARD : 0.5;
  const lo = head;
  const hi = Math.max(lo, dur - tail);
  const local = Math.min(hi, Math.max(lo, dur * 0.5));
  return { time: seg.start + Math.min(local, Math.max(0, dur - 0.1)), seg };
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
