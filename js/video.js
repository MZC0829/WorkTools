/* ==========================================================================
 * 视频转音频（本地 ffmpeg.wasm，单线程核心，无需服务器）
 * 依赖 vendor/ffmpeg/：ffmpeg.js（主线程 UMD）+ 814.ffmpeg.js（worker）
 *                    + ffmpeg-core.js / ffmpeg-core.wasm（转换核心，懒加载）
 * ========================================================================== */
(() => {

const FFMPEG_DIR = 'vendor/ffmpeg/';
const FFMPEG_VER = '1';

/* libvorbis 只在有限的（采样率 × 声道 × 码率）组合上支持固定码率，单声道 / 22.05kHz /
 * 高采样率等常见输入会直接 encoder setup failed；改用等效的 VBR 质量档，全区间可用。 */
const OGG_QUALITY = { 128: '4', 192: '6', 256: '8', 320: '9' };

/* 输出格式定义。lossy 决定是否显示码率选择，vbr 表示码率为目标值而非固定值 */
const FORMATS = {
  mp3:  { mime: 'audio/mpeg', lossy: true,  args: b => ['-c:a', 'libmp3lame', '-b:a', b + 'k'] },
  m4a:  { mime: 'audio/mp4',  lossy: true,  args: b => ['-c:a', 'aac', '-b:a', b + 'k'] },
  wav:  { mime: 'audio/wav',  lossy: false, args: () => ['-c:a', 'pcm_s16le'] },
  flac: { mime: 'audio/flac', lossy: false, args: () => ['-c:a', 'flac'] },
  ogg:  { mime: 'audio/ogg',  lossy: true, vbr: true,
          args: b => ['-c:a', 'libvorbis', '-q:a', OGG_QUALITY[b] || '6'] },
};

const vd = {
  file: null, duration: 0,
  ffmpeg: null, pendingFf: null, loadPromise: null, abort: null,
  busy: false, cancelled: false,
  lastLogs: [], onProgress: null,
  previewUrl: null, audioUrl: null,
};
App.video = vd;

const drop = $('#videoDrop');
const body = $('#videoBody');
const progWrap = $('#videoProgress');
const resultEl = $('#videoResult');
const btnConvert = $('#btnV2A');
const btnCancel = $('#btnV2ACancel');
const videoEl = $('#videoPreview');
const audioWrap = $('#audioPreviewWrap');
const audioEl = $('#audioPreview');
const fmtSelect = $('#audioFormat');
const brSelect = $('#audioBitrate');

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function fillVideoCard(file, extraMeta) {
  const card = $('#videoCard');
  card.innerHTML = `
    <div class="fc-icon">🎬</div>
    <div>
      <div class="fc-name"></div>
      <div class="fc-meta"></div>
    </div>`;
  $('.fc-name', card).textContent = file.name;
  $('.fc-meta', card).textContent = formatSize(file.size) + (extraMeta ? ' · ' + extraMeta : '');
}

/* ---------------- 文件选择与预览 ---------------- */
/* 不按 MIME 强校验：MKV/FLV 等在部分系统上拿不到 video/* 类型，交给 ffmpeg 探测 */
bindDropzone('videoDrop', 'videoInput', file => {
  if (vd.busy) { toast('正在转换中，请先取消或等待完成', true); return; }
  vd.file = file;
  vd.duration = 0;
  drop.classList.add('hidden');
  body.classList.remove('hidden');
  resultEl.classList.add('hidden');
  audioWrap.classList.add('hidden');
  hideProgress(progWrap);
  fillVideoCard(file, '');
  if (vd.previewUrl) URL.revokeObjectURL(vd.previewUrl);
  vd.previewUrl = URL.createObjectURL(file);
  videoEl.classList.remove('hidden');
  videoEl.src = vd.previewUrl;
});

videoEl.addEventListener('loadedmetadata', () => {
  if (vd.file && isFinite(videoEl.duration) && videoEl.duration > 0) {
    vd.duration = videoEl.duration;
    fillVideoCard(vd.file, '时长 ' + fmtDuration(vd.duration));
  }
});
/* 浏览器不能播放（如 AVI/WMV）不影响转换，仅收起预览 */
videoEl.addEventListener('error', () => {
  if (!vd.file) return;
  videoEl.classList.add('hidden');
  fillVideoCard(vd.file, '浏览器无法预览该格式（不影响转换）');
});

vd.reset = () => {
  // 转换期间不允许换文件：否则本次输出会张冠李戴（旧音频配新文件名）
  if (vd.busy) { toast('正在转换中，请先取消或等待完成', true); return; }
  vd.file = null;
  vd.duration = 0;
  if (vd.previewUrl) { URL.revokeObjectURL(vd.previewUrl); vd.previewUrl = null; }
  if (vd.audioUrl) { URL.revokeObjectURL(vd.audioUrl); vd.audioUrl = null; }
  videoEl.removeAttribute('src'); videoEl.load();
  audioEl.removeAttribute('src'); audioEl.load();
  resultEl.classList.add('hidden');
  audioWrap.classList.add('hidden');
  hideProgress(progWrap);
  body.classList.add('hidden');
  drop.classList.remove('hidden');
};

/* 无损格式不需要码率 */
fmtSelect.addEventListener('change', () => {
  brSelect.disabled = !FORMATS[fmtSelect.value].lossy;
});

/* ---------------- 引擎懒加载（约 31MB，带进度） ---------------- */
const mb = n => (n / 1048576).toFixed(1);

/* onProgress(got, total)：total 为 0 表示总量不可信，只应展示已加载量。
 * 服务端启用 gzip/br 时 Content-Length 是压缩后大小，而流里读到的是解压后字节，
 * 两者不可比——此时不报百分比，避免出现 “45.2 / 12.0 MB”“137%” 之类的乱码。 */
async function fetchWithProgress(url, onProgress, signal) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error('引擎下载失败 HTTP ' + resp.status);
  const encoded = /gzip|br|deflate|zstd/i.test(resp.headers.get('Content-Encoding') || '');
  let total = encoded ? 0 : (+resp.headers.get('Content-Length') || 0);
  if (!resp.body) return new Uint8Array(await resp.arrayBuffer());
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total && got > total) total = 0;   // 头部未暴露 Content-Encoding 时的兜底
    if (onProgress) onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function getFFmpeg() {
  if (vd.ffmpeg) return Promise.resolve(vd.ffmpeg);
  if (!vd.loadPromise) {
    vd.loadPromise = (async () => {
      if (typeof FFmpegWASM === 'undefined') throw new Error('转换引擎脚本未加载，请刷新页面重试');
      vd.abort = new AbortController();
      const signal = vd.abort.signal;
      const wasmBytes = await fetchWithProgress(FFMPEG_DIR + 'ffmpeg-core.wasm?v=' + FFMPEG_VER, (got, total) =>
        setProgress(progWrap, total ? (got / total) * 0.95 : 0.05,
          `正在加载本地转换引擎 ${mb(got)}${total ? ' / ' + mb(total) : ''} MB（仅首次，之后使用缓存）`), signal);
      const coreBytes = await fetchWithProgress(FFMPEG_DIR + 'ffmpeg-core.js?v=' + FFMPEG_VER, null, signal);
      setProgress(progWrap, 0.97, '正在初始化转换引擎…');
      const ff = new FFmpegWASM.FFmpeg();
      vd.pendingFf = ff;   // 让「取消」能终止尚未 load 完成的实例，避免遗留 worker
      ff.on('log', e => {
        vd.lastLogs.push(e.message);
        if (vd.lastLogs.length > 60) vd.lastLogs.shift();
      });
      ff.on('progress', e => { if (vd.onProgress) vd.onProgress(e); });
      // 不传 classWorkerURL：UMD 版传入时会以 module worker 启动，
      // 而其 worker 代码只支持 importScripts（classic），会死锁；
      // 默认路径按 ffmpeg.js 所在目录解析到 vendor/ffmpeg/814.ffmpeg.js。
      // core/wasm 走 blob 以复用上面带进度的下载
      const coreURL = URL.createObjectURL(new Blob([coreBytes], { type: 'text/javascript' }));
      const wasmURL = URL.createObjectURL(new Blob([wasmBytes], { type: 'application/wasm' }));
      try {
        await ff.load({ coreURL, wasmURL });
      } finally {
        URL.revokeObjectURL(coreURL);
        URL.revokeObjectURL(wasmURL);
      }
      vd.ffmpeg = ff;
      vd.pendingFf = null;
      vd.abort = null;
      return ff;
    })().catch(err => {
      vd.loadPromise = null;
      vd.pendingFf = null;
      vd.abort = null;
      throw err;
    });
  }
  return vd.loadPromise;
}

/* ---------------- 错误诊断 ---------------- */
function diagnose(logs, fallbackErr) {
  const s = logs.join('\n');
  if (/does not contain any stream|matches no streams|no audio/i.test(s)) return '该视频不包含音频轨';
  if (/Invalid data found|moov atom not found|EBML header parsing failed|Format .* detected only with low score/i.test(s)) {
    return '无法识别的视频格式或文件已损坏';
  }
  if (/decoder .* not found|Decoding requested, but no decoder found/i.test(s)) return '暂不支持该视频的音频编码';
  const tail = logs.filter(l => /error|invalid|fail/i.test(l)).slice(-2).join('；');
  return tail ? '转换失败：' + tail.slice(0, 140) : '转换失败：' + friendlyError(fallbackErr || '未知错误');
}

/* ---------------- 转换 ---------------- */
btnConvert.addEventListener('click', async () => {
  if (!vd.file || vd.busy) return;
  const fmt = fmtSelect.value;
  const spec = FORMATS[fmt];
  if (!spec) return;
  const bitrate = brSelect.value;
  // 固定本次转换的输入文件：后续 await 期间即使界面状态变化也不会张冠李戴
  const srcFile = vd.file;
  vd.busy = true;
  vd.cancelled = false;
  vd.lastLogs = [];        // 必须在引擎加载/写文件之前清，否则早期失败会拿上一次的日志误诊
  btnConvert.disabled = true;
  btnCancel.classList.remove('hidden');   // 引擎首次下载最耗时，这段也要可取消
  resultEl.classList.add('hidden');
  audioWrap.classList.add('hidden');
  const ext = ((srcFile.name.match(/\.([A-Za-z0-9]{1,6})$/) || [])[1] || 'dat').toLowerCase();
  const inName = 'input.' + ext;
  const outName = 'output.' + fmt;
  try {
    const ff = await getFFmpeg();
    setProgress(progWrap, 0, '正在读取视频文件…');
    await ff.writeFile(inName, new Uint8Array(await srcFile.arrayBuffer()));
    let lastFrac = 0;
    vd.onProgress = e => {
      const t = (e.time || 0) / 1e6;
      let frac = e.progress;
      // 部分容器给不出可靠的总时长比例，退回用 <video> 元数据时长估算
      if (!isFinite(frac) || frac <= 0 || frac > 1.5) frac = vd.duration > 0 ? t / vd.duration : NaN;
      const timeTxt = t > 0
        ? '已处理 ' + fmtDuration(vd.duration ? Math.min(t, vd.duration) : t) + (vd.duration ? ' / ' + fmtDuration(vd.duration) : '')
        : '';
      if (isFinite(frac)) {
        lastFrac = Math.max(0, Math.min(1, frac));
        setProgress(progWrap, lastFrac, `正在提取并转换音频… ${Math.round(lastFrac * 100)}%` + (timeTxt ? `（${timeTxt}）` : ''));
      } else {
        // 比例与时长都不可靠：只报已处理时长，不谎报百分比
        setProgress(progWrap, lastFrac, '正在提取并转换音频…' + (timeTxt ? `（${timeTxt}）` : ''));
      }
    };
    setProgress(progWrap, 0, '正在提取并转换音频…');
    const ret = await ff.exec(['-i', inName, '-vn', '-sn', '-dn', ...spec.args(bitrate), '-y', outName]);
    if (ret !== 0) throw new Error(diagnose(vd.lastLogs));
    const data = await ff.readFile(outName);
    if (!data || data.length < 128) throw new Error('该视频不包含音频轨或输出为空');
    const blob = new Blob([data], { type: spec.mime });
    const base = srcFile.name.replace(/\.[^.]{1,6}$/, '') || 'audio';
    hideProgress(progWrap);
    showResult(resultEl, '音频提取完成',
      `${fmt.toUpperCase()} · ${formatSize(blob.size)}${spec.lossy ? ' · ' + (spec.vbr ? '约 ' : '') + bitrate + ' kbps' : ' · 无损'}，已开始下载，可在下方试听`,
      blob, base + '.' + fmt);
    if (vd.audioUrl) URL.revokeObjectURL(vd.audioUrl);
    vd.audioUrl = URL.createObjectURL(blob);
    audioEl.src = vd.audioUrl;
    audioWrap.classList.remove('hidden');
  } catch (err) {
    hideProgress(progWrap);
    if (vd.cancelled) {
      toast('已取消转换');
    } else {
      console.error(err);
      toast(diagnose(vd.lastLogs, err), true);
    }
  } finally {
    vd.onProgress = null;
    if (vd.ffmpeg) {
      try { await vd.ffmpeg.deleteFile(inName); } catch (_) { /* 忽略 */ }
      try { await vd.ffmpeg.deleteFile(outName); } catch (_) { /* 忽略 */ }
    }
    vd.busy = false;
    vd.cancelled = false;
    btnConvert.disabled = false;
    btnCancel.classList.add('hidden');
  }
});

/* 取消：中断引擎下载 / 终止 worker，引擎作废（下次转换会重新初始化，wasm 走浏览器缓存） */
btnCancel.addEventListener('click', () => {
  if (!vd.busy) return;
  vd.cancelled = true;
  if (vd.abort) { try { vd.abort.abort(); } catch (_) { /* 忽略 */ } }
  const ff = vd.ffmpeg || vd.pendingFf;
  if (ff) { try { ff.terminate(); } catch (_) { /* 忽略 */ } }
  vd.ffmpeg = null;
  vd.pendingFf = null;
  vd.loadPromise = null;
});

/* 切换到其他顶层工具时暂停播放：否则看不见的视频/音频仍在出声 */
$$('.tab').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.tab !== 'video') { videoEl.pause(); audioEl.pause(); }
}));

})();
