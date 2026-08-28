/* ==========================================================================
 * 文档工具箱 — 纯前端文档处理工具
 * 功能：Word/PDF 互转 · PDF 压缩（带效果预览）· PDF 页面排序
 * 所有处理均在浏览器本地完成，文件不上传服务器。
 * ========================================================================== */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ---------------- 通用工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
// 用 MessageChannel 让出主线程：不受后台标签页定时器节流影响
const yieldUI = (() => {
  const { port1, port2 } = new MessageChannel();
  const resolvers = [];
  port1.onmessage = () => { const r = resolvers.shift(); if (r) r(); };
  return () => new Promise(res => { resolvers.push(res); port2.postMessage(null); });
})();

const App = {
  testMode: false,   // 测试模式下不触发真实下载
  _last: null,       // 最近一次生成的输出 {blob, name}
  convert: {}, compress: {}, reorder: {},
};
window.App = App;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/* 将底层库错误转为用户可理解的提示 */
function friendlyError(err) {
  const m = String((err && err.message) || err);
  if (/encrypt|password/i.test(m)) return '该 PDF 已加密或受权限保护，无法处理，请先解除密码保护';
  return m;
}

function downloadBlob(blob, name) {
  App._last = { blob, name, size: blob.size };
  if (App.testMode) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function setProgress(wrapEl, frac, text) {
  wrapEl.classList.remove('hidden');
  $('.progress-fill', wrapEl).style.width = Math.round(frac * 100) + '%';
  $('.progress-text', wrapEl).textContent = text || '';
}
function hideProgress(wrapEl) { wrapEl.classList.add('hidden'); }

function fillFileCard(cardEl, file, extraMeta) {
  const isPdf = /\.pdf$/i.test(file.name);
  cardEl.innerHTML = `
    <div class="fc-icon">${isPdf ? '📕' : '📘'}</div>
    <div>
      <div class="fc-name"></div>
      <div class="fc-meta"></div>
    </div>`;
  $('.fc-name', cardEl).textContent = file.name;
  $('.fc-meta', cardEl).textContent = formatSize(file.size) + (extraMeta ? ' · ' + extraMeta : '');
}

function showResult(el, title, detail, blob, filename) {
  el.innerHTML = `
    <div class="rc-title">✅ ${title}</div>
    <div class="rc-detail">${detail}</div>
    <button class="btn btn-primary rc-download"></button>`;
  // 文件名来自用户输入，用 textContent 写入避免 HTML 注入
  $('.rc-download', el).textContent = '下载 ' + filename;
  el.classList.remove('hidden');
  $('.rc-download', el).addEventListener('click', () => downloadBlob(blob, filename));
  downloadBlob(blob, filename);
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', quality));
}

async function fileToBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/* 中文字体：懒加载 + 缓存，供 Word→PDF 文字层与文档编辑加字使用。
 * vendor/NotoSansSC-CN.ttf 是构建期用 fontTools 预裁剪的 TrueType 版
 * （GB2312 + ASCII，约 7500 字符）。注意必须整体嵌入（subset:false）：
 * pdf-lib/fontkit 的运行时子集化会产出损坏字体（CFF 字形错乱 / TTF 丢字形，
 * 已用 macOS Quartz 渲染验证），故子集化改在构建期完成。 */
const _cjkFontPromises = {};
function loadCjkFontBytes(variant) {
  const key = variant === 'bold' ? 'bold' : 'regular';
  if (!_cjkFontPromises[key]) {
    const url = key === 'bold' ? 'vendor/NotoSansSC-CN-Bold.ttf' : 'vendor/NotoSansSC-CN.ttf';
    _cjkFontPromises[key] = fetch(url)
      .then(r => { if (!r.ok) throw new Error('字体加载失败 HTTP ' + r.status); return r.arrayBuffer(); })
      .catch(err => { _cjkFontPromises[key] = null; throw err; });
  }
  return _cjkFontPromises[key];
}
/* 子集兜底字符：数字/标点/字母，覆盖列表编号等运行期才产生的文字 */
const BASE_SUBSET_CHARS = (() => {
  let s = '';
  for (let c = 0x20; c <= 0x7E; c++) s += String.fromCharCode(c);
  return s + '。，、：；！？「」『』（）《》〈〉【】——……·〇一二三四五六七八九十百零壹贰叁肆伍陆柒捌玖拾';
})();

/* 在指定 pdf-lib 文档上嵌入中文字体（variant: 'regular' | 'bold'）。
 * 传入 usedText 时先用自研子集器（js/subset.js）裁剪到实际用字
 *（pdf-lib 自带的运行时子集化有缺陷，不能使用），输出体积可缩小两个数量级；
 * 子集化失败则回退整体嵌入。返回 {font, charSet}。 */
async function embedCjkFont(pdfDoc, variant, usedText) {
  const full = new Uint8Array(await loadCjkFontBytes(variant));
  let embedBytes = full;
  if (usedText && typeof subsetTtf === 'function') {
    try {
      const cps = new Set();
      for (const ch of BASE_SUBSET_CHARS + usedText) cps.add(ch.codePointAt(0));
      embedBytes = subsetTtf(full, cps);
    } catch (e) {
      console.warn('运行时字体子集化失败，回退整体嵌入:', e);
      embedBytes = full;
    }
  }
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(embedBytes, { subset: false });
  const charSet = new Set(font.getCharacterSet());
  return { font, charSet };
}
/* 过滤掉字体不支持的字符，避免编码报错中断导出 */
function sanitizeForFont(text, charSet) {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 9) { out += ' '; continue; }         // tab → 空格
    if (cp < 32) continue;                            // 控制字符
    out += charSet.has(cp) ? ch : ' ';
  }
  return out;
}
App.embedCjkFont = embedCjkFont;
App.sanitizeForFont = sanitizeForFont;

async function openPdfJs(bytes) {
  // pdf.js 会转移(detach)传入的 buffer，务必传副本
  return pdfjsLib.getDocument({ data: bytes.slice() }).promise;
}

async function renderPdfPageToCanvas(pdfDoc, pageNum, scale, canvas) {
  const page = await pdfDoc.getPage(pageNum);
  const vp = page.getViewport({ scale });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // intent:'print'——不依赖 requestAnimationFrame，页面处于后台时也能完成渲染
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
  return page;
}

/* ---------------- 选项卡 ---------------- */
$$('.tab').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
}));

/* 文档工具内部子模式（格式转换 / 压缩 / 排序 / 编辑） */
$$('.doc-tab').forEach(btn => btn.addEventListener('click', () => {
  $$('.doc-tab').forEach(b => b.classList.toggle('active', b === btn));
  $$('.doc-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.dmode));
}));

/* 某个文档子面板当前是否可见（顶层在「文档工具」且子面板激活） */
function docPaneActive(id) {
  return $('#tab-doc').classList.contains('active') && $('#' + id).classList.contains('active');
}

/* ---------------- 拖放区通用绑定 ---------------- */
function bindDropzone(dropId, inputId, onFile) {
  const drop = $('#' + dropId);
  const input = $('#' + inputId);
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files.length) onFile(input.files[0]);
    input.value = '';
  });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('dragover');
    if (e.dataTransfer.files.length > 1) toast('一次只处理一个文件，已选择第一个');
    if (e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
  });
}

/* “换个文件”按钮 */
$$('.btn-reset').forEach(btn => btn.addEventListener('click', () => {
  const which = btn.dataset.reset;
  if (which === 'convert') resetConvert();
  else if (which === 'compress') resetCompress();
  else if (which === 'reorder') resetReorder();
  else if (which === 'edit' && App.editor && App.editor.reset) App.editor.reset();
  else if (which === 'image' && App.image && App.image.reset) App.image.reset();
  else if (which === 'video' && App.video && App.video.reset) App.video.reset();
  else if (which === 'archive' && App.archive && App.archive.reset) App.archive.reset();
}));

/* ==========================================================================
 * 一、格式转换（docx → PDF / PDF → docx）
 * ========================================================================== */
const cv = {
  file: null, kind: null,      // 'docx' | 'pdf'
  pdfBytes: null,
};

function resetConvert() {
  cv.file = null; cv.kind = null; cv.pdfBytes = null;
  $('#docxPreview').innerHTML = '';
  $('#convertBody').classList.add('hidden');
  $('#convertDocxPane').classList.add('hidden');
  $('#convertPdfPane').classList.add('hidden');
  $('#convertResult').classList.add('hidden');
  hideProgress($('#convertProgress'));
  $('#convertDrop').classList.remove('hidden');
}

