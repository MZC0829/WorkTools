/* ==========================================================================
 * 音视频工具：视频转音频 + 音频格式转换（本地 ffmpeg.wasm，单线程核心，无需服务器）
 * 两个子模式共用同一个转换引擎（只加载一次）。
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

/* ---------------- 共享引擎状态（两个子模式互斥使用） ---------------- */
const eng = {
  ffmpeg: null, pendingFf: null, loadPromise: null, abort: null,
  busy: false, owner: null,          // owner: 当前转换任务所属子模式的 key
  cancelled: false,
  lastLogs: [], onProgress: null,
  progWrap: null,                     // 当前任务的进度条容器（引擎加载进度也画在这里）
};
App.av = eng;

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

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

/* ---------------- 引擎字节持久缓存（IndexedDB） ----------------
 * iPhone Safari 不会把 31MB 的 wasm 放进 HTTP 磁盘缓存（WebKit 对单条目体积
 * 有上限，且缓存回收激进），页面内存中的引擎实例又随标签页回收而消失，
 * 结果是每次进页面都要重新下载。显式把内核字节存进 IndexedDB（Blob 存储，
 * HTTP 环境也可用，不像 Cache API 要求 HTTPS），之后进页面秒级加载。
 * 任何一步失败（隐私模式 / 配额不足 / 序列化异常）都静默回退到网络下载。 */
