/* ==========================================================================
 * 拾色器：图片取色（像素放大镜）· 屏幕取色（EyeDropper）· HEX/RGB/HSL 互转
 * 与复制 · 取色历史（localStorage 记忆）
 * ========================================================================== */
'use strict';

(function () {

const MAX_DIM = 4096;      // 超大图片按比例压到该尺寸内，避免内存暴涨
const LOUPE_PIXELS = 11;   // 放大镜取样区域边长（像素数，奇数保证有中心点）
const HISTORY_MAX = 18;

const pk = { hasImage: false, color: '#3b6cf0', history: [] };
App.picker = { state: pk };

const canvas = $('#pickerCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const wrap = $('#pickerCanvasWrap');
const loupe = $('#loupe');
const loupeCanvas = $('#loupeCanvas');
const loupeCtx = loupeCanvas.getContext('2d');

/* ---------------- 颜色转换 ---------------- */
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

/* ---------------- 结果面板 ---------------- */
function formatColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  return {
    hex: hex.toUpperCase(),
    rgb: `rgb(${r}, ${g}, ${b})`,
    hsl: `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`,
  };
}

/* 仅更新面板显示（悬停实时预览用，不改变已选颜色、不写历史） */
function renderColorDisplay(hex) {
  const f = formatColor(hex);
  $('#ppSwatch').style.background = hex;
  $('#ppHex').textContent = f.hex;
  $('#ppRgb').textContent = f.rgb;
  $('#ppHsl').textContent = f.hsl;
  const input = $('#ppHexInput');
  if (document.activeElement !== input) input.value = f.hex; // 正在手动输入时不打断
}

function setColor(hex, push) {
  hex = hex.toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return;
  pk.color = hex;
  renderColorDisplay(hex);
  if (push) {
    pk.history = [hex, ...pk.history.filter(c => c !== hex)].slice(0, HISTORY_MAX);
    try { localStorage.setItem('ft-picker-history', JSON.stringify(pk.history)); } catch (_) { /* 忽略 */ }
    renderHistory();
  }
}
App.picker.setColor = setColor;

function renderHistory() {
  const box = $('#ppHistory');
  box.innerHTML = '';
  if (!pk.history.length) {
    box.innerHTML = '<span class="pp-history-empty">还没有取过色</span>';
    return;
  }
  for (const hex of pk.history) {
    const b = document.createElement('button');
    b.className = 'pp-chip';
    b.style.background = hex;
    b.title = hex.toUpperCase() + '（点击选用）';
    b.addEventListener('click', () => setColor(hex, false));
    box.appendChild(b);
  }
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制 ${label}：${text}`);
  } catch (_) {
    // 剪贴板权限受限时退化为选中提示
    toast(`复制失败，请手动选择复制：${text}`, true);
  }
}

$$('.pp-copy').forEach(btn => btn.addEventListener('click', () => {
  const f = formatColor(pk.color);
  copyText(f[btn.dataset.copy], btn.dataset.copy.toUpperCase());
}));
$('#ppSwatch').addEventListener('click', () => copyText(formatColor(pk.color).hex, 'HEX'));

$('#ppHexInput').addEventListener('change', e => {
  let v = e.target.value.trim().replace(/^#?/, '#');
  if (/^#[0-9a-fA-F]{3}$/.test(v)) v = '#' + [...v.slice(1)].map(c => c + c).join('');
  if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(v, true);
  else {
    toast('无效的 HEX 色值，示例：#3B6CF0', true);
    e.target.value = formatColor(pk.color).hex;
  }
});

/* ---------------- 图片 / 画面加载 ---------------- */
function showLoadedState() {
  pk.hasImage = true;
  canvas.classList.remove('hidden');
  $('#pickerEmpty').classList.add('hidden');
  $('#pickerDrop').classList.add('hidden');
  $('#btnPickerClear').classList.remove('hidden');
}

/* 把任意可绘制源（ImageBitmap / video 帧）绘入取色画布，超大自动压缩 */
function drawSourceToCanvas(source, w, h) {
  const scale = Math.min(1, MAX_DIM / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
}

async function pickerHandleFile(file) {
  if (!file.type.startsWith('image/')) { toast('请选择图片文件（PNG / JPG / WebP 等）', true); return; }
  try {
    const bmp = await createImageBitmap(file);
    drawSourceToCanvas(bmp, bmp.width, bmp.height);
    bmp.close();
    showLoadedState();
    toast('图片已加载，移动鼠标实时查看色值，点击取色');
  } catch (err) {
    console.error(err);
    toast('图片加载失败：' + friendlyError(err), true);
  }
}
App.picker.handleFile = pickerHandleFile;
bindDropzone('pickerDrop', 'pickerInput', pickerHandleFile);

$('#btnPickerClear').addEventListener('click', () => {
  pk.hasImage = false;
  canvas.classList.add('hidden');
  loupe.classList.add('hidden');
  $('#pickerEmpty').classList.remove('hidden');
  $('#pickerDrop').classList.remove('hidden');
  $('#btnPickerClear').classList.add('hidden');
});

/* 粘贴截图/图片（拾色器标签页激活时） */
document.addEventListener('paste', e => {
  if (!$('#tab-picker').classList.contains('active')) return;
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) { e.preventDefault(); pickerHandleFile(f); }
      return;
    }
  }
});

/* ---------------- 画布取色与放大镜 ---------------- */
function canvasPixel(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left) * (canvas.width / r.width));
  const y = Math.round((e.clientY - r.top) * (canvas.height / r.height));
  return {
    x: Math.max(0, Math.min(canvas.width - 1, x)),
    y: Math.max(0, Math.min(canvas.height - 1, y)),
  };
}

function pixelHex(x, y) {
  const d = ctx.getImageData(x, y, 1, 1).data;
  return rgbToHex(d[0], d[1], d[2]);
}

function updateLoupe(e) {
  const { x, y } = canvasPixel(e);
  const hex = pixelHex(x, y);
  // 放大镜：以 (x,y) 为中心取 LOUPE_PIXELS² 区域，像素级放大
  const half = (LOUPE_PIXELS - 1) / 2;
  loupeCtx.imageSmoothingEnabled = false;
  loupeCtx.fillStyle = '#888';
  loupeCtx.fillRect(0, 0, loupeCanvas.width, loupeCanvas.height);
  loupeCtx.drawImage(canvas,
    x - half, y - half, LOUPE_PIXELS, LOUPE_PIXELS,
    0, 0, loupeCanvas.width, loupeCanvas.height);
  $('#loupeHex').textContent = hex.toUpperCase();
  // 定位在光标右下方，越界翻转
  const wr = wrap.getBoundingClientRect();
  let lx = e.clientX - wr.left + 18;
  let ly = e.clientY - wr.top + 18;
  if (lx + 130 > wr.width) lx = e.clientX - wr.left - 130 - 6;
  if (ly + 150 > wr.height) ly = e.clientY - wr.top - 150 - 6;
  loupe.style.left = lx + 'px';
  loupe.style.top = ly + 'px';
  loupe.classList.remove('hidden');
  return hex;
}

canvas.addEventListener('pointermove', e => {
  if (!pk.hasImage) return;
  const hex = updateLoupe(e);
  renderColorDisplay(hex); // 悬停实时刷新右侧面板
});
canvas.addEventListener('pointerleave', () => {
  loupe.classList.add('hidden');
  renderColorDisplay(pk.color); // 移开后恢复已选颜色
});
canvas.addEventListener('click', e => {
  if (!pk.hasImage) return;
  const { x, y } = canvasPixel(e);
  const hex = pixelHex(x, y);
  setColor(hex, true);
  toast(`已取色 ${hex.toUpperCase()}`);
});

/* ---------------- 截屏实时取色（Screen Capture → 画布，实时显示色值） ---------------- */
/* 从视频流截取一帧绘入取色画布（拆出便于测试：canvas.captureStream 也走同一路径） */
async function loadStreamFrame(stream, settleMs) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (video.readyState < 2) {
    await new Promise(r => { video.onloadeddata = r; });
  }
  // 稍等片刻，避开屏幕共享选择弹窗的残影
  if (settleMs) await new Promise(r => setTimeout(r, settleMs));
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) throw new Error('未能获取画面帧');
  drawSourceToCanvas(video, w, h);
  video.srcObject = null;
  showLoadedState();
}
App.picker.loadStreamFrame = loadStreamFrame;

$('#btnScreenGrab').addEventListener('click', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('当前浏览器不支持屏幕捕获，可改用「快速取色」或图片取色', true);
    return;
  }
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    await loadStreamFrame(stream, 400);
    toast('已截取屏幕画面：移动鼠标实时查看色值，点击取色');
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return; // 用户取消
    console.error(err);
    toast('屏幕捕获失败：' + friendlyError(err), true);
  } finally {
    if (stream) stream.getTracks().forEach(t => t.stop()); // 截取一帧即停止共享
  }
});

/* ---------------- 快速取色（系统吸管 EyeDropper API） ---------------- */
$('#btnEyeDropper').addEventListener('click', async () => {
  if (!window.EyeDropper) {
    toast('当前浏览器不支持屏幕取色（需 Chrome / Edge 95+），可改用图片取色', true);
    return;
  }
  try {
    const result = await new window.EyeDropper().open();
    setColor(result.sRGBHex, true);
    toast(`已取色 ${result.sRGBHex.toUpperCase()}`);
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('屏幕取色失败：' + friendlyError(err), true);
  }
});
if (!window.EyeDropper) {
  $('#btnEyeDropper').classList.add('ed-unsupported');
  $('#btnEyeDropper').title = '当前浏览器不支持 EyeDropper API';
}

/* ---------------- 初始化 ---------------- */
try {
  const saved = JSON.parse(localStorage.getItem('ft-picker-history') || '[]');
  if (Array.isArray(saved)) pk.history = saved.filter(c => /^#[0-9a-f]{6}$/.test(c)).slice(0, HISTORY_MAX);
} catch (_) { /* 忽略 */ }
renderHistory();
setColor(pk.history[0] || '#3b6cf0', false);

})();