async function convertHandleFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.doc')) {
    toast('暂不支持旧版 .doc 格式，请先在 Word 中另存为 .docx', true);
    return;
  }
  if (!name.endsWith('.docx') && !name.endsWith('.pdf')) {
    toast('请选择 .docx 或 .pdf 文件', true);
    return;
  }
  resetConvert();
  cv.file = file;
  $('#convertDrop').classList.add('hidden');
  $('#convertBody').classList.remove('hidden');

  try {
    if (name.endsWith('.docx')) {
      cv.kind = 'docx';
      fillFileCard($('#convertFileCard'), file, '将转换为 PDF');
      $('#convertDocxPane').classList.remove('hidden');
      const buf = await file.arrayBuffer();
      await docx.renderAsync(buf, $('#docxPreview'), null, {
        inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
      });
    } else {
      cv.kind = 'pdf';
      cv.pdfBytes = await fileToBytes(file);
      const doc = await openPdfJs(cv.pdfBytes);
      fillFileCard($('#convertFileCard'), file, `${doc.numPages} 页 · 将转换为 Word`);
      doc.destroy();
      $('#convertPdfPane').classList.remove('hidden');
    }
  } catch (err) {
    console.error(err);
    toast('文件读取失败：' + friendlyError(err), true);
    resetConvert();
  }
}
App.convert.handleFile = convertHandleFile;
bindDropzone('convertDrop', 'convertInput', convertHandleFile);

/* ---- docx → PDF：矢量文字 + 图形底图（对齐桌面办公软件的导出质量）----
 * 文字：从渲染 DOM 逐字符测量位置，按预测宽度分段锚定，用内嵌字体以真矢量写入
 *（任意缩放清晰、可选中复制、体积小）；粗体使用独立粗体字重。
 * 图形：为页面加 .pdf-notext 隐藏文字后用 html2canvas 截取底图，
 * 表格线 / 底纹 / 图片由浏览器渲染引擎按原版式输出。 */

const _fontMetricsCache = new Map();
const _measureCtx = document.createElement('canvas').getContext('2d');

/* 该元素所用字体在指定字号下的 ascent（px），用于把字符盒顶换算为基线 */
function ascentOf(cs, rectH) {
  const key = `${cs.fontStyle}|${cs.fontWeight}|${cs.fontSize}|${cs.fontFamily}`;
  let a = _fontMetricsCache.get(key);
  if (a === undefined) {
    a = null;
    try {
      _measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const t = _measureCtx.measureText('国Agy');
      if (t.fontBoundingBoxAscent > 0) a = t.fontBoundingBoxAscent;
    } catch (_) { /* 忽略 */ }
    _fontMetricsCache.set(key, a);
  }
  return a !== null ? a : rectH * 0.8;
}

function parseCssColor(str) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(str);
  if (!m) return { r: 0, g: 0, b: 0, a: 1 };
  return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] === undefined ? 1 : +m[4] };
}

/* 字符步进宽度（pt），按字体缓存（advance/1000 与字号线性） */
const _advCache = new Map();
function charAdvance(font, ch, sizePt) {
  let m = _advCache.get(font);
  if (!m) { m = new Map(); _advCache.set(font, m); }
  let w = m.get(ch);
  if (w === undefined) {
    try { w = font.widthOfTextAtSize(ch, 100) / 100; } catch (_) { w = 0.5; }
    m.set(ch, w);
  }
  return w * sizePt;
}

/* 把依赖 CSS counter 的 ::before 编号具象化为真实文本节点：
 * html2canvas 不支持 counter()，若不处理列表编号会在导出中丢失；
 * 具象化后编号同时进入矢量文字层，返回清理函数。 */
function materializeCounters(sectionEl, counters) {
  const inserted = [];
  const val = n => counters.get(n) || 0;
  const applyDecl = (decl, isReset) => {
    if (!decl || decl === 'none') return;
    const re = /([A-Za-z_][\w-]*)\s*(-?\d+)?/g;
    let m;
    while ((m = re.exec(decl))) {
      if (m[1] === 'none') continue;
      if (isReset) counters.set(m[1], m[2] ? +m[2] : 0);
      else counters.set(m[1], val(m[1]) + (m[2] ? +m[2] : 1));
    }
  };
  const cssUnescape = str => str
    .replace(/\\([0-9a-fA-F]{1,6}) ?/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\(.)/g, '$1')
    .replace(/[\t\n]/g, ' ');
  // 编号格式化：覆盖 docx-preview 实际输出的样式（中文非正式/正式、罗马、字母、前导零）
  const cjkNum = (n, d, ten) => {
    if (n < 0 || n > 99) return String(n);
    if (n < 10) return d[n];
    const t = (n / 10) | 0, u = n % 10;
    return (t > 1 ? d[t] : '') + ten + (u ? d[u] : '');
  };
  const roman = n => {
    if (n <= 0 || n >= 4000) return String(n);
    const M = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
               [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    for (const [v, r] of M) while (n >= v) { out += r; n -= v; }
    return out;
  };
  const alpha = n => {
    let out = '';
    for (n = Math.max(1, n); n > 0; n = ((n - 1) / 26) | 0) out = String.fromCharCode(97 + (n - 1) % 26) + out;
    return out;
  };
  const fmt = (n, style) => {
    if (/upper-roman/.test(style)) return roman(n);
    if (/lower-roman/.test(style)) return roman(n).toLowerCase();
    if (/lower-alpha|lower-latin/.test(style)) return alpha(n);
    if (/upper-alpha|upper-latin/.test(style)) return alpha(n).toUpperCase();
    if (/decimal-leading-zero/.test(style)) return (n >= 0 && n < 10 ? '0' : '') + n;
    if (/-formal/.test(style)) return cjkNum(n, '零壹贰叁肆伍陆柒捌玖', '拾');
    if (/chinese|japanese|cjk|ideographic/.test(style)) return cjkNum(n, '〇一二三四五六七八九', '十');
    return String(n);
  };
  for (const el of sectionEl.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    applyDecl(cs.counterReset, true);
    applyDecl(cs.counterSet, true);
    applyDecl(cs.counterIncrement, false);
    const before = getComputedStyle(el, '::before');
    const content = before.content;
    if (!content || content === 'none' || content === 'normal') continue;
    // 伪元素自身的计数器声明先于 content 求值
    if (before.counterReset !== cs.counterReset) applyDecl(before.counterReset, true);
    if (before.counterSet !== cs.counterSet) applyDecl(before.counterSet, true);
    if (before.counterIncrement !== cs.counterIncrement) applyDecl(before.counterIncrement, false);
    if (!content.includes('counter(')) continue;
    let text = '';
    const tokRe = /"((?:[^"\\]|\\.)*)"|counter\(\s*([\w-]+)\s*(?:,\s*([\w-]+)\s*)?\)/g;
    let t;
    while ((t = tokRe.exec(content))) {
      if (t[1] !== undefined) text += cssUnescape(t[1]);
      else text += fmt(val(t[2]), t[3] || 'decimal');
    }
    if (!text.trim()) continue;
    const span = document.createElement('span');
    span.textContent = text;
    span.style.cssText = `font:${before.font};color:${before.color};`;
    el.classList.add('pdf-num-off');
    el.insertBefore(span, el.firstChild);
    inserted.push({ span, el });
  }
  return () => inserted.forEach(({ span, el }) => { span.remove(); el.classList.remove('pdf-num-off'); });
}

