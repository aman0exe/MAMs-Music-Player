
const DB_NAME = 'music-player-db';
const STORE_NAME = 'handles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const r = store.put(value, key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const r = store.get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDelete(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const r = store.delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

const folderBtn = document.getElementById('folder');
const playBtnImg = document.getElementById('play');
const pauseBtnImg = document.getElementById('pause');
const nextBtnImg = document.getElementById('next');
const prevBtnImg = document.getElementById('prev');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const albumCoverEl = document.getElementById('albumCover');

let dirHandle = null;
const audio = new Audio();
let fileHandles = [];         
let shuffledOrder = [];       
let playedOrderPositions = []; 
let currentAudioURL = null;
let currentArtURL = null;

function clearMetaUI() {
  titleEl.textContent = '';
  artistEl.textContent = '';
  albumCoverEl.style.backgroundImage = '';
}
function setMetaUI({ title, artist, artURL }) {
  titleEl.textContent = title || '';
  artistEl.textContent = artist || '';
  if (currentArtURL && currentArtURL !== artURL) {
    try { URL.revokeObjectURL(currentArtURL); } catch (e) {}
    currentArtURL = null;
  }
  if (artURL) {
    currentArtURL = artURL;
    albumCoverEl.style.backgroundImage = `url('${artURL}')`;
    albumCoverEl.style.backgroundSize = 'cover';
    albumCoverEl.style.backgroundPosition = 'center';
  } else {
    albumCoverEl.style.backgroundImage = '';
  }
}
function revokeAudioURL() {
  if (currentAudioURL) {
    try { URL.revokeObjectURL(currentAudioURL); } catch (e) {}
    currentAudioURL = null;
  }
}

function createShuffleOrder(n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function syncSafeToInt(b0, b1, b2, b3) {
  return ((b0 & 0x7f) << 21) | ((b1 & 0x7f) << 14) | ((b2 & 0x7f) << 7) | (b3 & 0x7f);
}
function readUint32BE(view, offset) {
  return view.getUint32(offset, false);
}
function decodeText(bytes, encodingByte) {
  try {
    if (encodingByte === 0) return new TextDecoder('iso-8859-1').decode(bytes).replace(/\0+$/,'');
    if (encodingByte === 1) return new TextDecoder('utf-16').decode(bytes).replace(/\0+$/,'');
    if (encodingByte === 2) return new TextDecoder('utf-16be').decode(bytes).replace(/\0+$/,'');
    return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/,'');
  } catch (e) {
    try { return new TextDecoder().decode(bytes).replace(/\0+$/,''); } catch (ee) { return ''; }
  }
}
function findTerminator(bytes, start, encodingByte) {
  if (encodingByte === 1 || encodingByte === 2) {
    for (let i = start; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0x00 && bytes[i + 1] === 0x00) return i;
    }
    return bytes.length;
  } else {
    for (let i = start; i < bytes.length; i++) if (bytes[i] === 0x00) return i;
    return bytes.length;
  }
}
async function parseID3(file) {
  const result = { title: '', artist: '', artURL: null };
  try {
    const headerSliceSize = Math.min(1572864, file.size);
    const headerBuf = await file.slice(0, headerSliceSize).arrayBuffer();
    const header = new Uint8Array(headerBuf);
    const view = new DataView(headerBuf);
    if (header.length >= 10 && String.fromCharCode(header[0], header[1], header[2]) === 'ID3') {
      const ver = header[3];
      const tagSize = syncSafeToInt(header[6], header[7], header[8], header[9]);
      const totalTagBytes = Math.min(tagSize + 10, header.length);
      let offset = 10;
      while (offset + 10 <= totalTagBytes) {
        const frameId = String.fromCharCode(header[offset], header[offset + 1], header[offset + 2], header[offset + 3]);
        if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
        let frameSize = 0;
        if (ver === 4) {
          frameSize = syncSafeToInt(header[offset + 4], header[offset + 5], header[offset + 6], header[offset + 7]);
        } else {
          frameSize = readUint32BE(view, offset + 4);
        }
        const frameHeaderSize = 10;
        const frameDataStart = offset + frameHeaderSize;
        const frameDataEnd = frameDataStart + frameSize;
        if (frameDataEnd > totalTagBytes) break;
        if (frameId === 'TIT2' || frameId === 'TPE1') {
          if (frameSize <= 0) { offset = frameDataEnd; continue; }
          const encoding = header[frameDataStart];
          const textBytes = header.slice(frameDataStart + 1, frameDataEnd);
          const text = decodeText(textBytes, encoding).trim();
          if (frameId === 'TIT2' && !result.title) result.title = text;
          if (frameId === 'TPE1' && !result.artist) result.artist = text;
        } else if (frameId === 'APIC') {
          if (frameSize > 0 && !result.artURL) {
            const encoding = header[frameDataStart];
            let p = frameDataStart + 1;
            // mime string
            let mimeEnd = p;
            while (mimeEnd < frameDataEnd && header[mimeEnd] !== 0x00) mimeEnd++;
            const mime = new TextDecoder('ascii').decode(header.slice(p, mimeEnd));
            p = mimeEnd + 1;
            if (p >= frameDataEnd) { offset = frameDataEnd; continue; }
            p += 1; 
            const descEnd = findTerminator(header, p, encoding);
            p = descEnd;
            if (encoding === 1 || encoding === 2) p += 2; else p += 1;
            if (p < frameDataEnd) {
              const imgBytes = header.slice(p, frameDataEnd);
              try {
                const blob = new Blob([imgBytes], { type: mime || 'image/jpeg' });
                result.artURL = URL.createObjectURL(blob);
              } catch (e) { /* ignore */ }
            }
          }
        }
        offset = frameDataEnd;
      }
    }
    if (!result.title && !result.artist && file.size >= 128) {
      try {
        const tail = await file.slice(file.size - 128, file.size).arrayBuffer();
        const tailBytes = new Uint8Array(tail);
        if (String.fromCharCode(...tailBytes.slice(0, 3)) === 'TAG') {
          const rawTitle = new TextDecoder('iso-8859-1').decode(tailBytes.slice(3, 33)).replace(/\0+$/,'').trim();
          const rawArtist = new TextDecoder('iso-8859-1').decode(tailBytes.slice(33, 63)).replace(/\0+$/,'').trim();
          if (rawTitle && !result.title) result.title = rawTitle;
          if (rawArtist && !result.artist) result.artist = rawArtist;
        }
      } catch (e) { /* ignore */ }
    }
    if (!result.title) result.title = file.name.replace(/\.mp3$/i, '');
    if (!result.artist) result.artist = '';
  } catch (e) {
    console.error('Ошибка чтения ID3:', e);
    result.title = file.name.replace(/\.mp3$/i, '');
    result.artist = '';
    result.artURL = null;
  }
  return result;
}

