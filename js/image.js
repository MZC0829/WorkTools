/* ==========================================================================
 * 图片工具：格式转换 · 压缩 · 裁剪 · 加/去水印
 * 共享一张「工作图」，各功能可链式操作（裁剪→加水印→压缩导出），支持撤销。
 * ========================================================================== */
'use strict';

(function () {

const MAX_DIM = 6000;   // 超大图按比例压到该尺寸内
const UNDO_MAX = 10;

const im = {
  file: null, base: '', origType: 'image/png',
  original: null,   // 原图 canvas
  work: null,       // 当前工作图 canvas
  undo: [],
  mode: 'convert',  // convert | compress | crop | wm
  wmMode: 'add',    // add | remove
  sel: null,        // 选区 {x,y,w,h}（裁剪 / 去水印共用，work 坐标系）
  drag: null,
  ratio: 0,         // 裁剪比例 w/h，0=自由
};
App.image = { state: im };

const canvas = $('#imageCanvas');
const ctx = canvas.getContext('2d');

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

/* ---------------- 加载 ---------------- */
async function fileToCanvas(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (_) {
    // SVG 等个别类型 createImageBitmap 可能失败，退化为 <img> 加载
    bmp = await new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('无法解码该图片')); };
      img.src = url;
    });
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  if (!w || !h) throw new Error('无法读取图片尺寸');
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return { c, scaled: scale < 1 };
}

async function imageHandleFile(file) {
  if (!file.type.startsWith('image/')) { toast('请选择图片文件', true); return; }
  try {
    const { c, scaled } = await fileToCanvas(file);
    im.file = file;
    im.base = file.name.replace(/\.[a-z0-9]+$/i, '') || 'image';
    im.origType = ['image/jpeg', 'image/webp'].includes(file.type) ? file.type : 'image/png';
    im.original = c;
    im.work = cloneCanvas(c);
    im.undo = []; im.sel = null; im.drag = null;
    fillImageCard();
    $('#imageDrop').classList.add('hidden');
    $('#imageBody').classList.remove('hidden');
    $('#imageResult').classList.add('hidden');
    setMode(im.mode || 'convert');
    if (scaled) toast(`图片较大，已等比压至 ${c.width} × ${c.height} 以保证流畅`);
  } catch (err) {
    console.error(err);
    toast('图片加载失败：' + friendlyError(err), true);
  }
}
App.image.handleFile = imageHandleFile;
bindDropzone('imageDrop', 'imageInput', imageHandleFile);

function fillImageCard() {
  const card = $('#imageFileCard');
  card.innerHTML = `<div class="fc-icon">🖼️</div><div><div class="fc-name"></div><div class="fc-meta"></div></div>`;
  $('.fc-name', card).textContent = im.file.name;
  updateMeta();
}

function updateMeta() {
  $('.fc-meta', $('#imageFileCard')).textContent =
    `${formatSize(im.file.size)} · 原始 ${im.original.width} × ${im.original.height}`;
  $('#imMeta').textContent = `当前：${im.work.width} × ${im.work.height} px` +
    (im.undo.length ? ` · 已编辑 ${im.undo.length} 步` : '');
  $('#btnImUndo').disabled = !im.undo.length;
}

function resetImage() {
  im.file = null; im.original = null; im.work = null;
  im.undo = []; im.sel = null; im.drag = null;
  canvas.width = 4; canvas.height = 4;
  $('#imageBody').classList.add('hidden');
  $('#imageResult').classList.add('hidden');
  $('#imageDrop').classList.remove('hidden');
}
App.image.reset = resetImage;

/* 粘贴图片（图片工具标签页激活时） */
document.addEventListener('paste', e => {
  if (!$('#tab-image').classList.contains('active')) return;
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) { e.preventDefault(); imageHandleFile(f); }
      return;
    }
  }
});