/* 提取一页中所有可矢量化的文字串；不支持字符的节点回退为栅格显示 */
function collectVectorRuns(sectionEl, fonts) {
  const secRect = sectionEl.getBoundingClientRect();
  const runs = [];
  const keepEls = new Map(); // el -> 原内联 color（用于导出后恢复）
  const walker = document.createTreeWalker(sectionEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p || p.closest('style,script')) return NodeFilter.FILTER_REJECT;
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const range = document.createRange();
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue;
    const el = node.parentElement;
    const cs = getComputedStyle(el);
    const sizePx = parseFloat(cs.fontSize) || 12;
    if (sizePx <= 0.5) continue;
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
    const font = bold && fonts.bold ? fonts.bold.font : fonts.regular.font;
    const charSet = bold && fonts.bold ? fonts.bold.charSet : fonts.regular.charSet;
    // text-transform（w:caps 等）：绘制字符与 DOM 原文可能不同，逐字符映射保持 Range 偏移对齐
    const tt = cs.textTransform || 'none';
    let drawChars = null;
    if (/upper|lower|capital/.test(tt)) {
      drawChars = [];
      let prevAlpha = false;
      for (let i = 0; i < text.length;) {
        const ch = String.fromCodePoint(text.codePointAt(i));
        let d = ch;
        if (tt.includes('uppercase')) d = ch.toUpperCase();
        else if (tt.includes('lowercase')) d = ch.toLowerCase();
        else if (tt.includes('capitalize')) d = prevAlpha ? ch : ch.toUpperCase();
        prevAlpha = /\p{L}/u.test(ch);
        drawChars.push(d);
        i += ch.length;
      }
    }
    // 含字体不支持字符（按实际绘制字符判定）的节点：整体保留在底图中栅格显示，避免缺字
    let unsupported = false;
    for (const ch of (drawChars ? drawChars.join('') : text)) {
      const cp = ch.codePointAt(0);
      if (cp > 32 && cp !== 0xA0 && !charSet.has(cp)) { unsupported = true; break; }
    }
    if (unsupported) {
      if (!keepEls.has(el)) {
        keepEls.set(el, { value: el.style.getPropertyValue('color'), priority: el.style.getPropertyPriority('color') });
        el.style.setProperty('color', cs.color, 'important');
      }
      continue;
    }
    const deco = cs.textDecorationLine || '';
    const italic = /italic|oblique/.test(cs.fontStyle);
    const style = {
      italic,
      sizePt: sizePx * 0.75,
      color: parseCssColor(cs.color),
      font,
      fakeBold: bold && !fonts.bold,
      underline: deco.includes('underline'),
      strike: deco.includes('line-through'),
    };
    let run = null;
    let ci = 0; // 码点序号，对齐 drawChars
    const flush = () => { if (run && run.text.trim()) runs.push(run); run = null; };
    for (let i = 0; i < text.length; ci++) {
      const ch = String.fromCodePoint(text.codePointAt(i));
      const len = ch.length;
      i += len;
      if (ch !== '\u00A0' && !ch.trim()) {
        if (run) { run.text += ' '; run.predPx += charAdvance(font, ' ', style.sizePt) / 0.75; }
        continue;
      }
      range.setStart(node, i - len);
      range.setEnd(node, i);
      const r = range.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) continue;
      const x = r.left - secRect.left;
      const baseY = r.top - secRect.top + ascentOf(cs, r.height);
      if (run) {
        // 测量位置与字体预测宽度出现偏差（对齐/字距拉伸等）时重新锚定，保证视觉不漂移
        const drift = Math.abs((x - run.x) - run.predPx);
        if (drift > 0.9 || Math.abs(baseY - run.baseY) > 1.5 || run.text.length > 40) flush();
      }
      if (!run) run = { ...style, text: '', x, baseY, predPx: 0, right: x };
      const out = ch === '\u00A0' ? ' ' : (drawChars ? drawChars[ci] : ch);
      run.text += out;
      for (const oc of out) run.predPx += charAdvance(font, oc, style.sizePt) / 0.75;
      run.right = r.right - secRect.left;
    }
    flush();
  }
  return { runs, keepEls };
}

function canvasToBlobAs(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), type, quality));
}

$('#btnDocxToPdf').addEventListener('click', async () => {
  const sections = $$('#docxPreview section.docx');
  if (!sections.length) { toast('未找到可导出的页面', true); return; }
  const btn = $('#btnDocxToPdf');
  btn.disabled = true;
  const prog = $('#convertProgress');
  try {
    const pdfDoc = await PDFLib.PDFDocument.create();

    // 加载字体：常规体必备；文档存在粗体文字时再加载粗体字重
    let fonts = null;
    try {
      setProgress(prog, 0, '正在加载嵌入字体…');
      await yieldUI();
      const usedText = sections.map(sec => sec.textContent).join('');
      fonts = { regular: await embedCjkFont(pdfDoc, 'regular', usedText), bold: null };
      const hasBold = sections.some(sec =>
        [...sec.querySelectorAll('b,strong,span,td,p,h1,h2,h3,div')].some(el =>
          el.childNodes.length && (parseInt(getComputedStyle(el).fontWeight, 10) || 400) >= 600 &&
          [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())));
      if (hasBold) {
        try { fonts.bold = await embedCjkFont(pdfDoc, 'bold', usedText); }
        catch (e) { console.warn('粗体字体加载失败，粗体将以描边模拟:', e); }
      }
    } catch (e) {
      console.warn('字体加载失败，回退为整页图像导出:', e);
      toast('嵌入字体加载失败，本次将以图像方式导出（文字不可选中）', true);
    }

    // 计数器状态跨页共享，并从 .docx-wrapper 的 counter-reset 播种（承载 w:start 初值）
    const counters = new Map();
    try {
      const wrapper = sections[0].closest('.docx-wrapper') || sections[0].parentElement;
      const decl = wrapper ? getComputedStyle(wrapper).counterReset : '';
      if (decl && decl !== 'none') {
        const re = /([A-Za-z_][\w-]*)\s*(-?\d+)?/g;
        let m;
        while ((m = re.exec(decl))) if (m[1] !== 'none') counters.set(m[1], m[2] ? +m[2] : 0);
      }
    } catch (_) { /* 播种失败时从 0 起计 */ }

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      setProgress(prog, i / sections.length, `正在生成第 ${i + 1} / ${sections.length} 页…`);
      await yieldUI();

      // 1) 列表编号具象化 → 提取矢量文字（不支持的字符节点标记为保留栅格）
      const unmaterialize = materializeCounters(sec, counters);
      let runs = [], keepEls = new Map();
      if (fonts) ({ runs, keepEls } = collectVectorRuns(sec, fonts));

      // 2) 隐藏文字截取图形底图（表格线/底纹/图片保持浏览器渲染的原版式）
      if (fonts) sec.classList.add('pdf-notext');
      let canvas;
      try {
        canvas = await html2canvas(sec, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      } finally {
        sec.classList.remove('pdf-notext');
        for (const [el, prev] of keepEls) {
          if (prev.value) el.style.setProperty('color', prev.value, prev.priority);
          else el.style.removeProperty('color');
        }
        unmaterialize();
      }

      // 3) 底图编码：优先 PNG（白底页面极小且无损），过大时用 JPEG
      let img;
      const png = await canvasToBlobAs(canvas, 'image/png');
      if (png.size > 400 * 1024) {
        const jpeg = await canvasToBlobAs(canvas, 'image/jpeg', 0.88);
        img = jpeg.size < png.size
          ? await pdfDoc.embedJpg(await jpeg.arrayBuffer())
          : await pdfDoc.embedPng(await png.arrayBuffer());
      } else {
        img = await pdfDoc.embedPng(await png.arrayBuffer());
      }

      const wPt = sec.offsetWidth * 0.75;
      const hPt = sec.offsetHeight * 0.75;
      const page = pdfDoc.addPage([wPt, hPt]);
      page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });

      // 4) 写入矢量文字
      for (const run of runs) {
        const opts = {
          x: run.x * 0.75,
          y: hPt - run.baseY * 0.75,
          size: run.sizePt,
          font: run.font,
          color: PDFLib.rgb(run.color.r, run.color.g, run.color.b),
        };
        if (run.color.a < 1) opts.opacity = run.color.a;
        try {
          if (run.italic && PDFLib.concatTransformationMatrix) {
            // 斜体：绕基线锚点做 12° 剪切
            page.pushOperators(
              PDFLib.pushGraphicsState(),
              PDFLib.concatTransformationMatrix(1, 0, 0, 1, opts.x, opts.y),
              PDFLib.concatTransformationMatrix(1, 0, 0.21, 1, 0, 0),
              PDFLib.concatTransformationMatrix(1, 0, 0, 1, -opts.x, -opts.y)
            );
            page.drawText(run.text, opts);
            if (run.fakeBold) page.drawText(run.text, { ...opts, x: opts.x + run.sizePt * 0.03 });
            page.pushOperators(PDFLib.popGraphicsState());
          } else {
            page.drawText(run.text, opts);
            if (run.fakeBold) page.drawText(run.text, { ...opts, x: opts.x + run.sizePt * 0.03 });
          }
          if (run.underline || run.strike) {
            const lineW = Math.max(run.right - run.x, run.predPx) * 0.75;
            const th = Math.max(0.6, run.sizePt / 16);
            if (run.underline) page.drawLine({
              start: { x: opts.x, y: opts.y - run.sizePt * 0.12 },
              end: { x: opts.x + lineW, y: opts.y - run.sizePt * 0.12 },
              thickness: th, color: opts.color,
            });
            if (run.strike) page.drawLine({
              start: { x: opts.x, y: opts.y + run.sizePt * 0.27 },
              end: { x: opts.x + lineW, y: opts.y + run.sizePt * 0.27 },
              thickness: th, color: opts.color,
            });
          }
        } catch (e) { /* 单串写入失败仅跳过 */ }
      }
    }

    setProgress(prog, 1, '正在生成 PDF…');
    const bytes = await pdfDoc.save();
    hideProgress(prog);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const outName = cv.file.name.replace(/\.docx$/i, '') + '.pdf';
    showResult($('#convertResult'), '转换完成',
      `共 ${sections.length} 页${fonts ? ' · 矢量文字（任意缩放清晰、可选中复制）' : ''} · 输出大小 <b>${formatSize(blob.size)}</b>`,
      blob, outName);
  } catch (err) {
    console.error(err);
    hideProgress(prog);
    toast('转换失败：' + friendlyError(err), true);
  } finally {
    btn.disabled = false;
  }
});

