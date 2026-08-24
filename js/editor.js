/* ==========================================================================
 * 文档编辑：马赛克 · 矩形框 · 高亮 · 直线 · 手绘 · 遮盖 · 文字
 * 预览在 canvas 上进行；导出时矢量标注直接叠加到原 PDF 页面（保留原文字层），
 * 马赛克以图像补丁嵌入。坐标经 pdf.js viewport.convertToPdfPoint 映射，兼容旋转页。
 * ========================================================================== */
'use strict';

(function () {

const SCALE = 2; // 编辑画布渲染倍率（相对 72dpi 的 2 倍 = 144dpi）

const ed = {
  file: null, bytes: null, doc: null, pageCount: 0,
  cur: 1,
  base: null,            // 当前页底图（渲染后的 canvas）
  ops: {},               // { 页码: [op, ...] }
  redo: {},              // { 页码: [op, ...] }
  tool: null,
  drag: null,            // 进行中的拖拽 {x0,y0,x1,y1,pts}
  textAnchor: null,      // 文字输入锚点（canvas 坐标）
};
App.editor = { state: ed };

const canvas = $('#editCanvas');
const ctx = canvas.getContext('2d');
const stage = $('#editStage');
const textInput = $('#edTextInput');

/* ---------------- 小工具 ---------------- */
const curOps = () => (ed.ops[ed.cur] || (ed.ops[ed.cur] = []));
const curRedo = () => (ed.redo[ed.cur] || (ed.redo[ed.cur] = []));

function hexToRgb01(hex) {
  const v = parseInt(hex.slice(1), 16);
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
}

function normRect(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  // 钳制到画布范围内：指针捕获时拖出边缘不会产生越界坐标，
  // 保证预览打码区域、补丁取样区域与导出放置区域三者一致
  return {
    x: Math.max(0, Math.min(canvas.width, (e.clientX - r.left) * (canvas.width / r.width))),
    y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top) * (canvas.height / r.height))),
  };
}

function settings() {
  return { color: $('#edColor').value, lw: +$('#edWidth').value, fontSize: +$('#edFontSize').value };
}

/* ---------------- 绘制（canvas 预览与导出复用同一语义） ---------------- */
function pixelateRegion(c, x, y, w, h) {
  const cx = c.getContext('2d');
  x = Math.round(Math.max(0, x)); y = Math.round(Math.max(0, y));
  w = Math.round(Math.min(w, c.width - x)); h = Math.round(Math.min(h, c.height - y));
  if (w < 4 || h < 4) return;
  const block = Math.max(10, Math.round(Math.max(w, h) / 20));
  const sw = Math.max(1, Math.ceil(w / block)), sh = Math.max(1, Math.ceil(h / block));
  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(c, x, y, w, h, 0, 0, sw, sh);
  cx.save();
  cx.imageSmoothingEnabled = false;
  cx.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
  cx.restore();
}