/* ---------------- 撤销 / 重置 ---------------- */
function snapshot() {
  im.undo.push(cloneCanvas(im.work));
  if (im.undo.length > UNDO_MAX) im.undo.shift();
}
$('#btnImUndo').addEventListener('click', () => {
  if (!im.undo.length) return;
  im.work = im.undo.pop();
  im.sel = null;
  redraw(); updateMeta(); scheduleEstimates();
});
$('#btnImRestore').addEventListener('click', () => {
  if (!im.original) return;
  im.work = cloneCanvas(im.original);
  im.undo = []; im.sel = null;
  redraw(); updateMeta(); scheduleEstimates();
  toast('已重置为原图');
});

/* ---------------- 模式切换 ---------------- */
const PANES = { convert: 'imPaneConvert', compress: 'imPaneCompress', crop: 'imPaneCrop', wm: 'imPaneWm' };

function setMode(mode) {
  im.mode = mode;
  im.sel = null; im.drag = null;
  $$('.im-tab').forEach(b => b.classList.toggle('active', b.dataset.imode === mode));
  Object.entries(PANES).forEach(([k, id]) => $('#' + id).classList.toggle('hidden', k !== mode));
  const interactive = mode === 'crop' || (mode === 'wm' && im.wmMode === 'remove');
  canvas.classList.toggle('im-interactive', interactive);
  updateSelInfo();
  redraw(); updateMeta(); scheduleEstimates();
}
$$('.im-tab').forEach(b => b.addEventListener('click', () => setMode(b.dataset.imode)));

$$('.wm-mode').forEach(b => b.addEventListener('click', () => {
  im.wmMode = b.dataset.wm;
  im.sel = null; im.drag = null;
  $$('.wm-mode').forEach(x => x.classList.toggle('active', x === b));
  $('#wmAddPane').classList.toggle('hidden', im.wmMode !== 'add');
  $('#wmRemovePane').classList.toggle('hidden', im.wmMode !== 'remove');
  canvas.classList.toggle('im-interactive', im.wmMode === 'remove');
  updateSelInfo();
  redraw();
}));

/* ---------------- 画布绘制 ---------------- */
function viewScale() {
  const r = canvas.getBoundingClientRect();
  return r.width > 0 ? canvas.width / r.width : 1;
}

function redraw() {
  if (!im.work) return;
  if (canvas.width !== im.work.width || canvas.height !== im.work.height) {
    canvas.width = im.work.width;
    canvas.height = im.work.height;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(im.work, 0, 0);

  if (im.mode === 'wm' && im.wmMode === 'add') {
    drawWatermark(ctx, canvas.width, canvas.height, wmSettings()); // 实时预览
  }
  const showSel = im.sel && (im.mode === 'crop' || (im.mode === 'wm' && im.wmMode === 'remove'));
  if (showSel) drawSelection(im.mode === 'crop');
}

function drawSelection(withMask) {
  const s = im.sel, k = viewScale();
  ctx.save();
  if (withMask) {
    ctx.fillStyle = 'rgba(10, 14, 22, .45)';
    ctx.fillRect(0, 0, canvas.width, s.y);
    ctx.fillRect(0, s.y + s.h, canvas.width, canvas.height - s.y - s.h);
    ctx.fillRect(0, s.y, s.x, s.h);
    ctx.fillRect(s.x + s.w, s.y, canvas.width - s.x - s.w, s.h);
  }
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2 * k;
  ctx.setLineDash(withMask ? [] : [8 * k, 5 * k]);
  ctx.strokeRect(s.x, s.y, s.w, s.h);
  ctx.setLineDash([]);
  // 四角手柄
  const hs = 9 * k;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,.4)';
  ctx.lineWidth = 1 * k;
  for (const [hx, hy] of selCorners()) {
    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
  }
  ctx.restore();
}

function selCorners() {
  const s = im.sel;
  return [[s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.h], [s.x + s.w, s.y + s.h]];
}

/* ---------------- 选区交互（裁剪 / 去水印共用） ---------------- */
function imgPoint(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (e.clientX - r.left) * (canvas.width / r.width))),
    y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top) * (canvas.height / r.height))),
  };
}