/* ---- PDF → docx：提取文字流 ---- */
const CJK_RE = /[⺀-鿿豈-﫿＀-￯　-〿]/;

function joinNeedsSpace(prev, next) {
  if (!prev || !next) return false;
  const a = prev[prev.length - 1], b = next[0];
  if (CJK_RE.test(a) || CJK_RE.test(b)) return false;
  if (/\s/.test(a) || /\s/.test(b)) return false;
  return true;
}

/* ---- PDF → Word 富格式提取：字号 / 粗斜体 / 对齐 / 内嵌图片 ---- */

/* 从已加载的字体对象推断粗体/斜体（需先 getOperatorList 促使字体就绪） */
function fontFlagsOf(page, fontName, cache) {
  let f = cache.get(fontName);
  if (!f) {
    let name = '';
    try { const obj = page.commonObjs.get(fontName); name = (obj && obj.name) || ''; } catch (_) { /* 未就绪 */ }
    f = { bold: /bold|black|heavy|semibold/i.test(name), italic: /italic|oblique/i.test(name) };
    cache.set(fontName, f);
  }
  return f;
}

/* 提取页面图片及其位置（CTM 追踪，坐标按 /Rotate 归一化）；全页背景图与过小图剔除 */
async function extractPageImages(page, pageTextChars, opList, rot) {
  const O = pdfjsLib.OPS;
  const vp1 = page.getViewport({ scale: 1 });
  const pageArea = vp1.width * vp1.height;
  const images = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const marks = []; // Form XObject 的栈深标记：内部未配对的 q 不得泄漏到外部
  const mul = (m, a) => [
    m[0] * a[0] + m[2] * a[1], m[1] * a[0] + m[3] * a[1],
    m[0] * a[2] + m[2] * a[3], m[1] * a[2] + m[3] * a[3],
    m[0] * a[4] + m[2] * a[5] + m[4], m[1] * a[4] + m[3] * a[5] + m[5],
  ];
  const pushImage = (img, isMask) => {
    if (!img) return;
    const wPt = Math.hypot(ctm[0], ctm[1]);
    const hPt = Math.hypot(ctm[2], ctm[3]);
    if (wPt < 12 || hPt < 12) return;
    if (wPt * hPt > pageArea * 0.8 && pageTextChars > 100) return; // 全页背景图
    // 锚点按 /Rotate 归一化（与文字用同一套坐标），y 取归一化后的上边缘
    const y = rot === 90 ? -ctm[4] : rot === 180 ? -ctm[5] : rot === 270 ? ctm[4] + wPt : ctm[5] + hPt;
    const swap = rot === 90 || rot === 270;
    images.push({ img, isMask, wPt: swap ? hPt : wPt, hPt: swap ? wPt : hPt, y });
  };
  for (let i = 0; i < opList.fnArray.length && images.length < 20; i++) {
    const fn = opList.fnArray[i], args = opList.argsArray[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() || ctm;
    else if (fn === O.transform) ctm = mul(ctm, args);
    else if (fn === O.paintFormXObjectBegin) {
      // 显示层语义：save + transform(matrix)
      marks.push(stack.length);
      stack.push(ctm);
      const m = args && args[0];
      if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m);
    } else if (fn === O.paintFormXObjectEnd) {
      const d = marks.pop();
      if (d !== undefined) { stack.length = d + 1; ctm = stack.pop(); }
    } else if (fn === O.beginAnnotation) {
      // 注释外观从页面基态重建：args = [id, rect, transform, matrix, ...]
      stack.length = 0; marks.length = 0;
      ctm = [1, 0, 0, 1, 0, 0];
      if (args && Array.isArray(args[2]) && args[2].length === 6) ctm = mul(ctm, args[2]);
      if (args && Array.isArray(args[3]) && args[3].length === 6) ctm = mul(ctm, args[3]);
    } else if (fn === O.endAnnotation) {
      stack.length = 0; marks.length = 0;
      ctm = [1, 0, 0, 1, 0, 0];
    } else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject) {
      try {
        // 多页复用的图片会进全局缓存（g_ 前缀），存放于 commonObjs 而非 page.objs
        const a = args[0];
        const img = fn === O.paintInlineImageXObject ? a
          : (typeof a === 'string' && a.startsWith('g_') ? page.commonObjs.get(a) : page.objs.get(a));
        pushImage(img, false);
      } catch (_) { /* 图像对象未就绪则跳过 */ }
    } else if (fn === O.paintImageMaskXObject) {
      try {
        const a = args[0];
        const img = a && typeof a.data === 'string' ? page.objs.get(a.data) : a;
        pushImage(img, true);
      } catch (_) { /* 忽略 */ }
    }
  }
  return images;
}

/* pdf.js 图像对象 → PNG 字节；isMask 为 1bpp 图像蒙版（置位=黑，inverseDecode 取反）；
 * rot 为页面 /Rotate 角度，按其顺时针旋转位图，使图片与阅读器中所见方向一致 */
async function pdfImgToPng(img, isMask, rot) {
  const canvas = document.createElement('canvas');
  const ctx2 = canvas.getContext('2d');
  if (img.bitmap) {
    canvas.width = img.bitmap.width;
    canvas.height = img.bitmap.height;
    if (isMask) { ctx2.fillStyle = '#fff'; ctx2.fillRect(0, 0, canvas.width, canvas.height); }
    ctx2.drawImage(img.bitmap, 0, 0);
  } else if (isMask && img.data && img.width && img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
    const out = ctx2.createImageData(img.width, img.height);
    const d = out.data, src = img.data;
    const rowBytes = Math.ceil(img.width / 8);
    const inv = !!img.inverseDecode;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        let bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (inv) bit ^= 1;
        const i = (y * img.width + x) * 4;
        const v = bit ? 0 : 255; // 置位 = 画黑
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
    ctx2.putImageData(out, 0, 0);
  } else if (img.data && img.width && img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
    const out = ctx2.createImageData(img.width, img.height);
    const src = img.data, d = out.data;
    if (img.kind === 3) d.set(src.subarray(0, d.length));
    else if (img.kind === 2) {
      for (let i = 0, j = 0; i + 3 < d.length && j + 2 < src.length; i += 4, j += 3) {
        d[i] = src[j]; d[i + 1] = src[j + 1]; d[i + 2] = src[j + 2]; d[i + 3] = 255;
      }
    } else if (img.kind === 1) {
      const rowBytes = Math.ceil(img.width / 8);
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const i = (y * img.width + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = bit ? 255 : 0;
          d[i + 3] = 255;
        }
      }
    } else return null;
    ctx2.putImageData(out, 0, 0);
  } else return null;
  const out = rot ? rotateCanvas(canvas, rot) : canvas;
  const blob = await canvasToBlobAs(out, 'image/png');
  return new Uint8Array(await blob.arrayBuffer());
}

/* 顺时针旋转画布 90 / 180 / 270 度 */
function rotateCanvas(src, deg) {
  const swap = deg === 90 || deg === 270;
  const dst = document.createElement('canvas');
  dst.width = swap ? src.height : src.width;
  dst.height = swap ? src.width : src.height;
  const c = dst.getContext('2d');
  c.translate(dst.width / 2, dst.height / 2);
  c.rotate(deg * Math.PI / 180);
  c.drawImage(src, -src.width / 2, -src.height / 2);
  return dst;
}

