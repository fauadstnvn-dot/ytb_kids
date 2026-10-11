// Phụ đề karaoke cho phần "action" — chuyển từ drawVideoCaption() của index.php.

export const CAPTION_FONT_FAMILY = "'Noto Sans', 'DejaVu Sans', sans-serif";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapCache = new Map();

function wrapWords(ctx, text, font, maxW) {
  const cacheKey = `${font}|${maxW}|${text}`;
  const hit = wrapCache.get(cacheKey);
  if (hit) return hit;
  ctx.font = font;
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = [];
  for (const w of words) {
    const test = [...line, w].join(" ");
    if (line.length && ctx.measureText(test).width > maxW) {
      lines.push(line);
      line = [w];
    } else {
      line.push(w);
    }
  }
  if (line.length) lines.push(line);
  wrapCache.set(cacheKey, lines);
  return lines;
}

/** Lời dẫn là phần đầu của giọng cảnh (voiceParts[0]); lời thoại nhân vật đọc sau đó. */
function narrationWindow(seg) {
  const part = seg.voiceParts?.find((p) => p.kind === "narration");
  if (part) return { from: (seg.lead || 0) + part.start, dur: part.end - part.start };
  const nd = seg.narration?.duration || 0;
  return { from: seg.lead || 0, dur: nd > 0 ? nd : seg.end - seg.start };
}

function karaokeProgress(seg, t) {
  const { from, dur } = narrationWindow(seg);
  return dur > 0 ? clamp((t - from) / dur, 0, 1) : 0;
}

/** Cửa sổ hiển thị bong bóng thoại: đúng lúc nhân vật nói (hoặc chia đều theo cảnh khi không có giọng TTS). */
function dialogueWindows(seg) {
  const dialogues = seg.dialogues || [];
  if (!dialogues.length) return [];
  const parts = seg.voiceParts?.filter((p) => p.kind === "dialogue");
  if (parts?.length) {
    return parts.map((p) => ({ ...p, from: (seg.lead || 0) + p.start - 0.1, to: (seg.lead || 0) + p.end + 0.45 }));
  }
  const total = Math.max(0.1, seg.end - seg.start);
  const slot = total / dialogues.length;
  return dialogues.map((d, i) => ({ ...d, from: i * slot, to: (i + 1) * slot }));
}

function bubblePath(ctx, x, y, w, h, r, tailX, tailW, tailH) {
  const tx = clamp(tailX, x + r + tailW, x + w - r - tailW);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(tx + tailW, y + h);
  ctx.lineTo(tailX, y + h + tailH);
  ctx.lineTo(tx - tailW, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Hộp thoại kiểu truyện tranh: chứa đủ toàn bộ lời nói, kèm tên nhân vật, đuôi chỉ xuống phía nhân vật. */
function drawBubble(ctx, W, H, win, side, t) {
  const S = H / 720;
  const age = clamp((t - win.from) / 0.25, 0, 1);
  const fade = clamp((win.to - t) / 0.2, 0, 1);
  const alpha = Math.min(age, fade);
  if (alpha <= 0) return;

  const maxW = W * 0.46;
  const padX = 26 * S;
  const padY = 18 * S;
  let px = Math.round(30 * S);
  let font = `700 ${px}px ${CAPTION_FONT_FAMILY}`;
  let lines = wrapWords(ctx, win.text, font, maxW - padX * 2);
  while (lines.length > 4 && px > 20 * S) {
    px -= 2;
    font = `700 ${px}px ${CAPTION_FONT_FAMILY}`;
    lines = wrapWords(ctx, win.text, font, maxW - padX * 2);
  }
  ctx.font = font;
  const lineH = px * 1.28;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l.join(" ")).width));
  const labelPx = Math.round(20 * S);
  const w = Math.min(maxW, textW + padX * 2);
  const h = lines.length * lineH + padY * 2;
  const x = side === "left" ? W * 0.07 : W * 0.93 - w;
  const y = H * 0.07 + 24 * S;
  const tailH = 34 * S;
  const tailX = side === "left" ? x + w * 0.28 : x + w * 0.72;

  ctx.save();
  ctx.globalAlpha = alpha;
  const pop = 0.92 + 0.08 * easeOutBack(age);
  ctx.translate(x + w / 2, y + h + tailH);
  ctx.scale(pop, pop);
  ctx.translate(-(x + w / 2), -(y + h + tailH));

  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 14 * S;
  ctx.shadowOffsetY = 4 * S;
  bubblePath(ctx, x, y, w, h, 22 * S, tailX, 16 * S, tailH);
  ctx.fillStyle = "#fffdf6";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 4 * S;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#2b2b2b";
  ctx.stroke();

  // Chip tên nhân vật, màu riêng theo nhân vật.
  ctx.font = `700 ${labelPx}px ${CAPTION_FONT_FAMILY}`;
  const labelW = ctx.measureText(win.label).width + 22 * S;
  const labelH = labelPx + 10 * S;
  const lx = x + 18 * S;
  const ly = y - labelH * 0.62;
  bubblePath(ctx, lx, ly, labelW, labelH, labelH / 2, lx + labelW / 2, 0, 0);
  ctx.fillStyle = win.color || "#fff4cf";
  ctx.fill();
  ctx.lineWidth = 3 * S;
  ctx.stroke();
  ctx.fillStyle = "#2b2b2b";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(win.label, lx + 11 * S, ly + labelH / 2 + 1 * S);

  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#2b2b2b";
  lines.forEach((l, i) => ctx.fillText(l.join(" "), x + padX, y + padY + i * lineH));
  ctx.restore();
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function drawDialogueBubbles(ctx, W, H, seg, t) {
  const wins = dialogueWindows(seg);
  if (!wins.length) return;
  const sides = new Map();
  for (const w of wins) if (!sides.has(w.speaker)) sides.set(w.speaker, sides.size % 2 === 0 ? "left" : "right");
  for (const w of wins) {
    if (t >= w.from && t < w.to) drawBubble(ctx, W, H, w, sides.get(w.speaker), t);
  }
}