function hitTest(p) {
  if (!im.sel) return null;
  const k = viewScale(), tol = 14 * k;
  const names = ['nw', 'ne', 'sw', 'se'];
  const corners = selCorners();
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p.x - corners[i][0]) < tol && Math.abs(p.y - corners[i][1]) < tol) return names[i];
  }
  const s = im.sel;
  if (p.x > s.x && p.x < s.x + s.w && p.y > s.y && p.y < s.y + s.h) return 'move';
  return null;
}

function clampSel() {
  const s = im.sel;
  s.w = Math.min(s.w, canvas.width);
  s.h = Math.min(s.h, canvas.height);
  s.x = Math.max(0, Math.min(s.x, canvas.width - s.w));
  s.y = Math.max(0, Math.min(s.y, canvas.height - s.h));
}

canvas.addEventListener('pointerdown', e => {
  if (!im.work || e.button !== 0) return;
  const interactive = im.mode === 'crop' || (im.mode === 'wm' && im.wmMode === 'remove');
  if (!interactive || im.drag) return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件 */ }
  const p = imgPoint(e);
  const hit = hitTest(p);
  if (hit === 'move') {
    im.drag = { id: e.pointerId, kind: 'move', dx: p.x - im.sel.x, dy: p.y - im.sel.y };
  } else if (hit) {
    // 拖角：以对角为锚点重新拉伸
    const s = im.sel;
    const anchor = {
      nw: [s.x + s.w, s.y + s.h], ne: [s.x, s.y + s.h],
      sw: [s.x + s.w, s.y], se: [s.x, s.y],
    }[hit];
    im.drag = { id: e.pointerId, kind: 'resize', ax: anchor[0], ay: anchor[1] };
  } else {
    im.drag = { id: e.pointerId, kind: 'create', ax: p.x, ay: p.y };
    im.sel = { x: p.x, y: p.y, w: 0, h: 0 };
  }
});

canvas.addEventListener('pointermove', e => {
  if (!im.drag || e.pointerId !== im.drag.id) return;
  e.preventDefault();
  const p = imgPoint(e);
  const d = im.drag;
  if (d.kind === 'move') {
    im.sel.x = p.x - d.dx;
    im.sel.y = p.y - d.dy;
    clampSel();
  } else {
    // create / resize：由锚点与当前点确定矩形，裁剪模式下按比例约束
    let w = p.x - d.ax, h = p.y - d.ay;
    const ratio = im.mode === 'crop' ? im.ratio : 0;
    if (ratio > 0) {
      const sw = Math.sign(w) || 1, sh = Math.sign(h) || 1;
      if (Math.abs(w) / ratio > Math.abs(h)) h = sh * Math.abs(w) / ratio;
      else w = sw * Math.abs(h) * ratio;
    }
    im.sel = {
      x: Math.min(d.ax, d.ax + w), y: Math.min(d.ay, d.ay + h),
      w: Math.abs(w), h: Math.abs(h),
    };
    clampSel();
  }
  updateSelInfo();
  redraw();
});