/* 页面 → 结构化块（段落含富格式 runs + 图片），坐标已按 /Rotate 归一化 */
async function extractPageBlocks(page) {
  // 必须先执行 getOperatorList：它促使字体对象加载（粗斜体识别依赖字体名），
  // 同时其结果供后续图片提取复用
  let opList = null;
  try { opList = await page.getOperatorList(); } catch (e) { console.warn('operator list 获取失败:', e); }
  const tc = await page.getTextContent();
  const rot = ((page.rotate % 360) + 360) % 360;
  const flagCache = new Map();

  // 1) 分行（保留每段文字的字体与字号）
  const lines = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.trim()) continue;
    const ux = it.transform[4], uy = it.transform[5];
    const [x, y] = rot === 90 ? [uy, -ux] : rot === 180 ? [-ux, -uy] : rot === 270 ? [-uy, ux] : [ux, uy];
    const h = it.height || Math.abs(it.transform[3]) || Math.abs(it.transform[1]) || 10;
    let line = null;
    for (const L of lines) {
      if (Math.abs(L.y - y) < Math.max(L.h, h) * 0.55) { line = L; break; }
    }
    if (!line) { line = { y, h, items: [] }; lines.push(line); }
    line.h = Math.max(line.h, h);
    line.items.push({ x, str: it.str, w: it.width || 0, h, fontName: it.fontName });
  }

  // 2) 行内按 x 排序，合并为带样式的 runs
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    L.runs = [];
    L.left = L.items.length ? L.items[0].x : 0;
    L.right = L.items.length ? L.items[L.items.length - 1].x + L.items[L.items.length - 1].w : 0;
    let prevEnd = null;
    for (const seg of L.items) {
      const text = seg.str.replace(/\s+/g, ' ');
      if (!text.trim()) { prevEnd = seg.x + seg.w; continue; }
      const gap = prevEnd === null ? 0 : seg.x - prevEnd;
      const needSpace = prevEnd !== null && gap > seg.h * 0.25 &&
        L.runs.length && joinNeedsSpace(L.runs[L.runs.length - 1].text, text);
      const flags = fontFlagsOf(page, seg.fontName, flagCache);
      const key = `${Math.round(seg.h * 2)}|${flags.bold}|${flags.italic}`;
      const last = L.runs[L.runs.length - 1];
      if (last && last.key === key) last.text += (needSpace ? ' ' : '') + text;
      else {
        if (last && needSpace) last.text += ' ';
        L.runs.push({ key, text, size: seg.h, bold: flags.bold, italic: flags.italic });
      }
      prevEnd = seg.x + seg.w;
    }
  }

  // 3) 行 → 段落（按行距分段）
  const sorted = lines.filter(L => L.runs.length).sort((a, b) => b.y - a.y);
  const paras = [];
  if (sorted.length) {
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i - 1].y - sorted[i].y);
    gaps.sort((a, b) => a - b);
    // 用下四分位数代表典型行距（行数少时中位数会被段间大间隙带偏），并以行高兜底；
    // 页面行数少时下四分位数本身可能就是段间距，再按最大行高封顶，避免阈值被抬高
    const hMaxPage = sorted.reduce((m, L) => Math.max(m, L.h), 0);
    const baseGap = gaps.length ? Math.min(gaps[Math.floor(gaps.length * 0.25)], hMaxPage * 1.35) : 0;
    let cur = null;
    const flushPara = () => { if (cur) paras.push(cur); cur = null; };
    for (let i = 0; i < sorted.length; i++) {
      const L = sorted[i];
      const prevL = i ? sorted[i - 1] : null;
      const gap = cur ? prevL.y - L.y : 0;
      const hPair = prevL ? Math.max(prevL.h, L.h) : L.h;
      // 字号突变（标题 → 正文）本身就是段落边界，仅看行距会把标题并进正文
      const sizeShift = !!prevL && Math.abs(prevL.h - L.h) > hPair * 0.2;
      const newPara = !cur || sizeShift || gap > Math.max(hPair * 1.9, baseGap * 1.45 + 1);
      if (newPara) {
        flushPara();
        cur = { kind: 'p', y: L.y, runs: L.runs.map(r => ({ ...r })), left: L.left, right: L.right };
      } else {
        const last = cur.runs[cur.runs.length - 1];
        const first = L.runs[0];
        const glue = joinNeedsSpace(last.text, first.text) ? ' ' : '';
        if (last.key === first.key) {
          last.text += glue + first.text;
          cur.runs.push(...L.runs.slice(1).map(r => ({ ...r })));
        } else {
          if (glue) last.text += ' ';
          cur.runs.push(...L.runs.map(r => ({ ...r })));
        }
        cur.left = Math.min(cur.left, L.left);
        cur.right = Math.max(cur.right, L.right);
      }
    }
    flushPara();
  }

  // 4) 对齐推断（相对页面版心：以文字包络为基准会让最宽的一段恒为 rg=0，
  //    导致居中标题被误判成右对齐）
  if (paras.length) {
    const [vx0, vy0, vx1, vy1] = page.view;
    // 版心的 x 轴需与第 1 步的旋转归一化保持一致
    const [px0, px1] = rot === 90 ? [vy0, vy1] : rot === 180 ? [-vx1, -vx0]
                     : rot === 270 ? [-vy1, -vy0] : [vx0, vx1];
    const margin = Math.max(0, Math.min(...paras.map(p => p.left)) - px0);
    const areaL = px0 + margin, areaR = px1 - margin;
    for (const p of paras) {
      const lg = p.left - areaL, rg = areaR - p.right;
      if (lg > 24 && rg > 24 && Math.abs(lg - rg) < Math.max(10, (lg + rg) * 0.12)) p.align = 'center';
      else if (rg < 6 && lg > 48) p.align = 'right';
    }
  }

  // 5) 图片提取并按 y 归并
  const textChars = paras.reduce((n, p) => n + p.runs.reduce((m, r) => m + r.text.length, 0), 0);
  let blocks = paras;
  try {
    const imgs = opList ? await extractPageImages(page, textChars, opList, rot) : [];
    const imgBlocks = [];
    for (const im2 of imgs) {
      const png = await pdfImgToPng(im2.img, im2.isMask, rot);
      if (png) imgBlocks.push({ kind: 'img', y: im2.y, png, wPt: im2.wPt, hPt: im2.hPt });
    }
    blocks = [...paras, ...imgBlocks].sort((a, b) => b.y - a.y);
  } catch (e) { console.warn('图片提取失败，仅输出文字:', e); }
  return blocks;
}