/* 将单个 op 应用到工作画布（用于屏幕合成与导出重放） */
function applyOp(c, op) {
  const cx = c.getContext('2d');
  cx.save();
  switch (op.t) {
    case 'mosaic':
      pixelateRegion(c, op.x, op.y, op.w, op.h);
      break;
    case 'rect':
      cx.strokeStyle = op.color;
      cx.lineWidth = op.lw * SCALE;
      cx.strokeRect(op.x, op.y, op.w, op.h);
      break;
    case 'highlight':
      cx.globalCompositeOperation = 'multiply';
      cx.globalAlpha = 0.42;
      cx.fillStyle = op.color;
      cx.fillRect(op.x, op.y, op.w, op.h);
      break;
    case 'whiteout':
      cx.fillStyle = '#ffffff';
      cx.fillRect(op.x, op.y, op.w, op.h);
      break;
    case 'line':
      cx.strokeStyle = op.color;
      cx.lineWidth = op.lw * SCALE;
      cx.lineCap = 'round';
      cx.beginPath(); cx.moveTo(op.x1, op.y1); cx.lineTo(op.x2, op.y2); cx.stroke();
      break;
    case 'pen':
      cx.strokeStyle = op.color;
      cx.lineWidth = op.lw * SCALE;
      cx.lineCap = 'round'; cx.lineJoin = 'round';
      cx.beginPath();
      op.pts.forEach((p, i) => i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y));
      cx.stroke();
      break;
    case 'text':
      cx.fillStyle = op.color;
      cx.font = `${op.sizePt * SCALE}px -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
      cx.textBaseline = 'alphabetic';
      cx.fillText(op.text, op.x, op.y);
      break;
  }
  cx.restore();
}

/* 拖拽过程中的临时预览（虚线示意） */
function drawPreview(dr) {
  const s = settings();
  ctx.save();
  if (ed.tool === 'line') {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.lw * SCALE; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(dr.x0, dr.y0); ctx.lineTo(dr.x1, dr.y1); ctx.stroke();
  } else if (ed.tool === 'pen') {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.lw * SCALE; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    dr.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.stroke();
  } else {
    const r = normRect(dr.x0, dr.y0, dr.x1, dr.y1);
    if (ed.tool === 'highlight') {
      ctx.globalAlpha = 0.35; ctx.fillStyle = s.color; ctx.fillRect(r.x, r.y, r.w, r.h);
    } else if (ed.tool === 'whiteout') {
      ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff'; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1; ctx.setLineDash([6, 4]); ctx.strokeStyle = '#8896b3'; ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    } else { // mosaic / rect
      ctx.setLineDash(ed.tool === 'mosaic' ? [6, 4] : []);
      ctx.strokeStyle = ed.tool === 'mosaic' ? '#3b6cf0' : s.color;
      ctx.lineWidth = ed.tool === 'mosaic' ? 2 : s.lw * SCALE;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      if (ed.tool === 'mosaic') {
        ctx.globalAlpha = 0.12; ctx.fillStyle = '#3b6cf0'; ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    }
  }
  ctx.restore();
}

function redraw(previewDrag) {
  if (!ed.base) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(ed.base, 0, 0);
  // 逐个应用已提交的 op（马赛克需要作用在当前合成结果上，故直接在显示画布上重放）
  for (const op of curOps()) applyOp(canvas, op);
  if (previewDrag) drawPreview(previewDrag);
}

/* ---------------- 页面加载与导航 ---------------- */
async function renderBase(doc, pageNum) {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: SCALE });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const cx = c.getContext('2d');
  cx.fillStyle = '#ffffff';
  cx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: cx, viewport: vp, intent: 'print' }).promise;
  return c;
}

/* 代际令牌：并发翻页时只有最后一次调用生效，过期渲染被丢弃 */
let gotoGen = 0;
let pageLoading = false;

async function gotoPage(n) {
  n = Math.max(1, Math.min(ed.pageCount, n));
  commitTextInput();
  ed.drag = null;
  ed.cur = n;
  $('#edPageInput').value = n;
  const gen = ++gotoGen;
  pageLoading = true;
  const base = await renderBase(ed.doc, n);
  if (gen !== gotoGen || !ed.doc) return; // 已被更晚的翻页/重置取代
  ed.base = base;
  canvas.width = base.width;
  canvas.height = base.height;
  pageLoading = false;
  redraw();
  updateChrome();
}

function editedPages() {
  return Object.keys(ed.ops).filter(k => ed.ops[k] && ed.ops[k].length).map(Number);
}

function updateChrome() {
  $('#edPageTotal').textContent = ed.pageCount;
  $('#btnEdPrev').disabled = ed.cur <= 1;
  $('#btnEdNext').disabled = ed.cur >= ed.pageCount;
  $('#btnEdUndo').disabled = !curOps().length;
  $('#btnEdRedo').disabled = !curRedo().length;
  const pages = editedPages();
  $('#edEditedInfo').textContent = pages.length
    ? `· 已编辑 ${pages.length} 页（本页 ${curOps().length} 处）` : '';
}

async function editHandleFile(file) {
  if (exporting) { toast('正在导出，请稍候…', true); return; }
  if (!/\.pdf$/i.test(file.name)) { toast('请选择 PDF 文件（Word 文档请先在「格式转换」中转为 PDF）', true); return; }
  resetEdit();
  try {
    ed.bytes = await fileToBytes(file);
    ed.doc = await openPdfJs(ed.bytes);
    ed.file = file;
    ed.pageCount = ed.doc.numPages;
    fillFileCard($('#editFileCard'), file, `${ed.pageCount} 页 · 选择左侧工具后在页面上拖拽/点击`);
    $('#editDrop').classList.add('hidden');
    $('#editBody').classList.remove('hidden');
    $('#edPageInput').max = ed.pageCount;
    selectTool('mosaic');
    await gotoPage(1);
  } catch (err) {
    console.error(err);
    toast('PDF 读取失败：' + friendlyError(err), true);
    resetEdit();
  }
}

function resetEdit() {
  if (exporting) { toast('正在导出，请稍候…', true); return; }
  gotoGen++; // 使在途的 gotoPage 渲染失效
  pageLoading = false;
  if (ed.doc) { ed.doc.destroy(); ed.doc = null; }
  commitTextInput(true);
  ed.file = null; ed.bytes = null; ed.pageCount = 0; ed.cur = 1;
  ed.base = null; ed.ops = {}; ed.redo = {}; ed.drag = null;
  ed.autoFlattenDone = false;
  $('#edFlatten').checked = false;
  canvas.width = 4; canvas.height = 4;
  $('#editBody').classList.add('hidden');
  $('#editResult').classList.add('hidden');
  hideProgress($('#editProgress'));
  $('#editDrop').classList.remove('hidden');
}
App.editor.handleFile = editHandleFile;
App.editor.reset = resetEdit;
bindDropzone('editDrop', 'editInput', editHandleFile);

/* ---------------- 工具选择 ---------------- */
function selectTool(tool) {
  commitTextInput();
  if (ed.tool !== 'picker') ed.prevTool = ed.tool; // 记住取色前的工具，取色后自动切回
  ed.tool = tool;
  $$('#toolGroup .tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.classList.toggle('tool-text', tool === 'text');
  canvas.classList.toggle('tool-picker', tool === 'picker');
  canvas.classList.toggle('tool-active', tool !== 'text' && tool !== 'picker');
}
$$('#toolGroup .tool-btn').forEach(b => b.addEventListener('click', () => selectTool(b.dataset.tool)));
App.editor.selectTool = selectTool;

$('#edWidth').addEventListener('input', e => { $('#edWidthVal').textContent = e.target.value; });
$('#edFontSize').addEventListener('input', e => { $('#edFontVal').textContent = e.target.value; });

/* ---------------- 提交 op / 撤销 / 重做 ---------------- */
function commitOp(op) {
  curOps().push(op);
  ed.redo[ed.cur] = [];
  // 首次打码/遮盖时自动开启扁平化，防止被遮挡的原文字仍可被复制提取（用户可取消勾选）
  if ((op.t === 'mosaic' || op.t === 'whiteout') && !ed.autoFlattenDone) {
    ed.autoFlattenDone = true;
    const cb = $('#edFlatten');
    if (!cb.checked) {
      cb.checked = true;
      toast('已自动勾选「扁平化已编辑页」，导出时将彻底移除被遮挡的原内容；如需保留原文字层可取消勾选');
    }
  }
  redraw();
  updateChrome();
}
App.editor.commitOp = commitOp;

$('#btnEdUndo').addEventListener('click', doUndo);
$('#btnEdRedo').addEventListener('click', doRedo);
function doUndo() {
  const ops = curOps();
  if (!ops.length) return;
  curRedo().push(ops.pop());
  redraw(); updateChrome();
}
function doRedo() {
  const r = curRedo();
  if (!r.length) return;
  curOps().push(r.pop());
  redraw(); updateChrome();
}
$('#btnEdClear').addEventListener('click', () => {
  if (!curOps().length) return;
  if (!App.testMode && !confirm('清除本页的全部标注？')) return;
  ed.ops[ed.cur] = []; ed.redo[ed.cur] = [];
  redraw(); updateChrome();
});

document.addEventListener('keydown', e => {
  if (!docPaneActive('tab-edit') || !ed.doc) return;
  if (e.target === textInput || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? doRedo() : doUndo();
  }
});

/* ---------------- 画布交互 ---------------- */
canvas.addEventListener('pointerdown', e => {
  if (!ed.doc || !ed.tool || e.button !== 0 || pageLoading) return;
  if (ed.drag) return; // 拖拽进行中，忽略第二根手指
  if (ed.tool === 'text') { openTextInput(e); return; }
  if (ed.tool === 'picker') { pickColorAt(e); return; }
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件无真实指针时忽略 */ }
  const p = canvasPoint(e);
  ed.drag = { id: e.pointerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y, pts: [{ x: p.x, y: p.y }] };
});
canvas.addEventListener('pointermove', e => {
  if (!ed.drag || e.pointerId !== ed.drag.id) return;
  e.preventDefault();
  const p = canvasPoint(e);
  ed.drag.x1 = p.x; ed.drag.y1 = p.y;
  if (ed.tool === 'pen') ed.drag.pts.push({ x: p.x, y: p.y });
  redraw(ed.drag);
});
canvas.addEventListener('pointerup', e => {
  if (!ed.drag || e.pointerId !== ed.drag.id) return;
  const dr = ed.drag;
  ed.drag = null;
  const s = settings();
  const dist = Math.hypot(dr.x1 - dr.x0, dr.y1 - dr.y0);
  if (ed.tool === 'pen') {
    if (dr.pts.length > 1) commitOp({ t: 'pen', pts: dr.pts, color: s.color, lw: s.lw });
    else redraw();
  } else if (ed.tool === 'line') {
    if (dist > 3) commitOp({ t: 'line', x1: dr.x0, y1: dr.y0, x2: dr.x1, y2: dr.y1, color: s.color, lw: s.lw });
    else redraw();
  } else {
    const r = normRect(dr.x0, dr.y0, dr.x1, dr.y1);
    if (r.w > 4 && r.h > 4) {
      const op = { t: ed.tool, x: r.x, y: r.y, w: r.w, h: r.h };
      if (ed.tool === 'rect' || ed.tool === 'highlight') { op.color = s.color; op.lw = s.lw; }
      commitOp(op);
    } else redraw();
  }
});
canvas.addEventListener('pointercancel', e => {
  if (ed.drag && e.pointerId === ed.drag.id) { ed.drag = null; redraw(); }
});

/* ---------------- 拾色器：点击页面取色，设为当前标注颜色 ---------------- */
function pickColorAt(e) {
  const p = canvasPoint(e);
  const x = Math.min(canvas.width - 1, Math.max(0, Math.round(p.x)));
  const y = Math.min(canvas.height - 1, Math.max(0, Math.round(p.y)));
  const d = ctx.getImageData(x, y, 1, 1).data; // 画布为当前合成结果（底图+标注）
  const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  $('#edColor').value = hex;
  toast(`已取色 ${hex.toUpperCase()}，已设为当前颜色`);
  if (ed.prevTool && ed.prevTool !== 'picker') selectTool(ed.prevTool); // 取色一次后回到之前的工具
}

/* ---------------- 文字输入 ---------------- */
function openTextInput(e) {
  commitTextInput();
  const p = canvasPoint(e);
  const s = settings();
  ed.textAnchor = { x: p.x, y: p.y, sizePt: s.fontSize, color: s.color };
  const r = canvas.getBoundingClientRect();
  const ratio = r.width / canvas.width;
  textInput.style.left = (canvas.offsetLeft + p.x * ratio - 4) + 'px';
  textInput.style.top = (canvas.offsetTop + p.y * ratio - 4) + 'px';
  textInput.style.fontSize = (s.fontSize * SCALE * ratio) + 'px';
  textInput.style.color = s.color;
  textInput.value = '';
  textInput.classList.remove('hidden');
  setTimeout(() => textInput.focus(), 0);
}

function commitTextInput(cancel) {
  if (textInput.classList.contains('hidden')) return;
  const anchor = ed.textAnchor;
  const val = textInput.value.trim();
  textInput.classList.add('hidden');
  ed.textAnchor = null;
  if (cancel || !anchor || !val) { redraw(); return; }
  commitOp({
    t: 'text', text: val,
    x: anchor.x, y: anchor.y + anchor.sizePt * SCALE * 0.85, // 锚点为文字左上角，基线 ≈ +0.85em
    sizePt: anchor.sizePt, color: anchor.color,
  });
}
App.editor.commitTextInput = commitTextInput;

textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); commitTextInput(); }
  else if (e.key === 'Escape') { e.preventDefault(); commitTextInput(true); }
});
textInput.addEventListener('blur', () => commitTextInput());

/* ---------------- 页面导航 ---------------- */
$('#btnEdPrev').addEventListener('click', () => gotoPage(ed.cur - 1));
$('#btnEdNext').addEventListener('click', () => gotoPage(ed.cur + 1));
$('#edPageInput').addEventListener('change', e => gotoPage(parseInt(e.target.value, 10) || 1));
App.editor.gotoPage = gotoPage;

/* ---------------- 导出 ---------------- */
function mapPoint(vp, x, y) {
  const [px, py] = vp.convertToPdfPoint(x, y);
  return { x: px, y: py };
}
function mapRect(vp, op) {
  const p1 = mapPoint(vp, op.x, op.y);
  const p2 = mapPoint(vp, op.x + op.w, op.y + op.h);
  return {
    x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y),
    width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y),
  };
}
/* 将补丁画布按页面 /Rotate 预旋转，使其嵌入后在阅读器中方向正确 */
function rotateCanvasCW(src, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (deg === 0) return src;
  const c = document.createElement('canvas');
  if (deg === 180) { c.width = src.width; c.height = src.height; }
  else { c.width = src.height; c.height = src.width; }
  const cx = c.getContext('2d');
  cx.translate(c.width / 2, c.height / 2);
  cx.rotate(deg * Math.PI / 180);
  cx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
function canvasToBlobAsync(c, type, q) {
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), type, q));
}
function extractRegion(c, op) {
  const x = Math.round(Math.max(0, op.x)), y = Math.round(Math.max(0, op.y));
  const w = Math.round(Math.min(op.w, c.width - x)), h = Math.round(Math.min(op.h, c.height - y));
  const out = document.createElement('canvas');
  out.width = Math.max(1, w); out.height = Math.max(1, h);
  out.getContext('2d').drawImage(c, x, y, w, h, 0, 0, w, h);
  return out;
}

/* 导出互斥：导出期间禁止换文件/重置销毁状态 */
let exporting = false;

$('#btnEdExport').addEventListener('click', async () => {
  if (!ed.bytes || exporting) return;
  commitTextInput();
  const pages = editedPages();
  if (!pages.length) { toast('还没有任何标注，请先选择工具在页面上编辑', true); return; }
  // 快照全部依赖状态：导出期间的编辑/撤销不影响本次输出
  const snap = { bytes: ed.bytes, doc: ed.doc, fileName: ed.file.name, pageCount: ed.pageCount, ops: {} };
  for (const pn of pages) snap.ops[pn] = ed.ops[pn].slice();
  const btn = $('#btnEdExport');
  btn.disabled = true;
  exporting = true;
  const prog = $('#editProgress');
  try {
    if ($('#edFlatten').checked) {
      await exportFlattened(pages, snap, prog);
      return;
    }
    setProgress(prog, 0.02, '正在读取原始 PDF…');
    await yieldUI();
    const src = await PDFLib.PDFDocument.load(snap.bytes);

    const hasText = pages.some(pn => snap.ops[pn].some(o => o.t === 'text'));
    let cjk = null;
    if (hasText) {
      setProgress(prog, 0.06, '正在嵌入中文字体…');
      await yieldUI();
      try {
        const usedText = pages.flatMap(pn => snap.ops[pn].filter(o => o.t === 'text').map(o => o.text)).join('');
        cjk = await embedCjkFont(src, 'regular', usedText);
      } catch (e) {
        console.warn('字体加载失败，文字标注将被跳过:', e);
        toast('中文字体加载失败，本次导出将跳过文字标注', true);
      }
    }
    const BM = PDFLib.BlendMode && PDFLib.BlendMode.Multiply;

    for (let i = 0; i < pages.length; i++) {
      const pn = pages[i];
      setProgress(prog, 0.1 + 0.8 * (i / pages.length), `正在写入第 ${pn} 页标注…`);
      await yieldUI();
      const page = src.getPage(pn - 1);
      const pjsPage = await snap.doc.getPage(pn);
      const vp = pjsPage.getViewport({ scale: SCALE });
      const rotate = ((pjsPage.rotate || 0) % 360 + 360) % 360;

      // 工作合成画布：马赛克补丁需要取「底图+此前标注」的像素
      const work = await renderBase(snap.doc, pn);

      for (const op of snap.ops[pn]) {
        if (op.t === 'mosaic') {
          applyOp(work, op);
          const patch = rotateCanvasCW(extractRegion(work, op), (360 - rotate) % 360);
          const png = await src.embedPng(await (await canvasToBlobAsync(patch, 'image/png')).arrayBuffer());
          page.drawImage(png, mapRect(vp, op));
          continue;
        }
        applyOp(work, op); // 保持合成画布与屏幕一致，供后续马赛克取样
        const color = op.color ? hexToRgb01(op.color) : null;
        switch (op.t) {
          case 'rect': {
            const r = mapRect(vp, op);
            page.drawRectangle({
              ...r, borderColor: PDFLib.rgb(color.r, color.g, color.b),
              borderWidth: op.lw, borderOpacity: 1,
            });
            break;
          }
          case 'highlight': {
            const r = mapRect(vp, op);
            page.drawRectangle({
              ...r, color: PDFLib.rgb(color.r, color.g, color.b),
              opacity: 0.4, ...(BM ? { blendMode: BM } : {}),
            });
            break;
          }
          case 'whiteout': {
            const r = mapRect(vp, op);
            page.drawRectangle({ ...r, color: PDFLib.rgb(1, 1, 1) });
            break;
          }
          case 'line': {
            page.drawLine({
              start: mapPoint(vp, op.x1, op.y1), end: mapPoint(vp, op.x2, op.y2),
              thickness: op.lw, color: PDFLib.rgb(color.r, color.g, color.b),
              lineCap: PDFLib.LineCapStyle.Round,
            });
            break;
          }
          case 'pen': {
            for (let k = 1; k < op.pts.length; k++) {
              page.drawLine({
                start: mapPoint(vp, op.pts[k - 1].x, op.pts[k - 1].y),
                end: mapPoint(vp, op.pts[k].x, op.pts[k].y),
                thickness: op.lw, color: PDFLib.rgb(color.r, color.g, color.b),
                lineCap: PDFLib.LineCapStyle.Round,
              });
            }
            break;
          }
          case 'text': {
            if (!cjk) break; // 字体加载失败时跳过文字标注（其余标注照常写入）
            const textOut = sanitizeForFont(op.text, cjk.charSet);
            if (!textOut.trim()) break;
            const pos = mapPoint(vp, op.x, op.y);
            page.drawText(textOut, {
              x: pos.x, y: pos.y, size: op.sizePt,
              font: cjk.font, color: PDFLib.rgb(color.r, color.g, color.b),
              ...(rotate ? { rotate: PDFLib.degrees(rotate) } : {}),
            });
            break;
          }
        }
      }
    }

    setProgress(prog, 0.95, '正在生成 PDF…');
    await yieldUI();
    const outBytes = await src.save();
    hideProgress(prog);
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const outName = snap.fileName.replace(/\.pdf$/i, '') + '-编辑.pdf';
    const total = pages.reduce((s, pn) => s + snap.ops[pn].length, 0);
    showResult($('#editResult'), '导出完成',
      `已将 ${pages.length} 页共 ${total} 处标注写入 PDF · 输出大小 <b>${formatSize(blob.size)}</b>`,
      blob, outName);
  } catch (err) {
    console.error(err);
    hideProgress(prog);
    toast('导出失败：' + friendlyError(err), true);
  } finally {
    exporting = false;
    btn.disabled = false;
  }
});

/* 扁平化导出：已编辑页整页转为图片（彻底移除被遮挡的原内容），未编辑页原样复制 */
async function exportFlattened(editedList, snap, prog) {
  const editedSet = new Set(editedList);
  const src = await PDFLib.PDFDocument.load(snap.bytes);
  const out = await PDFLib.PDFDocument.create();
  for (let pn = 1; pn <= snap.pageCount; pn++) {
    setProgress(prog, (pn - 1) / snap.pageCount, `正在处理第 ${pn} / ${snap.pageCount} 页…`);
    await yieldUI();
    if (!editedSet.has(pn)) {
      const [copied] = await out.copyPages(src, [pn - 1]);
      out.addPage(copied);
      continue;
    }
    // 合成底图 + 全部标注，整页作为图片写入（页面尺寸取显示方向的 pt 尺寸）
    const work = await renderBase(snap.doc, pn);
    for (const op of snap.ops[pn]) applyOp(work, op);
    const pjsPage = await snap.doc.getPage(pn);
    const vp1 = pjsPage.getViewport({ scale: 1 });
    const jpeg = await canvasToBlobAsync(work, 'image/jpeg', 0.9);
    const img = await out.embedJpg(await jpeg.arrayBuffer());
    const page = out.addPage([vp1.width, vp1.height]);
    page.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  }
  setProgress(prog, 0.96, '正在生成 PDF…');
  await yieldUI();
  const outBytes = await out.save();
  hideProgress(prog);
  const blob = new Blob([outBytes], { type: 'application/pdf' });
  const outName = snap.fileName.replace(/\.pdf$/i, '') + '-编辑.pdf';
  const total = editedList.reduce((s, pn) => s + snap.ops[pn].length, 0);
  showResult($('#editResult'), '导出完成（已扁平化）',
    `已编辑的 ${editedList.length} 页已整页转为图片（共 ${total} 处标注，被遮挡的原内容已彻底移除），其余页保持原样 · 输出大小 <b>${formatSize(blob.size)}</b>`,
    blob, outName);
}

})();