function endDrag(e) {
  if (!im.drag || e.pointerId !== im.drag.id) return;
  im.drag = null;
  if (im.sel && (im.sel.w < 8 || im.sel.h < 8)) im.sel = null; // 过小视为误触
  updateSelInfo();
  redraw();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function updateSelInfo() {
  const s = im.sel;
  $('#cropInfo').textContent = s
    ? `选区：${Math.round(s.w)} × ${Math.round(s.h)} px（位于 ${Math.round(s.x)}, ${Math.round(s.y)}）`
    : '在图片上拖拽框选裁剪区域';
  $('#wmRmInfo').textContent = s
    ? `选区：${Math.round(s.w)} × ${Math.round(s.h)} px，点击「修复此区域」`
    : '在图片上拖拽框选要移除的水印区域';
  $('#btnApplyCrop').disabled = !s;
  $('#btnWmFix').disabled = !s;
}

/* ---------------- 裁剪 ---------------- */
$$('.ratio-chip').forEach(b => b.addEventListener('click', () => {
  $$('.ratio-chip').forEach(x => x.classList.toggle('active', x === b));
  im.ratio = parseFloat(b.dataset.ratio) || 0;
  // 已有选区时按新比例调整（保持左上角与宽度）
  if (im.sel && im.ratio > 0) {
    im.sel.h = im.sel.w / im.ratio;
    clampSel(); updateSelInfo(); redraw();
  }
}));

$('#btnCancelSel').addEventListener('click', () => { im.sel = null; updateSelInfo(); redraw(); });
$('#btnWmCancelSel').addEventListener('click', () => { im.sel = null; updateSelInfo(); redraw(); });

$('#btnApplyCrop').addEventListener('click', () => {
  const s = im.sel;
  if (!s) return;
  snapshot();
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(s.w));
  c.height = Math.max(1, Math.round(s.h));
  c.getContext('2d').drawImage(im.work, Math.round(s.x), Math.round(s.y), c.width, c.height, 0, 0, c.width, c.height);
  im.work = c;
  im.sel = null;
  updateSelInfo(); redraw(); updateMeta(); scheduleEstimates();
  toast(`已裁剪为 ${c.width} × ${c.height}，可继续操作或撤销`);
});

/* ---------------- 水印：添加 ---------------- */
function wmSettings() {
  return {
    text: $('#wmText').value || '水印',
    sizePct: +$('#wmSize').value,
    color: $('#wmColor').value,
    opacity: +$('#wmOpacity').value / 100,
    angle: +$('#wmAngle').value,
    tile: $('#wmTile').checked,
    pos: $('#wmPos').value,
  };
}