function xmlEscape(s) {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* 版心尺寸，须与 buildDocxBlob 末尾 w:sectPr 的页面/页边距设置一致（twips → pt） */
const DOCX_MAX_W_PT = (11906 - 2880) / 20;   // 451.3 pt
const DOCX_MAX_H_PT = (16838 - 2880) / 20;   // 697.9 pt

/* 结构化块 → .docx（富格式 runs + 内嵌图片） */
async function buildDocxBlob(pagesBlocks) {
  const mediaFiles = [];
  let body = '';
  pagesBlocks.forEach((blocks, pi) => {
    if (pi > 0) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    if (!blocks.length) { body += '<w:p/>'; return; }
    for (const b of blocks) {
      if (b.kind === 'img') {
        const idx = mediaFiles.length + 1;
        mediaFiles.push(b.png);
        // 缩放到版心之内（与下方 w:sectPr 的 A4 纵向 + 1 英寸页边距保持一致），
        // 否则整页扫描图会超出右/下边界被裁掉；只缩不放
        const k = Math.min(1, DOCX_MAX_W_PT / b.wPt, DOCX_MAX_H_PT / b.hPt);
        const cx = Math.round(b.wPt * k * 12700), cy = Math.round(b.hPt * k * 12700);
        body += `<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:drawing>` +
          `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
          `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${idx}" name="image${idx}"/>` +
          `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
          `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
          `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
          `<pic:nvPicPr><pic:cNvPr id="${idx}" name="image${idx}"/><pic:cNvPicPr/></pic:nvPicPr>` +
          `<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImg${idx}"/>` +
          `<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
          `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
          `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
          `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
        continue;
      }
      const jc = b.align ? `<w:jc w:val="${b.align}"/>` : '';
      let runsXml = '';
      for (const r of b.runs) {
        const sz = Math.max(8, Math.min(144, Math.round(r.size * 2)));
        const rpr = `<w:rPr>${r.bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}` +
          `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
        runsXml += `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(r.text)}</w:t></w:r>`;
      }
      body += `<w:p><w:pPr><w:spacing w:after="160"/>${jc}</w:pPr>${runsXml}</w:p>`;
    }
  });

  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const documentXml =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body></w:document>`;
  const stylesXml =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="DengXian" w:cs="Calibri"/>
<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`;
  const contentTypes =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
  const rels =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  let docRels =
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>`;
  mediaFiles.forEach((_, i) => {
    docRels += `\n<Relationship Id="rIdImg${i + 1}" Type="${R}/image" Target="media/image${i + 1}.png"/>`;
  });
  docRels += '\n</Relationships>';

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/_rels/document.xml.rels', docRels);
  mediaFiles.forEach((png, i) => zip.file(`word/media/image${i + 1}.png`, png));
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  });
}

$('#btnPdfToDocx').addEventListener('click', async () => {
  if (!cv.pdfBytes) return;
  const btn = $('#btnPdfToDocx');
  btn.disabled = true;
  const prog = $('#convertProgress');
  let doc = null;
  try {
    doc = await openPdfJs(cv.pdfBytes);
    const pagesBlocks = [];
    let totalChars = 0, totalImgs = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      setProgress(prog, (i - 1) / doc.numPages, `正在解析第 ${i} / ${doc.numPages} 页…`);
      await yieldUI();
      const blocks = await extractPageBlocks(await doc.getPage(i));
      for (const b of blocks) {
        if (b.kind === 'img') totalImgs++;
        else totalChars += b.runs.reduce((n, r) => n + r.text.length, 0);
      }
      pagesBlocks.push(blocks);
    }
    if (totalChars === 0 && totalImgs === 0) {
      hideProgress(prog);
      toast('未能从该 PDF 中提取到内容（可能是加密或空文档）', true);
      return;
    }
    setProgress(prog, 1, '正在生成 Word 文档…');
    const blob = await buildDocxBlob(pagesBlocks);
    hideProgress(prog);
    const outName = cv.file.name.replace(/\.pdf$/i, '') + '.docx';
    showResult($('#convertResult'), '转换完成',
      `共 ${doc.numPages} 页 · 提取约 ${totalChars} 字${totalImgs ? `、${totalImgs} 张图片` : ''}` +
      `（含字号 / 粗斜体 / 对齐还原） · 输出大小 <b>${formatSize(blob.size)}</b>`,
      blob, outName);
  } catch (err) {
    console.error(err);
    hideProgress(prog);
    toast('转换失败：' + friendlyError(err), true);
  } finally {
    doc && doc.destroy();
    btn.disabled = false;
  }
});

/* ==========================================================================
 * 二、文档压缩（预设 + 自定义 + 效果/大小预览）
 * ========================================================================== */
const PRESETS = {
  high:     { dpi: 150, quality: 0.85 },
  balanced: { dpi: 120, quality: 0.70 },
  extreme:  { dpi: 90,  quality: 0.50 },
  lossless: { lossless: true },
};

const cp = { file: null, bytes: null, doc: null, pageCount: 0 };
App.compress.state = cp;

function resetCompress() {
  if (cp.doc) { cp.doc.destroy(); cp.doc = null; }
  cp.file = null; cp.bytes = null; cp.pageCount = 0;
  $('#compressBody').classList.add('hidden');
  $('#previewArea').classList.add('hidden');
  $('#compressResult').classList.add('hidden');
  hideProgress($('#compressProgress'));
  $('#compressDrop').classList.remove('hidden');
}

function compressSettings() {
  if ($('#customToggle').checked) {
    return { dpi: +$('#dpiSlider').value, quality: +$('#qualitySlider').value / 100 };
  }
  return PRESETS[$('input[name=preset]:checked').value];
}

async function compressHandleFile(file) {
  if (!/\.pdf$/i.test(file.name)) { toast('请选择 PDF 文件', true); return; }
  resetCompress();
  try {
    cp.bytes = await fileToBytes(file);
    cp.doc = await openPdfJs(cp.bytes);
    cp.file = file;
    cp.pageCount = cp.doc.numPages;
    fillFileCard($('#compressFileCard'), file, `${cp.pageCount} 页`);
    $('#compressDrop').classList.add('hidden');
    $('#compressBody').classList.remove('hidden');
  } catch (err) {
    console.error(err);
    toast('PDF 读取失败：' + friendlyError(err), true);
    resetCompress();
  }
}
App.compress.handleFile = compressHandleFile;
bindDropzone('compressDrop', 'compressInput', compressHandleFile);

/* 自定义参数开关与联动 */
$('#customToggle').addEventListener('change', e => {
  $('#customSliders').classList.toggle('hidden', !e.target.checked);
});
$('#dpiSlider').addEventListener('input', e => { $('#dpiVal').textContent = e.target.value; });
$('#qualitySlider').addEventListener('input', e => { $('#qualityVal').textContent = e.target.value; });
$$('input[name=preset]').forEach(r => r.addEventListener('change', () => {
  $('#customToggle').checked = false;
  $('#customSliders').classList.add('hidden');
}));

/* 渲染某页为 JPEG，返回 {blob, wPt, hPt} */
async function renderPageJpeg(doc, pageNum, dpi, quality) {
  const page = await doc.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = dpi / 72;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
  const blob = await canvasToJpeg(canvas, quality);
  return { blob, wPt: vp1.width, hPt: vp1.height };
}

/* 生成效果预览 + 预计大小 */
$('#btnPreview').addEventListener('click', async () => {
  if (!cp.doc) return;
  const btn = $('#btnPreview');
  btn.disabled = true;
  const prog = $('#compressProgress');
  try {
    const s = compressSettings();
    $('#previewArea').classList.remove('hidden');

    if (s.lossless) {
      setProgress(prog, 0.4, '正在进行无损优化估算…');
      await yieldUI();
      const src = await PDFLib.PDFDocument.load(cp.bytes);
      const out = await src.save({ useObjectStreams: true });
      hideProgress(prog);
      const ratio = out.length / cp.file.size;
      $('#estimateLine').innerHTML =
        `无损优化后大小：<b>${formatSize(out.length)}</b>（原始 ${formatSize(cp.file.size)}，` +
        (ratio < 0.99 ? `节省 <b>${Math.round((1 - ratio) * 100)}%</b>` : '该文件已较为紧凑，优化空间有限') +
        '）· 页面内容与文字层保持不变';
      $('.compare-grid', $('#previewArea')).classList.add('hidden');
      return;
    }

    $('.compare-grid', $('#previewArea')).classList.remove('hidden');
    // 原始效果：第 1 页按 150dpi 渲染作为对照
    setProgress(prog, 0.15, '正在渲染原始页面…');
    await yieldUI();
    await renderPdfPageToCanvas(cp.doc, 1, 150 / 72, $('#canvasOriginal'));

    // 压缩效果：按设定参数渲染并经过 JPEG 压缩再解码
    setProgress(prog, 0.4, '正在生成压缩效果…');
    await yieldUI();
    const sampleCount = Math.min(3, cp.pageCount);
    let sampleTotal = 0, first = null;
    for (let i = 1; i <= sampleCount; i++) {
      setProgress(prog, 0.4 + 0.5 * (i / sampleCount), `正在采样第 ${i} / ${sampleCount} 页估算大小…`);
      await yieldUI();
      const r = await renderPageJpeg(cp.doc, i, s.dpi, s.quality);
      sampleTotal += r.blob.size;
      if (i === 1) first = r;
    }
    const bmp = await createImageBitmap(first.blob);
    const cc = $('#canvasCompressed');
    cc.width = bmp.width; cc.height = bmp.height;
    cc.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    $('#compressedCaption').textContent = `压缩后（第 1 页 · ${s.dpi} DPI / 质量 ${Math.round(s.quality * 100)}%）`;

    const estimated = Math.round((sampleTotal / sampleCount) * cp.pageCount * 1.02 + 3000);
    const ratio = estimated / cp.file.size;
    $('#estimateLine').innerHTML =
      `预计压缩后大小：<b>${formatSize(estimated)}</b>（原始 ${formatSize(cp.file.size)}，` +
      (ratio < 1 ? `约节省 <b>${Math.round((1 - ratio) * 100)}%</b>` : '<b>可能大于原文件</b>，建议改用无损优化或降低参数') +
      '）· 可对比右图确认清晰度后再压缩';
    hideProgress(prog);
  } catch (err) {
    console.error(err);
    hideProgress(prog);
    toast('预览生成失败：' + friendlyError(err), true);
  } finally {
    btn.disabled = false;
  }
});

/* 开始压缩 */
$('#btnCompress').addEventListener('click', async () => {
  if (!cp.doc) return;
  const btn = $('#btnCompress');
  btn.disabled = true;
  const prog = $('#compressProgress');
  try {
    const s = compressSettings();
    let outBytes;
    if (s.lossless) {
      setProgress(prog, 0.5, '正在进行无损优化…');
      await yieldUI();
      const src = await PDFLib.PDFDocument.load(cp.bytes);
      outBytes = await src.save({ useObjectStreams: true });
    } else {
      const outDoc = await PDFLib.PDFDocument.create();
      for (let i = 1; i <= cp.pageCount; i++) {
        setProgress(prog, (i - 1) / cp.pageCount, `正在压缩第 ${i} / ${cp.pageCount} 页…`);
        await yieldUI();
        const r = await renderPageJpeg(cp.doc, i, s.dpi, s.quality);
        const img = await outDoc.embedJpg(await r.blob.arrayBuffer());
        const page = outDoc.addPage([r.wPt, r.hPt]);
        page.drawImage(img, { x: 0, y: 0, width: r.wPt, height: r.hPt });
      }
      setProgress(prog, 1, '正在生成 PDF…');
      outBytes = await outDoc.save();
    }
    hideProgress(prog);
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const saved = 1 - blob.size / cp.file.size;
    const outName = cp.file.name.replace(/\.pdf$/i, '') + (s.lossless ? '-优化.pdf' : '-压缩.pdf');
    const detail = `原始 ${formatSize(cp.file.size)} → 压缩后 <b>${formatSize(blob.size)}</b>` +
      (saved > 0 ? `，节省 <b>${Math.round(saved * 100)}%</b>` : '（未能进一步减小，该文件可能已高度压缩）');
    showResult($('#compressResult'), s.lossless ? '无损优化完成' : '压缩完成', detail, blob, outName);
  } catch (err) {
    console.error(err);
    hideProgress(prog);
    toast('压缩失败：' + friendlyError(err), true);
  } finally {
    btn.disabled = false;
  }
});

/* ==========================================================================
 * 三、页面排序（拖拽缩略图 + 删除 + 倒序）
 * ========================================================================== */
const ro = {
  file: null, bytes: null, doc: null, pageCount: 0, thumbs: [], sortable: null,
  fillStep: 0,     // 点击缩略图快速填入起止页：0=待填起点 1=待填终点
  moduleSeq: 0,    // 模块默认命名/配色序号
  lastDragTs: 0,   // 拖拽结束时间，用于忽略拖后残留的 click
};
App.reorder.state = ro;

const MODULE_COLORS = ['#3b6cf0', '#17a05e', '#e08a00', '#9b59d0', '#e05252', '#0e9aa7'];

function resetReorder() {
  closeLightbox();
  if (ro.doc) { ro.doc.destroy(); ro.doc = null; }
  ro.file = null; ro.bytes = null; ro.pageCount = 0; ro.thumbs = [];
  ro.fillStep = 0; ro.moduleSeq = 0;
  if (ro.sortable) { ro.sortable.destroy(); ro.sortable = null; }
  $('#thumbGrid').innerHTML = '';
  $('#reorderBody').classList.add('hidden');
  $('#reorderResult').classList.add('hidden');
  hideProgress($('#reorderProgress'));
  $('#reorderDrop').classList.remove('hidden');
}

/* 顶层单元：散页缩略图或模块卡片（排除 Sortable 拖拽产生的临时克隆体，
 * 否则读取顺序时会把克隆算成一页，造成页面凭空增加） */
function units() {
  return $$('#thumbGrid > .unit').filter(el => !el.classList.contains('sortable-fallback'));
}

function currentOrder() {
  const out = [];
  for (const u of units()) {
    if (u.classList.contains('module-card')) {
      for (const m of $$('.mini-thumb', u)) out.push(+m.dataset.src);
    } else {
      out.push(+u.dataset.src);
    }
  }
  return out;
}
App.reorder.currentOrder = currentOrder;

/* 某张散页卡片在扁平页序中的位置（1 起） */
function pagePosOf(card) {
  let k = 1;
  for (const u of units()) {
    if (u === card) return k;
    k += u.classList.contains('module-card') ? $$('.mini-thumb', u).length : 1;
  }
  return -1;
}

function reorderRenumber() {
  let k = 1;
  for (const u of units()) {
    if (u.classList.contains('module-card')) {
      const n = $$('.mini-thumb', u).length;
      $('.mc-range', u).textContent = n ? `现第 ${k} ~ ${k + n - 1} 页 · ${n} 页` : '';
      k += n;
    } else {
      $('.tc-pos', u).textContent = `第 ${k} 页`;
      k++;
    }
  }
  const kept = k - 1;
  const mods = $$('#thumbGrid .module-card').length;
  $('#reorderHint').textContent =
    `拖动缩略图或模块卡片调整顺序；点击缩略图右上角 × 删除页面。当前：共 ${ro.pageCount} 页，导出 ${kept} 页${mods ? `，${mods} 个模块` : ''}。`;
  ['mFrom', 'mTo'].forEach(id => { $('#' + id).max = kept; });
}

function makeThumbCard(srcIndex, dataUrl) {
  const card = document.createElement('div');
  card.className = 'thumb-card unit';
  card.dataset.src = srcIndex;
  card.innerHTML = `
    <img alt="第 ${srcIndex + 1} 页缩略图">
    <span class="tc-badge">原第 ${srcIndex + 1} 页</span>
    <button class="tc-del" title="删除该页">×</button>
    <button class="tc-zoom" title="放大预览">🔍</button>
    <div class="tc-pos"></div>`;
  $('img', card).src = dataUrl;
  $('.tc-del', card).addEventListener('click', e => {
    e.stopPropagation();
    if (currentOrder().length <= 1) { toast('至少保留一页', true); return; }
    card.remove();
    clearFillAnchor();
    reorderRenumber();
  });
  $('.tc-zoom', card).addEventListener('click', e => {
    e.stopPropagation();
    openLightbox(srcIndex);
  });
  card.addEventListener('click', () => thumbFillClick(card));
  return card;
}

function rebuildThumbGrid(order) {
  const grid = $('#thumbGrid');
  grid.innerHTML = '';
  for (const src of order) grid.appendChild(makeThumbCard(src, ro.thumbs[src]));
  clearFillAnchor();
  reorderRenumber();
}

async function reorderHandleFile(file) {
  if (!/\.pdf$/i.test(file.name)) { toast('请选择 PDF 文件', true); return; }
  resetReorder();
  const prog = $('#reorderProgress');
  try {
    ro.bytes = await fileToBytes(file);
    const doc = await openPdfJs(ro.bytes);
    ro.doc = doc; // 保留文档实例，供放大预览时按需高清渲染
    ro.file = file;
    ro.pageCount = doc.numPages;
    fillFileCard($('#reorderFileCard'), file, `${ro.pageCount} 页`);
    $('#reorderDrop').classList.add('hidden');
    $('#reorderBody').classList.remove('hidden');
    $('#mFrom').value = 1;
    $('#mTo').value = Math.min(2, ro.pageCount);
    $('#mName').value = '';

    ro.thumbs = [];
    const canvas = document.createElement('canvas');
    for (let i = 1; i <= ro.pageCount; i++) {
      setProgress(prog, (i - 1) / ro.pageCount, `正在生成缩略图 ${i} / ${ro.pageCount}…`);
      await yieldUI();
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      await renderPdfPageToCanvas(doc, i, 420 / vp1.width, canvas);
      ro.thumbs.push(canvas.toDataURL('image/jpeg', 0.8));
    }
    hideProgress(prog);
    rebuildThumbGrid(ro.thumbs.map((_, i) => i));

    ro.sortable = new Sortable($('#thumbGrid'), {
      animation: 160,
      draggable: '.unit',                 // 散页与模块卡片都是可拖动单元
      filter: '.mc-name, .mc-dissolve, .tc-del, .mt-del',
      preventOnFilter: false,             // 名称输入框/按钮保持可点击
      forceFallback: true,
      fallbackOnBody: true,               // 拖拽克隆体放到 body，绝不混入网格计数
      ghostClass: 'thumb-ghost',
      dragClass: 'thumb-drag',
      onEnd: () => { ro.lastDragTs = Date.now(); },
      onSort: reorderRenumber,
    });
  } catch (err) {
    console.error(err);
    hideProgress(prog);
    toast('PDF 读取失败：' + friendlyError(err), true);
    resetReorder(); // 会同时销毁 ro.doc
  }
}
App.reorder.handleFile = reorderHandleFile;
bindDropzone('reorderDrop', 'reorderInput', reorderHandleFile);

$('#btnResetOrder').addEventListener('click', () => {
  rebuildThumbGrid(ro.thumbs.map((_, i) => i));
  toast('已重置为原始顺序');
});

/* ---- 区间成组（模块）----
 * 将连续的第 a ~ b 页组成一个可命名的「模块」卡片；拖动模块卡片即可整体
 * 与其他模块/散页交换顺序（如：说明书中文版 1-5 页与英文版 6-10 页互换）。
 * 模块可随时改名、解散（页面原位保留）。 */

function clearFillAnchor() {
  ro.fillStep = 0;
  $$('#thumbGrid .fill-anchor').forEach(c => c.classList.remove('fill-anchor'));
}

/* 点击缩略图快速把页码填入创建表单：第一次点=起点，第二次点=终点 */
function thumbFillClick(card) {
  if (Date.now() - (ro.lastDragTs || 0) < 350) return; // 忽略拖拽结束后的残留 click
  const pos = pagePosOf(card);
  if (pos < 0) return;
  if (ro.fillStep !== 1) {
    clearFillAnchor();
    card.classList.add('fill-anchor');
    $('#mFrom').value = pos;
    $('#mTo').value = pos;
    ro.fillStep = 1;
    toast(`起点已填入：第 ${pos} 页，再点击终点页`);
  } else {
    const a = parseInt($('#mFrom').value, 10) || pos;
    $('#mFrom').value = Math.min(a, pos);
    $('#mTo').value = Math.max(a, pos);
    clearFillAnchor();
    toast(`区间已填入：第 ${Math.min(a, pos)} ~ ${Math.max(a, pos)} 页，点击「创建模块」成组`);
  }
}

document.addEventListener('keydown', e => {
  if (lightboxOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); lightboxStep(1); }
    return;
  }
  if (e.key === 'Escape' && docPaneActive('tab-reorder')) clearFillAnchor();
});