const IDB_NAME = 'ft-engine';
const IDB_STORE = 'files';
function idbOpen() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(IDB_STORE); } catch (_) { /* 忽略 */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  if (!db) return null;
  try {
    return await new Promise(resolve => {
      const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => resolve(null);
    });
  } catch (_) { return null; } finally { try { db.close(); } catch (_) { /* 忽略 */ } }
}
/* 写入当前版本条目，同时清掉旧版本残留（31MB 不清会白占配额） */
async function idbPutKeepOnly(entries) {
  const db = await idbOpen();
  if (!db) return;
  try {
    await new Promise(resolve => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const st = tx.objectStore(IDB_STORE);
      const keep = new Set(Object.keys(entries));
      const cur = st.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { if (!keep.has(c.key)) c.delete(); c.continue(); }
        else for (const k of keep) st.put(entries[k], k);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch (_) { /* 忽略 */ } finally { try { db.close(); } catch (_) { /* 忽略 */ } }
}

function getFFmpeg() {
  if (eng.ffmpeg) return Promise.resolve(eng.ffmpeg);
  if (!eng.loadPromise) {
    eng.loadPromise = (async () => {
      if (typeof FFmpegWASM === 'undefined') throw new Error('转换引擎脚本未加载，请刷新页面重试');
      eng.abort = new AbortController();
      const signal = eng.abort.signal;
      const wasmKey = 'v' + FFMPEG_VER + ':ffmpeg-core.wasm';
      const jsKey = 'v' + FFMPEG_VER + ':ffmpeg-core.js';
      setProgress(eng.progWrap, 0.02, '正在检查本地引擎缓存…');
      let wasmBytes = await idbGet(wasmKey);
      let coreBytes = wasmBytes ? await idbGet(jsKey) : null;
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (wasmBytes && coreBytes) {
        setProgress(eng.progWrap, 0.9, '正在从本地缓存加载转换引擎…');
      } else {
        wasmBytes = await fetchWithProgress(FFMPEG_DIR + 'ffmpeg-core.wasm?v=' + FFMPEG_VER, (got, total) =>
          setProgress(eng.progWrap, total ? (got / total) * 0.95 : 0.05,
            `正在加载本地转换引擎 ${mb(got)}${total ? ' / ' + mb(total) : ''} MB（仅首次，之后使用缓存）`), signal);
        coreBytes = await fetchWithProgress(FFMPEG_DIR + 'ffmpeg-core.js?v=' + FFMPEG_VER, null, signal);
        // 落盘为 Blob（WebKit 以文件形式存储，避免大数组结构化克隆的内存峰值）；
        // 不 await：写入失败只影响下次是否重新下载
        idbPutKeepOnly({
          [wasmKey]: new Blob([wasmBytes], { type: 'application/wasm' }),
          [jsKey]: new Blob([coreBytes], { type: 'text/javascript' }),
        });
      }
      setProgress(eng.progWrap, 0.97, '正在初始化转换引擎…');
      const ff = new FFmpegWASM.FFmpeg();
      eng.pendingFf = ff;   // 让「取消」能终止尚未 load 完成的实例，避免遗留 worker
      ff.on('log', e => {
        eng.lastLogs.push(e.message);
        if (eng.lastLogs.length > 60) eng.lastLogs.shift();
      });
      ff.on('progress', e => { if (eng.onProgress) eng.onProgress(e); });
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
      eng.ffmpeg = ff;
      eng.pendingFf = null;
      eng.abort = null;
      return ff;
    })().catch(err => {
      eng.loadPromise = null;
      eng.pendingFf = null;
      eng.abort = null;
      throw err;
    });
  }
  return eng.loadPromise;
}

/* ---------------- 错误诊断（noun：视频 / 音频，用于措辞） ---------------- */
function diagnose(logs, fallbackErr, noun) {
  const s = logs.join('\n');
  if (/does not contain any stream|matches no streams|no audio/i.test(s)) {
    return noun === '音频' ? '未能从该文件中读取到音频数据' : '该视频不包含音频轨';
  }
  if (/Invalid data found|moov atom not found|EBML header parsing failed|Format .* detected only with low score/i.test(s)) {
    return `无法识别的${noun}格式或文件已损坏`;
  }
  if (/decoder .* not found|Decoding requested, but no decoder found/i.test(s)) return `暂不支持该${noun}的编码格式`;
  const tail = logs.filter(l => /error|invalid|fail/i.test(l)).slice(-2).join('；');
  return tail ? '转换失败：' + tail.slice(0, 140) : '转换失败：' + friendlyError(fallbackErr || '未知错误');
}

/* ==========================================================================
 * 子模式面板工厂：视频转音频 / 音频转换 共用同一套加载、转换、取消逻辑
 * cfg: { key, icon, noun, verb, doneTitle, emptyMsg, dedupeName,
 *        ids: {drop,input,body,card,media,srcWrap?,fmt,br,btn,btnCancel,prog,result,outWrap,outAudio} }
 * ========================================================================== */
function setupPane(cfg) {
  const el = {};
  for (const [k, id] of Object.entries(cfg.ids)) el[k] = id ? $('#' + id) : null;
  const st = { file: null, duration: 0, busy: false, previewUrl: null, audioUrl: null };

  function fillCard(file, extraMeta) {
    el.card.innerHTML = `
      <div class="fc-icon">${cfg.icon}</div>
      <div>
        <div class="fc-name"></div>
        <div class="fc-meta"></div>
      </div>`;
    $('.fc-name', el.card).textContent = file.name;
    $('.fc-meta', el.card).textContent = formatSize(file.size) + (extraMeta ? ' · ' + extraMeta : '');
  }

  /* 不按 MIME 强校验：MKV/FLV/WMA/AMR 等在部分系统上拿不到 video|audio/* 类型，交给 ffmpeg 探测 */
  bindDropzone(cfg.ids.drop, cfg.ids.input, file => {
    if (st.busy) { toast('正在转换中，请先取消或等待完成', true); return; }
    st.file = file;
    st.duration = 0;
    el.drop.classList.add('hidden');
    el.body.classList.remove('hidden');
    el.result.classList.add('hidden');
    el.outWrap.classList.add('hidden');
    hideProgress(el.prog);
    fillCard(file, '');
    if (st.previewUrl) URL.revokeObjectURL(st.previewUrl);
    st.previewUrl = URL.createObjectURL(file);
    el.media.classList.remove('hidden');
    if (el.srcWrap) el.srcWrap.classList.remove('hidden');
    el.media.src = st.previewUrl;
  });

  el.media.addEventListener('loadedmetadata', () => {
    if (st.file && isFinite(el.media.duration) && el.media.duration > 0) {
      st.duration = el.media.duration;
      fillCard(st.file, '时长 ' + fmtDuration(st.duration));
    }
  });
  /* 浏览器不能播放（如 AVI/WMA/AMR）不影响转换，仅收起预览 */
  el.media.addEventListener('error', () => {
    if (!st.file) return;
    el.media.classList.add('hidden');
    if (el.srcWrap) el.srcWrap.classList.add('hidden');
    fillCard(st.file, '浏览器无法预览该格式（不影响转换）');
  });
  /* 输出试听同理：Safari 播不了 OGG 等格式时收起播放器并说明，避免误以为转换失败 */
  el.outAudio.addEventListener('error', () => {
    if (!st.audioUrl) return;   // 忽略 reset()/load() 触发的空 src 错误
    el.outWrap.classList.add('hidden');
    toast('当前浏览器无法试听该格式（不影响已下载的文件）');
  });

  st.reset = () => {
    // 转换期间不允许换文件：否则本次输出会张冠李戴（旧结果配新文件名）
    if (st.busy) { toast('正在转换中，请先取消或等待完成', true); return; }
    st.file = null;
    st.duration = 0;
    if (st.previewUrl) { URL.revokeObjectURL(st.previewUrl); st.previewUrl = null; }
    if (st.audioUrl) { URL.revokeObjectURL(st.audioUrl); st.audioUrl = null; }
    el.media.removeAttribute('src'); el.media.load();
    el.outAudio.removeAttribute('src'); el.outAudio.load();
    el.result.classList.add('hidden');
    el.outWrap.classList.add('hidden');
    hideProgress(el.prog);
    el.body.classList.add('hidden');
    el.drop.classList.remove('hidden');
  };

  /* 无损格式不需要码率 */
  el.fmt.addEventListener('change', () => {
    el.br.disabled = !FORMATS[el.fmt.value].lossy;
  });

  el.btn.addEventListener('click', async () => {
    if (!st.file || st.busy) return;
    if (eng.busy) { toast('已有转换任务进行中，请先取消或等待完成', true); return; }
    const fmt = el.fmt.value;
    const spec = FORMATS[fmt];
    if (!spec) return;
    const bitrate = el.br.value;
    // 固定本次转换的输入文件：后续 await 期间即使界面状态变化也不会张冠李戴
    const srcFile = st.file;
    eng.busy = true;
    eng.owner = cfg.key;
    eng.cancelled = false;
    eng.lastLogs = [];       // 必须在引擎加载/写文件之前清，否则早期失败会拿上一次的日志误诊
    eng.progWrap = el.prog;
    st.busy = true;
    el.btn.disabled = true;
    el.btnCancel.classList.remove('hidden');   // 引擎首次下载最耗时，这段也要可取消
    el.result.classList.add('hidden');
    el.outWrap.classList.add('hidden');
    const ext = ((srcFile.name.match(/\.([A-Za-z0-9]{1,6})$/) || [])[1] || 'dat').toLowerCase();
    const inName = 'input.' + ext;
    const outName = 'output.' + fmt;
    try {
      const ff = await getFFmpeg();
      // 取消可能发生在无 fetch 可中断的阶段（如读本地缓存），这里补一道闸
      if (eng.cancelled) throw new Error('已取消');
      setProgress(el.prog, 0, `正在读取${cfg.noun}文件…`);
      await ff.writeFile(inName, new Uint8Array(await srcFile.arrayBuffer()));
      let lastFrac = 0;
      eng.onProgress = e => {
        const t = (e.time || 0) / 1e6;
        let frac = e.progress;
        // 部分容器给不出可靠的总时长比例，退回用媒体元数据时长估算
        if (!isFinite(frac) || frac <= 0 || frac > 1.5) frac = st.duration > 0 ? t / st.duration : NaN;
        const timeTxt = t > 0
          ? '已处理 ' + fmtDuration(st.duration ? Math.min(t, st.duration) : t) + (st.duration ? ' / ' + fmtDuration(st.duration) : '')
          : '';
        if (isFinite(frac)) {
          lastFrac = Math.max(0, Math.min(1, frac));
          setProgress(el.prog, lastFrac, `正在${cfg.verb}… ${Math.round(lastFrac * 100)}%` + (timeTxt ? `（${timeTxt}）` : ''));
        } else {
          // 比例与时长都不可靠：只报已处理时长，不谎报百分比
          setProgress(el.prog, lastFrac, `正在${cfg.verb}…` + (timeTxt ? `（${timeTxt}）` : ''));
        }
      };
      setProgress(el.prog, 0, `正在${cfg.verb}…`);
      // -vn 同时会剔除音频文件里的内嵌封面图（attached_pic 是一路视频流）
      const ret = await ff.exec(['-i', inName, '-vn', '-sn', '-dn', ...spec.args(bitrate), '-y', outName]);
      if (ret !== 0) throw new Error(diagnose(eng.lastLogs, null, cfg.noun));
      const data = await ff.readFile(outName);
      if (!data || data.length < 128) throw new Error(cfg.emptyMsg);
      const blob = new Blob([data], { type: spec.mime });
      const base = srcFile.name.replace(/\.[^.]{1,6}$/, '') || 'audio';
      let dlName = base + '.' + fmt;
      // 同格式转码（如 MP3 压码率）时避免与原文件重名
      if (cfg.dedupeName && dlName.toLowerCase() === srcFile.name.toLowerCase()) dlName = base + '-转换.' + fmt;
      hideProgress(el.prog);
      showResult(el.result, cfg.doneTitle,
        `${fmt.toUpperCase()} · ${formatSize(blob.size)}${spec.lossy ? ' · ' + (spec.vbr ? '约 ' : '') + bitrate + ' kbps' : ' · 无损'}，已开始下载，可在下方试听`,
        blob, dlName);
      if (st.audioUrl) URL.revokeObjectURL(st.audioUrl);
      st.audioUrl = URL.createObjectURL(blob);
      el.outAudio.src = st.audioUrl;
      el.outWrap.classList.remove('hidden');
    } catch (err) {
      hideProgress(el.prog);
      if (eng.cancelled) {
        toast('已取消转换');
      } else {
        console.error(err);
        toast(diagnose(eng.lastLogs, err, cfg.noun), true);
      }
    } finally {
      eng.onProgress = null;
      if (eng.ffmpeg) {
        try { await eng.ffmpeg.deleteFile(inName); } catch (_) { /* 忽略 */ }
        try { await eng.ffmpeg.deleteFile(outName); } catch (_) { /* 忽略 */ }
      }
      eng.busy = false;
      eng.owner = null;
      eng.cancelled = false;
      st.busy = false;
      el.btn.disabled = false;
      el.btnCancel.classList.add('hidden');
    }
  });

  /* 取消：中断引擎下载 / 终止 worker，引擎作废（下次转换会重新初始化，wasm 走本地缓存） */
  el.btnCancel.addEventListener('click', () => {
    if (!st.busy || eng.owner !== cfg.key) return;
    eng.cancelled = true;
    if (eng.abort) { try { eng.abort.abort(); } catch (_) { /* 忽略 */ } }
    const ff = eng.ffmpeg || eng.pendingFf;
    if (ff) { try { ff.terminate(); } catch (_) { /* 忽略 */ } }
    eng.ffmpeg = null;
    eng.pendingFf = null;
    eng.loadPromise = null;
  });

  st.pauseMedia = () => { el.media.pause(); el.outAudio.pause(); };
  return st;
}

/* ---------------- 两个子模式实例 ---------------- */
const vd = setupPane({
  key: 'video', icon: '🎬', noun: '视频', verb: '提取并转换音频',
  doneTitle: '音频提取完成', emptyMsg: '该视频不包含音频轨或输出为空', dedupeName: false,
  ids: {
    drop: 'videoDrop', input: 'videoInput', body: 'videoBody', card: 'videoCard',
    media: 'videoPreview', srcWrap: null, fmt: 'audioFormat', br: 'audioBitrate',
    btn: 'btnV2A', btnCancel: 'btnV2ACancel', prog: 'videoProgress', result: 'videoResult',
    outWrap: 'audioPreviewWrap', outAudio: 'audioPreview',
  },
});
App.video = vd;

const ad = setupPane({
  key: 'audio', icon: '🎵', noun: '音频', verb: '转换音频',
  doneTitle: '音频转换完成', emptyMsg: '未能从该文件中读取到音频数据', dedupeName: true,
  ids: {
    drop: 'audioDrop', input: 'audioInput', body: 'audioBody', card: 'audioCard',
    media: 'audioSrcPreview', srcWrap: 'audioSrcWrap', fmt: 'audioFormatA', br: 'audioBitrateA',
    btn: 'btnA2A', btnCancel: 'btnA2ACancel', prog: 'audioProgress', result: 'audioResult',
    outWrap: 'audioOutWrap', outAudio: 'audioOutPreview',
  },
});
App.audio = ad;

/* ---------------- 子模式切换（视频转音频 / 音频转换） ---------------- */
$$('.av-tab').forEach(b => b.addEventListener('click', () => {
  $$('.av-tab').forEach(x => x.classList.toggle('active', x === b));
  $('#avV2aPane').classList.toggle('hidden', b.dataset.avmode !== 'v2a');
  $('#avA2aPane').classList.toggle('hidden', b.dataset.avmode !== 'a2a');
  // 切走的一侧暂停播放
  if (b.dataset.avmode !== 'v2a') vd.pauseMedia();
  if (b.dataset.avmode !== 'a2a') ad.pauseMedia();
}));

/* 转换进行中关闭/刷新页面前提醒（误触拖放导航的第二道防线） */
window.addEventListener('beforeunload', e => {
  if (eng.busy) { e.preventDefault(); e.returnValue = ''; }
});

/* 切换到其他顶层工具时暂停播放：否则看不见的视频/音频仍在出声 */
$$('.tab').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.tab !== 'video') { vd.pauseMedia(); ad.pauseMedia(); }
}));

})();