function drawWatermark(tctx, W, H, s) {
  const size = Math.max(10, Math.round(Math.max(W, H) * s.sizePct / 100));
  tctx.save();
  tctx.globalAlpha = s.opacity;
  tctx.fillStyle = s.color;
  tctx.font = `${size}px -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
  tctx.textBaseline = 'middle';
  tctx.textAlign = 'center';
  const rad = s.angle * Math.PI / 180;
  const textW = tctx.measureText(s.text).width;
  if (s.tile) {
    const stepX = textW + size * 3;
    const stepY = size * 3.5;
    const diag = Math.hypot(W, H);
    tctx.translate(W / 2, H / 2);
    tctx.rotate(rad);
    let row = 0;
    for (let y = -diag / 2; y <= diag / 2; y += stepY, row++) {
      const off = (row % 2) * stepX / 2;
      for (let x = -diag / 2 - off; x <= diag / 2; x += stepX) {
        tctx.fillText(s.text, x, y);
      }
    }
  } else {
    const m = size * 0.8;
    const xs = { l: m + textW / 2, c: W / 2, r: W - m - textW / 2 };
    const ys = { t: m + size / 2, m: H / 2, b: H - m - size / 2 };
    const px = xs[{ tl: 'l', tc: 'c', tr: 'r', ml: 'l', mc: 'c', mr: 'r', bl: 'l', bc: 'c', br: 'r' }[s.pos] || 'r'];
    const py = ys[{ tl: 't', tc: 't', tr: 't', ml: 'm', mc: 'm', mr: 'm', bl: 'b', bc: 'b', br: 'b' }[s.pos] || 'b'];
    tctx.translate(px, py);
    tctx.rotate(rad);
    tctx.fillText(s.text, 0, 0);
  }
  tctx.restore();
}

['wmText', 'wmSize', 'wmColor', 'wmOpacity', 'wmAngle', 'wmTile', 'wmPos'].forEach(id => {
  $('#' + id).addEventListener('input', () => {
    $('#wmSizeVal').textContent = $('#wmSize').value;
    $('#wmOpacityVal').textContent = $('#wmOpacity').value;
    $('#wmAngleVal').textContent = $('#wmAngle').value;
    if (im.mode === 'wm' && im.wmMode === 'add') redraw();
  });
});
$('#wmTile').addEventListener('change', () => {
  $('#wmPos').classList.toggle('hidden', $('#wmTile').checked);
  if (im.mode === 'wm') redraw();
});

$('#btnWmApply').addEventListener('click', () => {
  if (!im.work) return;
  snapshot();
  drawWatermark(im.work.getContext('2d'), im.work.width, im.work.height, wmSettings());
  redraw(); updateMeta(); scheduleEstimates();
  toast('水印已写入图片，可撤销或继续操作');
});

/* ---------------- 水印：移除 ---------------- */
/* 平滑填充：区域内每个像素由四边边界颜色按距离加权插值，适合纯色/渐变背景 */
function smoothFill(c, x, y, w, h) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  const bx = Math.max(0, x - 1), by = Math.max(0, y - 1);
  const bw = Math.min(c.width - bx, w + 2), bh = Math.min(c.height - by, h + 2);
  if (bw < 3 || bh < 3) return;
  const cx = c.getContext('2d');
  const ring = cx.getImageData(bx, by, bw, bh);
  const rd = ring.data;
  const get = (ix, iy, ch) => rd[(iy * bw + ix) * 4 + ch];
  const out = cx.getImageData(x, y, Math.min(w, c.width - x), Math.min(h, c.height - y));
  const ow = out.width, oh = out.height, od = out.data;
  for (let j = 0; j < oh; j++) {
    const ty = (j + 1) / (oh + 1);
    const iy = j + (y - by);
    for (let i = 0; i < ow; i++) {
      const tx = (i + 1) / (ow + 1);
      const ix = i + (x - bx);
      const dh = Math.min(tx, 1 - tx) + 0.02;
      const dv = Math.min(ty, 1 - ty) + 0.02;
      const wH = 1 / dh, wV = 1 / dv;
      for (let ch = 0; ch < 3; ch++) {
        const hVal = get(0, iy, ch) * (1 - tx) + get(bw - 1, iy, ch) * tx;
        const vVal = get(ix, 0, ch) * (1 - ty) + get(ix, bh - 1, ch) * ty;
        od[(j * ow + i) * 4 + ch] = (hVal * wH + vVal * wV) / (wH + wV);
      }
      od[(j * ow + i) * 4 + 3] = 255;
    }
  }
  cx.putImageData(out, x, y);
}

function mosaicFill(c, x, y, w, h) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  const cx = c.getContext('2d');
  const block = Math.max(8, Math.round(Math.max(w, h) / 18));
  const sw = Math.max(1, Math.ceil(w / block)), sh = Math.max(1, Math.ceil(h / block));
  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  tmp.getContext('2d').drawImage(c, x, y, w, h, 0, 0, sw, sh);
  cx.save();
  cx.imageSmoothingEnabled = false;
  cx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
  cx.restore();
}

$('#btnWmFix').addEventListener('click', () => {
  const s = im.sel;
  if (!s) return;
  snapshot();
  const method = document.querySelector('input[name=wmFix]:checked').value;
  if (method === 'mosaic') mosaicFill(im.work, s.x, s.y, s.w, s.h);
  else smoothFill(im.work, s.x, s.y, s.w, s.h);
  im.sel = null;
  updateSelInfo(); redraw(); updateMeta();
  toast(method === 'mosaic' ? '已对选区打码' : '已修复选区，可继续框选其他区域');
});

/* ---------------- 编码与导出 ---------------- */
async function encodeWork(type, quality, scalePct) {
  let src = im.work;
  if (scalePct && scalePct < 100) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * scalePct / 100));
    c.height = Math.max(1, Math.round(src.height * scalePct / 100));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    src = c;
  }
  if (type === 'image/jpeg') {
    // JPEG 无透明通道：先铺白底
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0);
    src = c;
  }
  const blob = await new Promise(r => src.toBlob(r, type, quality));
  if (!blob) throw new Error('图片编码失败');
  if (blob.type !== type) throw new Error(`当前浏览器不支持导出 ${type.split('/')[1].toUpperCase()} 格式`);
  return blob;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/* 预估输出大小（防抖），转换与压缩两个面板共用 */
let estTimer = null, estGen = 0;
function scheduleEstimates() {
  clearTimeout(estTimer);
  estTimer = setTimeout(runEstimates, 250);
}
async function runEstimates() {
  if (!im.work) return;
  const gen = ++estGen;
  try {
    if (im.mode === 'convert') {
      const type = $('#cvFormat').value;
      const blob = await encodeWork(type, +$('#cvQuality').value / 100);
      if (gen !== estGen) return;
      $('#cvEstimate').textContent = `预计输出：${formatSize(blob.size)}（原始文件 ${formatSize(im.file.size)}）`;
    } else if (im.mode === 'compress') {
      const blob = await encodeWork($('#imCpFormat').value, +$('#imQuality').value / 100, +$('#imScale').value);
      if (gen !== estGen) return;
      const saved = 1 - blob.size / im.file.size;
      const sw = Math.round(im.work.width * $('#imScale').value / 100);
      const sh = Math.round(im.work.height * $('#imScale').value / 100);
      $('#imEstimate').innerHTML =
        `原始 ${formatSize(im.file.size)} → 预计 <b>${formatSize(blob.size)}</b>` +
        (saved > 0 ? `，节省 <b>${Math.round(saved * 100)}%</b>` : '（未减小，试试降低质量或尺寸）') +
        ` · 输出 ${sw} × ${sh}`;
    }
  } catch (err) {
    if (gen !== estGen) return;
    const el = im.mode === 'convert' ? $('#cvEstimate') : $('#imEstimate');
    el.textContent = friendlyError(err);
  }
}

['cvFormat', 'cvQuality'].forEach(id => $('#' + id).addEventListener('input', () => {
  $('#cvQualityVal').textContent = $('#cvQuality').value;
  $('#cvQualityRow').style.opacity = $('#cvFormat').value === 'image/png' ? .45 : 1;
  scheduleEstimates();
}));
['imQuality', 'imScale', 'imCpFormat'].forEach(id => $('#' + id).addEventListener('input', () => {
  $('#imQualityVal').textContent = $('#imQuality').value;
  $('#imScaleVal').textContent = $('#imScale').value;
  scheduleEstimates();
}));

async function exportImage(type, quality, scalePct, suffix) {
  try {
    const blob = await encodeWork(type, quality, scalePct);
    const name = `${im.base}${suffix}.${EXT[type]}`;
    const saved = 1 - blob.size / im.file.size;
    showResult($('#imageResult'), '导出完成',
      `${im.work.width} × ${im.work.height}${scalePct && scalePct < 100 ? `（缩放 ${scalePct}%）` : ''} · ` +
      `输出大小 <b>${formatSize(blob.size)}</b>` +
      (saved > 0.01 ? `，较原始文件节省 <b>${Math.round(saved * 100)}%</b>` : ''),
      blob, name);
  } catch (err) {
    console.error(err);
    toast('导出失败：' + friendlyError(err), true);
  }
}

$('#btnCvExport').addEventListener('click', () =>
  exportImage($('#cvFormat').value, +$('#cvQuality').value / 100, 100, ''));
$('#btnImCompress').addEventListener('click', () =>
  exportImage($('#imCpFormat').value, +$('#imQuality').value / 100, +$('#imScale').value, '-压缩'));
$('#btnImExportCrop').addEventListener('click', () =>
  exportImage(im.origType, 0.92, 100, '-编辑'));
$('#btnImExportWm').addEventListener('click', () =>
  exportImage(im.origType, 0.92, 100, '-编辑'));

/* 初始化控件显示值 */
$('#wmSizeVal').textContent = $('#wmSize').value;
$('#wmOpacityVal').textContent = $('#wmOpacity').value;
$('#wmAngleVal').textContent = $('#wmAngle').value;

})();