/* ---- 放大预览灯箱：按需从 pdf.js 高清渲染，支持按当前顺序翻页 ---- */
const lb = { src: 0, gen: 0 };

function lightboxOpen() { return !$('#lightbox').classList.contains('hidden'); }

function closeLightbox() {
  lb.gen++;
  $('#lightbox').classList.add('hidden');
}

async function renderLightbox() {
  if (!ro.doc) return;
  const gen = ++lb.gen;
  const order = currentOrder();
  const pos = order.indexOf(lb.src);
  $('#lbCaption').textContent =
    `原第 ${lb.src + 1} 页 · 当前第 ${pos + 1} / ${order.length} 页（← → 翻页，Esc 关闭）`;
  $('.lb-prev').disabled = pos <= 0;
  $('.lb-next').disabled = pos >= order.length - 1;
  try {
    const page = await ro.doc.getPage(lb.src + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 视口尺寸加下限保护：极端环境（隐藏窗口等）下 innerWidth/Height 可能为 0
    const vw = Math.max(window.innerWidth || 0, 640);
    const vh = Math.max(window.innerHeight || 0, 480);
    let fit = Math.min((vw * 0.84) / vp1.width, (vh * 0.84) / vp1.height);
    if (!isFinite(fit) || fit <= 0) fit = 1;
    const vp = page.getViewport({ scale: fit * dpr });
    const canvas = $('#lbCanvas');
    if (gen !== lb.gen) return;
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = Math.floor(vp.width / dpr) + 'px';
    canvas.style.height = Math.floor(vp.height / dpr) + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
  } catch (err) {
    console.error(err);
    if (gen === lb.gen) toast('预览渲染失败：' + friendlyError(err), true);
  }
}

function openLightbox(src) {
  if (!ro.doc) return;
  lb.src = src;
  $('#lightbox').classList.remove('hidden');
  renderLightbox();
}

function lightboxStep(delta) {
  const order = currentOrder();
  const pos = order.indexOf(lb.src);
  const next = pos + delta;
  if (next < 0 || next >= order.length) return;
  lb.src = order[next];
  renderLightbox();
}

$('.lb-close').addEventListener('click', closeLightbox);
$('.lb-prev').addEventListener('click', () => lightboxStep(-1));
$('.lb-next').addEventListener('click', () => lightboxStep(1));
window.addEventListener('resize', () => { if (lightboxOpen()) renderLightbox(); });
$('#lightbox').addEventListener('click', e => {
  if (e.target === e.currentTarget || e.target.classList.contains('lb-stage')) closeLightbox();
});

/* ---- 缩略图大小调节（小/中/大，记忆选择）---- */
const THUMB_SIZES = { s: ['150px', '80px'], m: ['200px', '104px'], l: ['270px', '140px'] };

function applyThumbSize(key, persist) {
  const [tw, mw] = THUMB_SIZES[key] || THUMB_SIZES.m;
  const grid = $('#thumbGrid');
  grid.style.setProperty('--thumb-w', tw);
  grid.style.setProperty('--mini-w', mw);
  $$('.ts-btn').forEach(b => b.classList.toggle('active', b.dataset.tsize === key));
  if (persist) { try { localStorage.setItem('ft-thumb-size', key); } catch (_) { /* 忽略 */ } }
}
$$('.ts-btn').forEach(b => b.addEventListener('click', () => applyThumbSize(b.dataset.tsize, true)));
(() => {
  let k = 'm';
  try { k = localStorage.getItem('ft-thumb-size') || 'm'; } catch (_) { /* 忽略 */ }
  applyThumbSize(THUMB_SIZES[k] ? k : 'm', false);
})();

function makeMiniThumb(src) {
  const d = document.createElement('div');
  d.className = 'mini-thumb';
  d.dataset.src = src;
  d.title = '点击放大预览';
  d.innerHTML = `<img alt="原第 ${src + 1} 页"><span class="mt-badge">原第 ${src + 1} 页</span><button class="mt-del" title="删除该页">×</button>`;
  $('img', d).src = ro.thumbs[src];
  $('.mt-del', d).addEventListener('click', e => {
    e.stopPropagation();
    if (currentOrder().length <= 1) { toast('至少保留一页', true); return; }
    const mod = d.closest('.module-card');
    d.remove();
    if (!$$('.mini-thumb', mod).length) mod.remove();
    reorderRenumber();
  });
  d.addEventListener('click', e => {
    if (Date.now() - (ro.lastDragTs || 0) < 350) return;
    e.stopPropagation();
    openLightbox(src);
  });
  return d;
}

function makeModuleCard(name, color) {
  const el = document.createElement('div');
  el.className = 'module-card unit';
  el.style.setProperty('--mc', color);
  el.innerHTML = `
    <div class="mc-head">
      <span class="mc-grip" title="拖动整体调序">⠿</span>
      <input class="mc-name" maxlength="12" title="点击修改模块名称" spellcheck="false">
      <span class="mc-range"></span>
      <button class="mc-dissolve" title="解散模块，页面在原位保留">解散</button>
    </div>
    <div class="mc-thumbs"></div>`;
  $('.mc-name', el).value = name;
  $('.mc-dissolve', el).addEventListener('click', e => {
    e.stopPropagation();
    for (const m of $$('.mini-thumb', el)) {
      el.before(makeThumbCard(+m.dataset.src, ro.thumbs[+m.dataset.src]));
    }
    el.remove();
    reorderRenumber();
    toast('模块已解散，页面顺序保持不变');
  });
  return el;
}

$('#btnMakeModule').addEventListener('click', () => {
  const total = currentOrder().length;
  if (!total) return;
  const a = parseInt($('#mFrom').value, 10);
  const b = parseInt($('#mTo').value, 10);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > total) {
    toast(`区间无效：请输入 1 ~ ${total} 之间的页码，且起始 ≤ 结束`, true);
    return;
  }
  // 收集区间覆盖的顶层单元；要求全部为未成组的散页
  const singles = [];
  let k = 1;
  for (const u of units()) {
    const span = u.classList.contains('module-card') ? $$('.mini-thumb', u).length : 1;
    if (k + span - 1 >= a && k <= b) {
      if (u.classList.contains('module-card')) {
        toast(`区间与模块「${$('.mc-name', u).value}」重叠，请先解散该模块或调整区间`, true);
        return;
      }
      singles.push(u);
    }
    k += span;
  }
  if (!singles.length) return;
  ro.moduleSeq++;
  const name = $('#mName').value.trim() ||
    `模块 ${ro.moduleSeq <= 26 ? String.fromCharCode(64 + ro.moduleSeq) : ro.moduleSeq}`;
  const mod = makeModuleCard(name, MODULE_COLORS[(ro.moduleSeq - 1) % MODULE_COLORS.length]);
  singles[0].before(mod);
  const wrap = $('.mc-thumbs', mod);
  for (const s of singles) {
    wrap.appendChild(makeMiniThumb(+s.dataset.src));
    s.remove();
  }
  $('#mName').value = '';
  clearFillAnchor();
  reorderRenumber();
  toast(`已创建模块「${name}」（第 ${a} ~ ${b} 页），拖动其卡片即可整体调序`);
});