async function buildFileList(handle) {
  const out = [];
  try {
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.mp3')) {
        out.push(entry);
      }
    }
  } catch (e) {
    throw e;
  }
  return out;
}

async function preparePlaylist() {
  if (!dirHandle) return false;
  try {
    fileHandles = await buildFileList(dirHandle);
  } catch (e) {
    console.error('Ошибка при перечислении файлов:', e);
    fileHandles = [];
  }
  if (!fileHandles.length) {
    clearMetaUI();
    shuffledOrder = [];
    playedOrderPositions = [];
    return false;
  }
  shuffledOrder = createShuffleOrder(fileHandles.length);
  playedOrderPositions = [];
  return true;
}

async function playAtOrderPos(orderPos, addToHistory = true) {
  if (!shuffledOrder.length || orderPos < 0 || orderPos >= shuffledOrder.length) return;
  const fileIndex = shuffledOrder[orderPos];
  const handle = fileHandles[fileIndex];
  try {
    const file = await handle.getFile();
    revokeAudioURL();
    currentAudioURL = URL.createObjectURL(file);
    audio.src = currentAudioURL;
    await audio.play().catch(() => {});
    const meta = await parseID3(file);
    setMetaUI({ title: meta.title, artist: meta.artist, artURL: meta.artURL });
    if (addToHistory) playedOrderPositions.push(orderPos);
  } catch (e) {
    console.error('Ошибка воспроизведения файла:', e);
  }
}

async function playNext() {
  if (!shuffledOrder.length) return;
  const playedSet = new Set(playedOrderPositions);
  let nextPos = null;
  for (let i = 0; i < shuffledOrder.length; i++) {
    if (!playedSet.has(i)) { nextPos = i; break; }
  }
  if (nextPos === null) {
    audio.pause();
    return;
  }
  await playAtOrderPos(nextPos, true);
}
async function playPrev() {
  if (playedOrderPositions.length <= 1) return;
  playedOrderPositions.pop(); 
  const prev = playedOrderPositions[playedOrderPositions.length - 1];
  await playAtOrderPos(prev, false);
}

folderBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker();
    if (!handle) return;
    dirHandle = handle;
    try {
      await idbPut('music-dir', dirHandle);
    } catch (e) {
      console.error('Ошибка сохранения дескриптора папки:', e);
    }
    const ok = await preparePlaylist();
    if (ok) await playNext();
  } catch (e) {
    console.error('Ошибка выбора папки:', e);
  }
});
playBtnImg.addEventListener('click', async () => { try { await audio.play(); } catch (e) { console.error('Play error:', e); } });
pauseBtnImg.addEventListener('click', () => audio.pause());
nextBtnImg.addEventListener('click', () => playNext());
prevBtnImg.addEventListener('click', () => playPrev());

audio.addEventListener('ended', () => playNext());
audio.addEventListener('error', (e) => console.error('Audio error:', e));

async function tryRestoreDirectory() {
  try {
    const stored = await idbGet('music-dir');
    if (!stored) return;
    dirHandle = stored;
    try {
      if (typeof dirHandle.queryPermission === 'function') {
        let p = await dirHandle.queryPermission({ mode: 'read' });
        if (p === 'prompt' && typeof dirHandle.requestPermission === 'function') {
          p = await dirHandle.requestPermission({ mode: 'read' });
        }
        if (p !== 'granted') {
          await idbDelete('music-dir');
          dirHandle = null;
          return;
        }
      }
      const ok = await preparePlaylist();
      if (!ok) {
        try { await idbDelete('music-dir'); } catch (e) {}
        dirHandle = null;
      }
    } catch (e) {
      try { await idbDelete('music-dir'); } catch (err) {}
      dirHandle = null;
    }
  } catch (e) {
    console.error('Ошибка восстановления папки:', e);
  }
}

(async function init() {
  clearMetaUI();
  await tryRestoreDirectory();
})();