export function drawCaption(ctx, W, H, seg, t) {
  drawDialogueBubbles(ctx, W, H, seg, t);
  const text = seg.narrationText;
  if (!text) return;
  const S = H / 720;
  const padX = 56 * S;
  const padBottom = 48 * S;
  const maxW = W - padX * 2;
  const px = Math.round(28 * S);
  const font = `400 ${px}px ${CAPTION_FONT_FAMILY}`;
  const lineH = 38 * S;

  const lines = wrapWords(ctx, text, font, maxW);
  if (!lines.length) return;
  const topY = H - padBottom - lines.length * lineH;
  const gradTop = topY - 48 * S;

  ctx.save();
  const grad = ctx.createLinearGradient(0, H, 0, gradTop);
  grad.addColorStop(0, "rgba(0,0,0,0.80)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradTop, W, H - gradTop);

  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 8 * S;
  ctx.shadowOffsetY = 2 * S;

  const spaceW = ctx.measureText(" ").width;
  const totalWords = lines.reduce((a, l) => a + l.length, 0);
  const prog = karaokeProgress(seg, t) * totalWords;
  const cur = Math.floor(prog);
  const frac = clamp(prog - cur, 0, 1);
  const pop = 1 - Math.min(1, frac / 0.55);
  const scale = 1.14 + 0.16 * pop;
  const lift = 4 * pop * S;

  let y = topY;
  let gi = 0;
  for (const line of lines) {
    let x = padX;
    for (const word of line) {
      const ww = ctx.measureText(word).width;
      ctx.save();
      if (gi === cur) {
        const cx = x + ww / 2;
        const cy = y + px * 0.5;
        ctx.translate(0, -lift);
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
        ctx.shadowOffsetY = 0;
        ctx.shadowColor = "rgba(255,180,40,0.55)";
        ctx.shadowBlur = 26 * S;
        ctx.fillStyle = "#ffd24a";
        ctx.fillText(word, x, y);
        ctx.shadowColor = "rgba(255,210,74,0.9)";
        ctx.shadowBlur = 14 * S;
        ctx.fillStyle = "#fff7c2";
        ctx.fillText(word, x, y);
        ctx.shadowBlur = 0;
        ctx.lineWidth = 0.8 * S;
        ctx.strokeStyle = "rgba(255,214,74,0.9)";
        ctx.strokeText(word, x, y);
      } else if (gi < cur) {
        ctx.fillStyle = "#ffd24a";
        ctx.fillText(word, x, y);
      } else {
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = "#cfe6dc";
        ctx.fillText(word, x, y);
      }
      ctx.restore();
      x += ww + spaceW;
      gi++;
    }
    y += lineH;
  }
  ctx.restore();
}