$('#btnReverse').addEventListener('click', () => {
  // 按顶层单元倒序：模块保持内部页序，与散页一起整体倒排
  const grid = $('#thumbGrid');
  for (const u of units().reverse()) grid.appendChild(u);
  reorderRenumber();
});

$('#btnExportReorder').addEventListener('click', async () => {
  if (!ro.bytes) return;
  const order = currentOrder();
  if (!order.length) { toast('没有可导出的页面', true); return; }
  const btn = $('#btnExportReorder');
  btn.disabled = true;
  const prog = $('#reorderProgress');
  try {
    setProgress(prog, 0.2, '正在读取原始 PDF…');
    await yieldUI();
    const src = await PDFLib.PDFDocument.load(ro.bytes);
    setProgress(prog, 0.5, '正在按新顺序组装页面…');
    await yieldUI();
    const out = await PDFLib.PDFDocument.create();
    const copied = await out.copyPages(src, order);
    copied.forEach(p => out.addPage(p));
    setProgress(prog, 0.85, '正在生成 PDF…');
    const bytes = await out.save();
    hideProgress(prog);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const outName = ro.file.name.replace(/\.pdf$/i, '') + '-重排.pdf';
    const removed = ro.pageCount - order.length;
    showResult($('#reorderResult'), '导出完成',
      `导出 ${order.length} 页${removed > 0 ? `（删除了 ${removed} 页）` : ''} · 输出大小 <b>${formatSize(blob.size)}</b>`,
      blob, outName);
  } catch (err) {
    console.error(err);
    hideProgress(prog);
    toast('导出失败：' + friendlyError(err), true);
  } finally {
    btn.disabled = false;
  }
});

/* ==========================================================================
 * 主题切换（浅色 / 深色，记忆在 localStorage，首屏由 index.html 内联脚本预设）
 * ========================================================================== */
function applyTheme(t, persist) {
  document.documentElement.dataset.theme = t;
  if (persist) { try { localStorage.setItem('ft-theme', t); } catch (_) { /* 隐私模式等 */ } }
  // 仅作用于带 data-theme-set 的按钮，避免误伤其他分段控件
  $$('.theme-btn[data-theme-set]').forEach(b => b.classList.toggle('active', b.dataset.themeSet === t));
}
$$('.theme-btn[data-theme-set]').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.themeSet, true)));
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', false);
App.applyTheme = applyTheme;
