const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ============================================================
// APP VERSION — zvednout při každé úpravě
// ============================================================
const APP_VERSION = '6.82';

// ============================================================
// DB LAYER — tenký vlastní wrapper nad nativním IndexedDB
// ============================================================
const DB_NAME = 'udrzba-db';
const DB_VERSION = 3;

function getDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains('machines')) {
        const store = idb.createObjectStore('machines', { keyPath: 'id' });
        store.createIndex('name', 'name');
      }
      if (!idb.objectStoreNames.contains('records')) {
        const store = idb.createObjectStore('records', { keyPath: 'id' });
        store.createIndex('date', 'date');
        store.createIndex('machineId', 'machineId');
        store.createIndex('startTime', 'startTime');
      }
      if (!idb.objectStoreNames.contains('activeSession')) {
        idb.createObjectStore('activeSession', { keyPath: 'id' });
      }
      if (!idb.objectStoreNames.contains('settings')) {
        idb.createObjectStore('settings', { keyPath: 'id' });
      }
      if (!idb.objectStoreNames.contains('categories')) {
        idb.createObjectStore('categories', { keyPath: 'id' });
      }
      // Lokální cache stažených fotek (Firebase Storage odkaz → data-URL),
      // ať appka nestahuje tu samou fotku znovu při každé drobné úpravě
      // záznamu, do kterého patří. Viz cloudSync/resolvePhotos.
      if (!idb.objectStoreNames.contains('photoCache')) {
        idb.createObjectStore('photoCache', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const idb = req.result;
      const wrapper = {
        raw: idb,
        getAll(storeName) {
          return new Promise((res, rej) => {
            const tx = idb.transaction(storeName, 'readonly');
            const r = tx.objectStore(storeName).getAll();
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
        },
        get(storeName, key) {
          return new Promise((res, rej) => {
            const tx = idb.transaction(storeName, 'readonly');
            const r = tx.objectStore(storeName).get(key);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
        },
        // put/delete navíc (mimo samotný zápis do IndexedDB) zavolají
        // cloudSync.notify — ten změnu pošle do Firestore, pokud je appka
        // přihlášená a jde o synchronizované úložiště. cloudSync svoje
        // vlastní zápisy (přijaté OD Firestore) dělá přes rawPut/rawDelete,
        // takže se tímhle hookem nikdy neprojdou zpátky — žádné echo.
        put(storeName, value) {
          return new Promise((res, rej) => {
            const tx = idb.transaction(storeName, 'readwrite');
            const r = tx.objectStore(storeName).put(value);
            r.onsuccess = () => { res(r.result); cloudSync.notify(storeName, 'put', value); };
            r.onerror = () => rej(r.error);
          });
        },
        delete(storeName, key) {
          return new Promise((res, rej) => {
            const tx = idb.transaction(storeName, 'readwrite');
            const r = tx.objectStore(storeName).delete(key);
            r.onsuccess = () => { res(r.result); cloudSync.notify(storeName, 'delete', key); };
            r.onerror = () => rej(r.error);
          });
        },
      };
      resolve(wrapper);
    };
    req.onerror = () => reject(req.error);
  });
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ============================================================
// CLOUD SYNCHRONIZACE — Firebase (volitelná)
// ------------------------------------------------------------
// Appka zůstává offline-first: UI vždy čte a píše do lokální IndexedDB.
// Po přihlášení appka navíc drží živé zrcadlo dat (stroje, záznamy,
// kategorie, běžící časomíra) ve Firestore — každá lokální změna se
// hned (na pozadí) pošle nahoru, každá vzdálená změna z jiného zařízení
// přijde přes Firestore realtime listener a rovnou se zapíše do
// IndexedDB. Firebase Auth (na rozdíl od dřívějšího Drive OAuth) si
// drží přihlášení i po refreshi stránky a funguje bez oken i v Brave —
// obnovuje token přímým voláním na Google, ne skrytým iframem.
// Fotky se do Firestore neukládají (limit 1 MB/dokument) — jdou
// zkomprimované do Firebase Storage a v dokumentu zůstává jen odkaz
// ("gs:cesta"); appka ho při příjmu sama převede zpět na data-URL a do
// lokální cache, takže zbytek appky (zobrazení, export, sdílení…)
// o Storage vůbec neví a nemusel se kvůli tomu měnit.
// ============================================================
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDJ-zeAXuIuaAtkmfZoybV6bqwQVc_qa10',
  authDomain: 'denik-udrzbare.firebaseapp.com',
  projectId: 'denik-udrzbare',
  storageBucket: 'denik-udrzbare.firebasestorage.app',
  messagingSenderId: '74515572136',
  appId: '1:74515572136:web:c4e342cc3c0d09f921a99d',
};
// activeSession = běžící časomíra (jeden záznam s id 'active'). Synchronizuje se
// taky, ať se spuštěný/zastavený timer projeví i na druhém zařízení.
const SYNC_STORES = ['machines', 'records', 'categories', 'activeSession'];
// Fotky jdou zkomprimované do Firebase Storage (soubor .jpg), v záznamu /
// stroji / session zůstává jen odkaz "gs:cesta". Storage má oproti Firestoru
// levnější úložiště a hlavně serverové lifecycle pravidlo — fotky starší
// 1 roku se mažou samy, i když appku nikdo neotevře. Stahování z prohlížeče
// vyžaduje nastavené CORS na bucketu (jednorázově, přes gsutil/Cloud Shell).
const PHOTO_REF_PREFIX = 'gs:';
const PHOTO_MAX_DIM = 1600;       // px, delší strana fotky po zmenšení
const PHOTO_JPEG_QUALITY = 0.72;  // vede na cca 0,3–0,7 MB/fotku

let fbApp = null, fbAuthInst = null, fbDbInst = null, fbStorageInst = null;
// Vrací { auth, db, storage } nebo null, když se Firebase SDK nepodařilo
// načíst (výpadek CDN). Appka pak jede dál čistě offline — cloud je prostě
// nedostupný, ale nic se nerozbije.
function ensureFirebase() {
  if (typeof firebase === 'undefined') return null;
  if (!firebase.initializeApp) return null;
  if (!fbApp) {
    try {
      fbApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
      fbAuthInst = firebase.auth();
      fbDbInst = firebase.firestore();
      // Appka posílá i pole, která nejsou vždy vyplněná (undefined) — bez
      // tohohle by na ně Firestore SDK spadl chybou místo aby je přeskočil.
      fbDbInst.settings({ ignoreUndefinedProperties: true });
    } catch { fbApp = null; return null; }
  }
  if (!fbStorageInst) {
    try {
      if (typeof firebase.storage !== 'function') console.warn('[sync] firebase-storage SDK se nenačetlo (blokátor / CDN) — fotky se nesynchronizují');
      else fbStorageInst = firebase.storage();
    } catch (e) { console.warn('[sync] firebase.storage() selhalo:', e?.message || e); }
  }
  return { auth: fbAuthInst, db: fbDbInst, storage: fbStorageInst };
}

// Zápis přímo do IndexedDB, MIMO wrapper z getDB() — cloudSync je používá
// pro vlastní zápisy přijaté OD Firestore, ať se accidentally nepošlou
// hookem v getDB() zase zpátky nahoru (nekonečné echo mezi zařízeními).
function rawPut(db, store, value) {
  return new Promise((res, rej) => {
    const r = db.raw.transaction(store, 'readwrite').objectStore(store).put(value);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function rawDelete(db, store, key) {
  return new Promise((res, rej) => {
    const r = db.raw.transaction(store, 'readwrite').objectStore(store).delete(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// ---- Fotky: komprese na klientovi, upload/stažení do Storage, lokální cache ----

function compressPhotoToBlob(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, PHOTO_MAX_DIM / Math.max(width, height));
      width = Math.round(width * scale); height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Komprese fotky selhala.')), 'image/jpeg', PHOTO_JPEG_QUALITY);
    };
    img.onerror = () => reject(new Error('Fotku se nepodařilo načíst.'));
    img.src = dataUrl;
  });
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h.toString(36);
}
async function getCachedPhoto(db, ref) {
  const row = await db.get('photoCache', ref).catch(() => null);
  return row ? row.dataUrl : null;
}
// Cache OBOUSMĚRNĚ: gs:cesta → data-URL (pro zobrazení) i hash(data-URL) →
// gs:cesta (aby se ta samá fotka podruhé nenahrávala, když se záznam jen
// drobně upraví — lokálně jsou fotky vždy data-URL).
async function setCachedPhoto(db, ref, dataUrl) {
  await rawPut(db, 'photoCache', { id: ref, dataUrl }).catch(() => {});
  await rawPut(db, 'photoCache', { id: 'h:' + hashStr(dataUrl), ref }).catch(() => {});
}

// Nahraje fotku (data-URL) do Storage a vrátí odkaz "gs:cesta" pro uložení
// do dokumentu. Fotku, která už je odkazem (přišla z cloudu) nebo kterou
// appka pozná podle hashe jako už jednou nahranou, nechá být.
async function uploadPhotoIfNeeded(db, ownerUid, ownerId, photo) {
  if (typeof photo !== 'string' || !photo.startsWith('data:')) return photo;
  const known = await db.get('photoCache', 'h:' + hashStr(photo)).catch(() => null);
  if (known?.ref) return known.ref;
  const fb = ensureFirebase();
  if (!fb || !fb.storage) { console.warn('[sync] fotku nelze nahrát — Storage není k dispozici (fb:', !!fb, 'storage:', !!(fb && fb.storage), ')'); return photo; }
  const blob = await compressPhotoToBlob(photo);
  const path = `users/${ownerUid}/photos/${ownerId}/${uid()}.jpg`;
  try {
    await fb.storage.ref(path).put(blob, { contentType: 'image/jpeg' });
  } catch (e) {
    console.warn('[sync] nahrání fotky do Storage selhalo:', path, e?.code || e?.message || e);
    throw e;
  }
  console.log('[sync] fotka nahrána do Storage:', path);
  const ref = PHOTO_REF_PREFIX + path;
  await setCachedPhoto(db, ref, await blobToDataUrl(blob));
  await setCachedPhoto(db, ref, photo); // i originál (před kompresí) ať se podruhé nenahraje
  return ref;
}

// Převede pole fotek přijatého dokumentu z odkazů zpět na data-URL (stáhne
// jen ty, co appka ještě nemá v cache) — dál appka pracuje se záznamem
// úplně stejně, jako když byly fotky vždycky přímo v něm. Fotka smazaná
// lifecycle pravidlem (>1 rok) se prostě přeskočí.
async function resolvePhotos(db, photos) {
  if (!Array.isArray(photos) || photos.length === 0) return photos || [];
  const fb = ensureFirebase();
  const out = [];
  for (const p of photos) {
    if (typeof p !== 'string' || !p.startsWith(PHOTO_REF_PREFIX)) {
      if (typeof p === 'string' && p.startsWith('data:')) out.push(p); // stará data přímo v záznamu
      continue;
    }
    const cached = await getCachedPhoto(db, p);
    if (cached) { out.push(cached); continue; }
    if (!fb || !fb.storage) continue;
    try {
      const url = await fb.storage.ref(p.slice(PHOTO_REF_PREFIX.length)).getDownloadURL();
      const blob = await fetch(url).then(r => r.blob());
      const dataUrl = await blobToDataUrl(blob);
      await setCachedPhoto(db, p, dataUrl);
      out.push(dataUrl);
    } catch (e) {
      console.warn('[sync] fotku se nepodařilo stáhnout ze Storage:', p, e?.message || e);
      // fotka nedostupná (vypršela / offline / CORS) — v appce prostě chybí
    }
  }
  return out;
}

// ---- Přihlášení + realtime synchronizace ----

const cloudSync = {
  uid: null,
  db: null,
  listeners: [],

  async signIn() {
    const fb = ensureFirebase();
    if (!fb) throw new Error('Cloud služba se nenačetla — zkus to za chvíli znovu.');
    await fb.auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
  },
  async signOut() {
    this.stopListening();
    const fb = ensureFirebase();
    if (fb) await fb.auth.signOut();
  },

  // Napojí realtime poslech všech synchronizovaných úložišť. Každá
  // vzdálená změna (z tohoto i jiného zařízení) se zapíše do IndexedDB
  // přes rawPut/rawDelete a appka o tom dostane echo přes onRemoteChange.
  startListening(db, ownerUid, onRemoteChange) {
    this.stopListening();
    const fb = ensureFirebase();
    if (!fb) return;
    this.db = db;
    this.uid = ownerUid;
    const fs = fb.db;
    for (const store of SYNC_STORES) {
      const unsub = fs.collection('users').doc(ownerUid).collection(store).onSnapshot(async (snap) => {
        let changed = false;
        const chs = snap.docChanges();
        if (chs.length) console.log('[sync] přišlo z cloudu:', store, chs.map(c => c.type + ':' + c.doc.id).join(', '));
        for (const change of chs) {
          const id = change.doc.id;
          if (change.type === 'removed') {
            await rawDelete(db, store, id);
          } else {
            const record = { ...change.doc.data(), id };
            if (Array.isArray(record.photos)) console.log('[sync] dokument z cloudu má fotek:', store, id, record.photos.length, JSON.stringify(record.photos).slice(0, 120));
            if (record.photos) {
              const resolved = await resolvePhotos(db, record.photos);
              // Bezpečnostní pojistka: lokální data: fotku, která se ještě
              // NIKDY nenahrála (v cache pro její hash NENÍ žádný gs: odkaz),
              // necháme být — jinak by výpadek uploadu smazal fotku i lokálně.
              // Fotku, která odkaz MÁ (už se jednou nahrála) a v příchozím
              // záznamu chybí, ale bereme jako záměrně smazanou → NEvracíme.
              const local = await db.get(store, id).catch(() => null);
              for (const lp of (local?.photos || [])) {
                if (typeof lp !== 'string' || !lp.startsWith('data:')) continue;
                const h = await db.get('photoCache', 'h:' + hashStr(lp)).catch(() => null);
                if (!h?.ref) resolved.push(lp);
              }
              record.photos = resolved;
            }
            await rawPut(db, store, record);
          }
          changed = true;
        }
        if (changed) onRemoteChange(store);
      }, () => { /* výpadek spojení — Firestore SDK se sám znovu připojí a listener obnoví */ });
      this.listeners.push(unsub);
    }
  },
  stopListening() {
    this.listeners.forEach(u => { try { u(); } catch {} });
    this.listeners = [];
    this.uid = null;
  },

  // Zavolá getDB() wrapper po každém put/delete — pošle změnu do Firestore
  // na pozadí (appka na to nečeká, zůstává okamžitá i offline).
  notify(store, type, value) {
    if (!this.uid || !SYNC_STORES.includes(store)) return;
    this.pushChange(store, type, value).catch(() => {});
  },
  _retryTimers: {},
  async pushChange(store, type, value) {
    const fb = ensureFirebase();
    if (!fb) return;
    const fs = fb.db;
    const id = type === 'delete' ? value : value.id;
    const ref = fs.collection('users').doc(this.uid).collection(store).doc(String(id));
    if (type === 'delete') { await ref.delete(); return; }
    const payload = { ...value };
    delete payload.id;
    if (Array.isArray(payload.photos)) {
      // Fotky nahráváme po jedné do Storage. Do Firestoru dáme jen odkazy na
      // ty úspěšně nahrané — text a hotové fotky se synchronizují hned, i když
      // se jedna fotka zrovna nenahrála. Nenahranou fotku appka nechává
      // lokálně (echo z Firestoru ji nesmaže, viz merge v startListening)
      // a za 5 s zkusí celý push znovu.
      const refs = [];
      let unresolved = false;
      for (const p of payload.photos) {
        try {
          const r = await uploadPhotoIfNeeded(this.db, this.uid, String(id), p);
          if (typeof r === 'string' && r.startsWith(PHOTO_REF_PREFIX)) refs.push(r);
          else unresolved = true;
        } catch (e) { unresolved = true; console.warn('[sync] fotka se nenahrála, push odložen:', store, id, e?.code || e?.message || e); }
      }
      payload.photos = refs;
      console.log('[sync] posílám do cloudu:', store, id, 'fotek:', refs.length, unresolved ? '(něco se nenahrálo, retry za 5s)' : '');
      if (unresolved) {
        clearTimeout(this._retryTimers[store + id]);
        this._retryTimers[store + id] = setTimeout(async () => {
          const cur = await this.db.get(store, id).catch(() => null);
          if (cur) this.pushChange(store, 'put', cur).catch(() => {});
        }, 5000);
      }
    }
    try {
      await ref.set(payload);
    } catch (e) {
      console.warn('[sync] zápis do cloudu selhal:', store, id, e?.code || e?.message || e);
      // appka je offline-first — Firestore SDK zápis při výpadku sítě stejně
      // zafrontuje a odešle sám; u jiných chyb (pravidla) to aspoň uvidíme.
    }
  },

  // Natáhne aktuální stav z Firestore zpátky do IndexedDB — používá se po
  // "Resetovat vše", kdy se lokální kopie smaže, ale appka se má hned
  // vrátit do hry se sdíleným stavem, ne čekat na další vzdálenou změnu.
  async pullAllFromCloud(db) {
    const fb = ensureFirebase();
    if (!this.uid || !fb) return;
    const fs = fb.db;
    for (const store of SYNC_STORES) {
      const snap = await fs.collection('users').doc(this.uid).collection(store).get();
      for (const doc of snap.docs) {
        const record = { ...doc.data(), id: doc.id };
        if (record.photos) record.photos = await resolvePhotos(db, record.photos);
        await rawPut(db, store, record);
      }
    }
  },

  async reconnect() {
    try { const fb = ensureFirebase(); if (fb) await fb.db.enableNetwork(); } catch {}
  },
};

function pad(n) { return n.toString().padStart(2, '0'); }

function fmtDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

// Doba trvání na minuty (bez sekund) — pro historii, detail, statistiky.
// Živý běžící časovač na hlavní obrazovce zůstává na fmtDuration (se sekundami).
function fmtDurationMin(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${pad(m)}`;
}

function fmtDurationShort(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

// Relativní čas poslední synchronizace pro Nastavení ("před 3 min", "dnes 14:20"…).
function fmtSyncTime(ts) {
  if (!ts) return 'nikdy';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'právě teď';
  if (diff < 3600000) return `před ${Math.round(diff / 60000)} min`;
  const d = new Date(ts);
  const today = fmtDateKey(Date.now());
  if (fmtDateKey(ts) === today) return `dnes ${d.getHours()}:${pad(d.getMinutes())}`;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${d.getHours()}:${pad(d.getMinutes())}`;
}

// Rozdělí label typu opravy na "prefix" (CM/EM, appka ho zobrazí jako malý
// barevný štítek nahoře karty) a "podtyp" (Práce/Oprava/S prostojem/Bez
// prostoje, čitelný text pod štítkem) — appka tak na úzké kartě nezalamuje
// jeden dlouhý řetězec, ale rovnou dvě sémanticky oddělené věci.
function splitTypeLabel(label) {
  if (label === 'CM') return { prefix: 'CM', subtype: 'Práce' };
  if (label === 'CM Oprava') return { prefix: 'CM', subtype: 'Oprava' };
  if (label === 'EM s prostojem') return { prefix: 'EM', subtype: 'S prostojem' };
  if (label === 'EM bez prostoje') return { prefix: 'EM', subtype: 'Bez prostoje' };
  return { prefix: label, subtype: '' };
}

// Zaokrouhlí timestamp na nejbližších 5 minut (matematicky — .5 nahoru),
// používá se všude, kde appka předvyplňuje aktuální čas (nová oprava,
// STOP timeru), ať jsou časy konzistentně "hezké" bez sekundové přesnosti.
function roundToNearest5Min(ts) {
  const d = new Date(ts);
  const minutes = d.getMinutes();
  const rounded = Math.round(minutes / 5) * 5;
  d.setMinutes(rounded, 0, 0);
  return d.getTime();
}

function fmtDateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
  const today = fmtDateKey(Date.now());
  const yesterday = fmtDateKey(Date.now() - 86400000);
  if (dateKey === today) return 'Dnes';
  if (dateKey === yesterday) return 'Včera';
  return `${pad(d)}.${pad(m)}.${y} — ${days[date.getDay()]}`;
}

const MONTH_NAMES = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

function fmtMonthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function fmtMonthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function fmtDayShort(dateKey) {
  const [, , d] = dateKey.split('-').map(Number);
  return d;
}

// ============================================================
// ICONS
// ============================================================
function Logo({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="logoBg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1E242A" />
          <stop offset="1" stopColor="#14181C" />
        </linearGradient>
        <linearGradient id="logoAccent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#818CF8" />
          <stop offset="1" stopColor="#6366F1" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="104" fill="url(#logoBg)" />
      <g transform="translate(256,276)">
        <path d="M -140 -80 L -10 -95 L -10 95 L -140 80 Z" fill="#F5F6F8" opacity="0.96" />
        <path d="M 140 -80 L 10 -95 L 10 95 L 140 80 Z" fill="#F5F6F8" opacity="0.96" />
        <path d="M -10 -95 L 10 -95 L 10 95 L -10 95 Z" fill="#D8DAE0" />
        <line x1="-120" y1="-40" x2="-30" y2="-46" stroke="#B7BBC4" strokeWidth="6" strokeLinecap="round" />
        <line x1="-120" y1="-10" x2="-30" y2="-14" stroke="#B7BBC4" strokeWidth="6" strokeLinecap="round" />
        <line x1="-120" y1="20" x2="-30" y2="18" stroke="#B7BBC4" strokeWidth="6" strokeLinecap="round" />
        <line x1="30" y1="-46" x2="120" y2="-40" stroke="#B7BBC4" strokeWidth="6" strokeLinecap="round" />
        <line x1="30" y1="-14" x2="120" y2="-10" stroke="#B7BBC4" strokeWidth="6" strokeLinecap="round" />
      </g>
      <g transform="translate(256,180) rotate(45)">
        <path
          d="M -14 -110 L -14 -70 Q -14 -58 -24 -52 Q -40 -42 -40 -22 Q -40 6 -14 6 L -14 190 Q -14 202 -2 202 L 2 202 Q 14 202 14 190 L 14 6 Q 40 6 40 -22 Q 40 -42 24 -52 Q 14 -58 14 -70 L 14 -110 Z"
          fill="url(#logoAccent)"
        />
        <circle cx="0" cy="-22" r="15" fill="#14181C" />
      </g>
    </svg>
  );
}

// Phosphor icon font wrapper. Keeps the same call signature as the old inline-SVG
// icons (size, optional weight) so every <Icon.X size={..}> call site is unchanged.
// weight: 'regular' (default) | 'bold' | 'fill' — maps to the loaded Phosphor CSS files.
function phosphorIcon(name, defaultWeight = 'regular') {
  return (p) => {
    const weight = p.weight || defaultWeight;
    const prefix = weight === 'regular' ? 'ph' : `ph-${weight}`;
    return <i className={`${prefix} ph-${name}`} style={{ fontSize: p.size || 20, lineHeight: 1, display: 'inline-block' }} />;
  };
}

const Icon = {
  Camera: phosphorIcon('camera'),
  Image: phosphorIcon('image'),
  Search: phosphorIcon('magnifying-glass'),
  Plus: phosphorIcon('plus'),
  Calendar: phosphorIcon('calendar'),
  Wrench: phosphorIcon('wrench'),
  Back: phosphorIcon('caret-left'),
  X: phosphorIcon('x', 'bold'),
  Check: phosphorIcon('check', 'bold'),
  Trash: phosphorIcon('trash'),
  Clock: phosphorIcon('clock'),
  ChevronRight: phosphorIcon('caret-right'),
  Settings: phosphorIcon('gear'),
  Sun: phosphorIcon('sun'),
  Moon: phosphorIcon('moon'),
  Monitor: phosphorIcon('monitor'),
  Edit: phosphorIcon('pencil-simple'),
  Bar: phosphorIcon('chart-bar'),
  Download: phosphorIcon('download-simple'),
  Upload: phosphorIcon('upload-simple'),
  Cloud: phosphorIcon('cloud'),
  Refresh: phosphorIcon('arrows-clockwise'),
  Copy: phosphorIcon('copy'),
  ShareIcon: phosphorIcon('share-network'),
  House: phosphorIcon('house'),
  Pin: phosphorIcon('push-pin'),
  Eye: phosphorIcon('eye'),
  // Sada ikon pro kategorie strojů — dostatečně různorodá, ať jde vizuálně
  // odlišit různé typy vybavení/oblastí (elektro, hydraulika, doprava, ...).
  CatGear: phosphorIcon('gear-six'),
  CatBolt: phosphorIcon('lightning'),
  CatDrop: phosphorIcon('drop'),
  CatFlame: phosphorIcon('flame'),
  CatFan: phosphorIcon('fan'),
  CatEngine: phosphorIcon('engine'),
  CatTruck: phosphorIcon('truck'),
  CatFactory: phosphorIcon('factory'),
  CatBox: phosphorIcon('package'),
  CatCircuit: phosphorIcon('circuitry'),
  CatGauge: phosphorIcon('gauge'),
  CatToolbox: phosphorIcon('toolbox'),
  CatBuilding: phosphorIcon('buildings'),
  CatConveyor: phosphorIcon('rows'),
  CatFolder: phosphorIcon('folder'),
  CatStar: phosphorIcon('star'),
  // Sada volitelných ikon pro jednotlivé stroje (odlišná od kategorií).
  MachStroj: phosphorIcon('wrench'),
  MachTable: phosphorIcon('table'),
  MachCamera: phosphorIcon('camera'),
  MachFlame: phosphorIcon('fire-simple'),
  MachSparkle: phosphorIcon('sparkle'),
  MachStamp: phosphorIcon('stamp'),
  MachCarousel: phosphorIcon('cylinder'),
  // Další technické ikony vztahující se k údržbě/továrně, sdílené jak pro
  // kategorie, tak pro jednotlivé stroje.
  TechHammer: phosphorIcon('hammer'),
  TechScrewdriver: phosphorIcon('screwdriver'),
  TechNut: phosphorIcon('nut'),
  TechHardHat: phosphorIcon('hard-hat'),
  TechClipboard: phosphorIcon('clipboard-text'),
  TechWarehouse: phosphorIcon('warehouse'),
  TechCrane: phosphorIcon('crane'),
  TechBattery: phosphorIcon('battery-charging-vertical'),
  TechThermometer: phosphorIcon('thermometer'),
  TechRuler: phosphorIcon('ruler'),
  TechPlug: phosphorIcon('plug'),
  TechPlugsConnected: phosphorIcon('plugs-connected'),
  TechShield: phosphorIcon('shield-check'),
  TechFirstAid: phosphorIcon('first-aid-kit'),
  TechBulb: phosphorIcon('lightbulb'),
  TechSiren: phosphorIcon('siren'),
};

// ============================================================
// THEME
// ============================================================
const THEMES = {
  dark: {
    bg: '#161826', bgSubtle: '#10111a',
    surface: 'rgba(233,233,237,0.045)', surfaceSolid: '#232532', surfaceElevated: '#3f424d',
    border: 'rgba(233,233,237,0.16)', borderStrong: 'rgba(233,233,237,0.26)',
    text: '#e9e9ed', textDim: 'rgba(233,233,237,0.68)', textFaint: 'rgba(233,233,237,0.46)',
    primary: '#9184d9', primaryText: '#ffffff', primarySoft: 'rgba(145,132,217,0.16)',
    cm: '#60d291', cmSoft: 'rgba(96,210,145,0.16)',
    cmAlt: '#e4b750', cmAltSoft: 'rgba(228,183,80,0.16)',
    em: '#ff6976', emSoft: 'rgba(255,105,118,0.16)',
    emAlt: '#e6893a', emAltSoft: 'rgba(230,137,58,0.16)',
    shadow: '0 0 0 1px rgba(233,233,237,0.10)', shadowSm: '0 0 0 1px rgba(233,233,237,0.10)',
    blur: 'blur(20px)', overlay: 'rgba(41,43,49,0.55)',
  },
  light: {
    bg: '#e4e7f5', bgSubtle: '#cfd3e5',
    surface: 'rgba(243,245,254,0.9)', surfaceSolid: '#f3f5fe', surfaceElevated: '#ffffff',
    border: 'rgba(41,43,49,0.14)', borderStrong: 'rgba(41,43,49,0.26)',
    text: '#292b31', textDim: 'rgba(41,43,49,0.66)', textFaint: 'rgba(41,43,49,0.46)',
    primary: '#5d5294', primaryText: '#ffffff', primarySoft: 'rgba(145,132,217,0.12)',
    cm: '#006c37', cmSoft: 'rgba(0,108,55,0.12)',
    cmAlt: '#874f00', cmAltSoft: 'rgba(135,79,0,0.12)',
    em: '#b61537', emSoft: 'rgba(182,21,55,0.12)',
    emAlt: '#a35414', emAltSoft: 'rgba(163,84,20,0.12)',
    shadow: '0 1px 2px rgba(41,43,49,0.07), 0 1px 1px rgba(41,43,49,0.04)', shadowSm: '0 1px 2px rgba(41,43,49,0.07)',
    blur: 'blur(20px)', overlay: 'rgba(41,43,49,0.4)',
  },
};

const TYPES = {
  CM: { label: 'CM', full: 'Normální práce', desc: 'práce' },
  EM: { label: 'EM', full: 'Porucha', desc: 'oprava' },
};

const CM_SUBTYPES = {
  normal: { label: 'Normální práce', short: 'Normál' },
  oprava: { label: 'Oprava', short: 'Oprava' },
};

const EM_SUBTYPES = {
  bezProstoje: { label: 'Bez prostoje', short: 'Bez prostoje' },
  sProstojem: { label: 'S prostojem', short: 'S prostojem' },
};

// Sada volitelných ikon pro kategorie strojů — klíč se ukládá do category.icon.
// Sdílená sada volitelných ikon pro kategorie i jednotlivé stroje — obojí
// nabízí stejný výběr, ať jde snadno vizuálně sladit stroj s jeho kategorií.
// Sparkle zastupuje svařování (jiskry) a gear-six "kolotoč" — Phosphor nemá
// přesné ekvivalenty pro tyto dva pojmy. Všechny lze obarvit přes currentColor.
const SHARED_ICONS = [
  'CatGear', 'CatBolt', 'CatDrop', 'CatFlame', 'CatFan', 'CatEngine',
  'CatTruck', 'CatFactory', 'CatBox', 'CatCircuit', 'CatGauge', 'CatToolbox',
  'CatBuilding', 'CatConveyor', 'CatFolder', 'CatStar',
  'MachStroj', 'MachTable', 'MachCamera', 'MachFlame', 'MachSparkle', 'MachStamp', 'MachCarousel',
  'TechHammer', 'TechScrewdriver', 'TechNut', 'TechHardHat', 'TechClipboard',
  'TechWarehouse', 'TechCrane', 'TechBattery', 'TechThermometer', 'TechRuler',
  'TechPlug', 'TechPlugsConnected', 'TechShield', 'TechFirstAid', 'TechBulb', 'TechSiren',
];

// Paleta barev pro kategorie — čistě odstíny appce vlastní fialové (accent
// barvy), od světlé levandulové po tmavou indigo. Kategorie tak vždy ladí
// s celkovým vzhledem appky, jen s různou intenzitou pro odlišení.
const CATEGORY_COLORS = [
  '#b1a8e6', '#9d90e0', '#8c7edd', '#796bc7', '#6b59cf',
  '#5340bf', '#4230a6', '#392a94', '#32238b', '#24176d',
  '#a398e1', '#7b6cd0', '#6251c2', '#6e60be', '#867cc0',
  '#4a33cc', '#9489d2', '#584bb8', '#5f4fc2', '#7267c4',
];

// Paleta barev pro stroje — širší a pestřejší, ať jde vizuálně rozlišit víc
// různých typů strojů napříč barevným spektrem.
const MACHINE_COLORS = [
  '#9184d9', '#60d291', '#e4b750', '#ff6976', '#5aa9e6',
  '#e67ea3', '#7fd4c1', '#d99a5a', '#8b8fa3', '#c17ee6',
  '#f2994a', '#56ccf2', '#eb5757', '#27ae60', '#bb6bd9',
  '#2f80ed', '#f2c94c', '#219653', '#6fcf97', '#828282',
];

const UNCATEGORIZED_ID = '__uncategorized__';

function useElapsed(startTime, running) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return running && startTime ? now - startTime : 0;
}

// Živé hodiny aktuálního denního času (tikají po minutách, ne po sekundách,
// protože displej ukazuje jen HH:MM).
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// Sleduje aktuální šířku okna a hlásí, jestli je nad desktopovým breakpointem
// (860px) — appka nad ním přepíná na plnohodnotný desktop layout (postranní
// menu, širší mřížky), pod ním zůstává čistě mobilní. Reaguje na resize za
// běhu (změna orientace tabletu, zmenšení okna na PC), ne jen jednou při startu.
const DESKTOP_BREAKPOINT = 860;
function useViewportWidth() {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= DESKTOP_BREAKPOINT : false
  );
  useEffect(() => {
    function handleResize() {
      setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  return isDesktop;
}

// Vykreslí své děti přímo do document.body, mimo aktuální místo appky v
// DOM stromu. Appka na spoustě míst používá `backdropFilter` na kartách
// (efekt "matného skla"), a podle CSS specifikace `backdrop-filter` na
// jakémkoliv předkovi vytváří nový "containing block" pro potomky s
// `position: fixed` — takže modal/picker vykreslený uvnitř takové karty by
// se pak nesprávně centroval vůči té kartě, ne vůči celé obrazovce (nápadné
// hlavně na desktopu, kde je karta jen malá část širší stránky). Portal
// tenhle problém obchází úplně — position:fixed uvnitř něj je vždy
// spolehlivě vztažený k viewportu.
function Portal({ children }) {
  if (typeof document === 'undefined') return null;
  return ReactDOM.createPortal(children, document.body);
}

function useTheme() {
  const [mode, setMode] = useState('dark');
  const [resolved, setResolved] = useState('dark');
  useEffect(() => {
    function resolve() {
      if (mode === 'system') {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        setResolved(prefersDark ? 'dark' : 'light');
      } else {
        setResolved(mode);
      }
    }
    resolve();
    if (mode === 'system' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => resolve();
      mq.addEventListener?.('change', handler);
      return () => mq.removeEventListener?.('change', handler);
    }
  }, [mode]);
  return { mode, setMode, theme: THEMES[resolved], resolvedName: resolved };
}

function IconButton({ theme, onClick, children, variant = 'default' }) {
  const [hover, setHover] = useState(false);
  const bg = variant === 'danger' ? (hover ? theme.emSoft : 'transparent') : (hover ? theme.surfaceElevated : theme.surface);
  const color = variant === 'danger' ? theme.em : theme.text;
  return (
    <button onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background: bg, border: `1px solid ${theme.border}`, borderRadius: 12, width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', color, transition: 'background 0.15s ease, transform 0.1s ease', backdropFilter: theme.blur }}>
      {children}
    </button>
  );
}

function Card({ theme, children, style }) {
  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 18, backdropFilter: theme.blur, boxShadow: theme.shadowSm, ...style }}>
      {children}
    </div>
  );
}

function HomeScreen({ theme, db, activeSession, onStart, onStop, onOpenSettings, onOpenToday, onOpenRecord, onAddPhoto, onRemovePhoto, onAddMaterial, onUpdateMaterial, onRemoveMaterial, isDesktop, refreshTick, googleUser, syncState, onSyncClick }) {
  const elapsed = useElapsed(activeSession?.startTime, !!activeSession);
  const now = useNow();
  const [pressed, setPressed] = useState(false);
  const accentColor = activeSession ? theme.em : theme.primary;
  const accentSoft = activeSession ? theme.emSoft : theme.primarySoft;
  const nowDate = new Date(now);
  const cameraInputRef = useRef(null);
  const galleryInputRef = useRef(null);
  const photoCount = activeSession?.photos?.length || 0;
  const materialCount = activeSession?.materials?.length || 0;
  const [showMaterialModal, setShowMaterialModal] = useState(false);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [editingMaterialIdx, setEditingMaterialIdx] = useState(null);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [lightboxCopyFeedback, setLightboxCopyFeedback] = useState(false);

  function handleSessionFiles(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    // Read all files first, then hand them to onAddPhoto together — reading
    // one-by-one and calling onAddPhoto per file would race against the
    // in-memory activeSession closure and silently drop all but the last photo.
    Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }))).then(dataUrls => onAddPhoto(dataUrls));
    e.target.value = '';
  }

  function submitSessionMaterial(mat) {
    if (typeof editingMaterialIdx === 'number') {
      onUpdateMaterial(editingMaterialIdx, mat);
      setEditingMaterialIdx(null);
    } else {
      onAddMaterial(mat);
    }
  }

  return (
    <div style={{ ...S.screen, background: theme.bg, overflowY: 'auto' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative' }}>
        <div style={S.homeHeader}>
          <div style={S.homeHeaderTop}>
            {isDesktop ? (
              <div />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: theme.primarySoft, border: `1px solid ${theme.primary}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.primary, flexShrink: 0 }}>
                  <Icon.Wrench size={16} weight="fill" />
                </div>
                <span style={{ fontSize: 15, fontWeight: 600, color: theme.text, whiteSpace: 'nowrap' }}>Deník údržbáře</span>
              </div>
            )}
            {!isDesktop && (
              <div style={{ display: 'flex', gap: 4 }}>
                <SyncMenuButton theme={theme} googleUser={googleUser} syncState={syncState} onClick={onSyncClick} variant="icon" />
                <IconButton theme={theme} onClick={onOpenSettings}><Icon.Settings size={19} /></IconButton>
              </div>
            )}
          </div>
        </div>
        {activeSession && (
          <div style={{ position: 'absolute', left: 20, right: 20, top: 68, height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 12, color: theme.textFaint, textAlign: 'center' }}>
              Klidně appku zavři, čas běží dál na pozadí
            </div>
          </div>
        )}
      </div>

      <div style={S.timerWrap}>
        <div style={{ ...S.liveDate, color: theme.textDim, textAlign: 'center', marginBottom: 4, fontSize: isDesktop ? 15 : undefined }}>
          {nowDate.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: isDesktop ? 46 : 38, fontWeight: 600, color: theme.text, letterSpacing: 0.5, marginBottom: 24 }}>
          {nowDate.getHours()}:{pad(nowDate.getMinutes())}
        </div>

        <button
          onMouseDown={() => setPressed(true)} onMouseUp={() => setPressed(false)} onMouseLeave={() => setPressed(false)}
          onTouchStart={() => setPressed(true)} onTouchEnd={() => setPressed(false)}
          style={{
            ...S.mainButton,
            width: isDesktop ? 240 : 196, height: isDesktop ? 240 : 196,
            background: accentSoft,
            border: `2.5px solid ${accentColor}`,
            color: accentColor,
            boxShadow: pressed ? `0 4px 20px ${accentColor}40` : `0 8px 30px ${accentColor}55`,
            transform: pressed ? 'scale(0.97)' : 'scale(1)',
          }}
          onClick={activeSession ? onStop : onStart}
        >
          <div style={activeSession
            ? { ...S.stopSquare, width: isDesktop ? 44 : 36, height: isDesktop ? 44 : 36 }
            : { ...S.startTriangle, borderTopWidth: isDesktop ? 22 : 18, borderBottomWidth: isDesktop ? 22 : 18, borderLeftWidth: isDesktop ? 37 : 30 }
          } />
          <span style={{ ...S.mainButtonLabel, fontSize: isDesktop ? 19 : 16 }}>{activeSession ? 'STOP' : 'START'}</span>
        </button>

        <div style={{ marginTop: 16, minHeight: 96, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {activeSession ? (
            <>
              <div style={{ ...S.timerLabel, color: theme.em }}>PRÁCE PROBÍHÁ OD {fmtTime(activeSession.startTime)}</div>
              <div style={{ ...S.timerDisplay, color: theme.text, marginTop: 6, marginBottom: 0 }}>{fmtDuration(elapsed)}</div>
            </>
          ) : (
            <div style={{ fontSize: 14, color: theme.textFaint, textAlign: 'center', maxWidth: 240, lineHeight: 1.5 }}>
              Stiskni START pro spuštění časomíry
            </div>
          )}
        </div>
      </div>

      {activeSession ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 76, padding: '0 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22 }}>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowPhotoModal(true)}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none' }}
              >
                <div style={{ width: 50, height: 50, borderRadius: 14, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textDim, backdropFilter: theme.blur }}>
                  <Icon.Camera size={20} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: theme.textFaint }}>Foto</span>
              </button>
              {photoCount > 0 && (
                <span style={{
                  position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9, padding: '0 4px',
                  background: theme.primary, color: '#fff', fontSize: 9.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, border: `2px solid ${theme.bg}`,
                }}>{photoCount}</span>
              )}
            </div>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => { setEditingMaterialIdx(null); setShowMaterialModal(true); }}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none' }}
              >
                <div style={{ width: 50, height: 50, borderRadius: 14, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textDim, backdropFilter: theme.blur }}>
                  <Icon.Wrench size={20} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: theme.textFaint }}>Materiál</span>
              </button>
              {materialCount > 0 && (
                <span style={{
                  position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9, padding: '0 4px',
                  background: theme.primary, color: '#fff', fontSize: 9.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, border: `2px solid ${theme.bg}`,
                }}>{materialCount}</span>
              )}
            </div>
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleSessionFiles} />
            <input ref={galleryInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleSessionFiles} />
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 76 }} />
      )}

      {!isDesktop && (
        <div style={{ padding: '0 22px 12px', flexShrink: 0 }}>
          <button style={{ ...S.historyLink, color: theme.textDim, padding: '0', width: '100%' }} onClick={onOpenToday}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              {activeSession && <span style={{ width: 7, height: 7, borderRadius: '50%', background: theme.em, animation: 'livePulse 1.4s ease-in-out infinite' }} />}
              <span>Dnešní opravy</span>
            </span>
            <Icon.ChevronRight size={17} />
          </button>
        </div>
      )}
      </div>

      {showPhotoModal && (
        <div onClick={() => setShowPhotoModal(false)} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', zIndex: 60, display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxHeight: '78vh', background: theme.surfaceSolid, borderTop: `1px solid ${theme.borderStrong}`, borderTopLeftRadius: 20, borderTopRightRadius: 20, boxShadow: theme.shadow, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px 20px 12px', position: 'relative', flexShrink: 0 }}>
              <span style={{ fontSize: 14.5, fontWeight: 700, color: theme.text }}>Fotky opravy</span>
              <button onClick={() => setShowPhotoModal(false)} style={{ position: 'absolute', right: 16, width: 30, height: 30, borderRadius: 9, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint }}>
                <Icon.X size={14} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 28, marginBottom: 20 }}>
                {!isDesktop && (
                  <button onClick={() => cameraInputRef.current?.click()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none' }}>
                    <div style={{ width: 46, height: 46, borderRadius: 13, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textDim }}>
                      <Icon.Camera size={19} />
                    </div>
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: theme.textFaint }}>Kamera</span>
                  </button>
                )}
                <button onClick={() => galleryInputRef.current?.click()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none' }}>
                  <div style={{ width: 46, height: 46, borderRadius: 13, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textDim }}>
                    <Icon.Image size={19} />
                  </div>
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: theme.textFaint }}>{isDesktop ? 'Nahrát z počítače' : 'Nahrát z galerie'}</span>
                </button>
              </div>
              {(activeSession?.photos || []).length === 0 ? (
                <div style={{ fontSize: 12.5, color: theme.textFaint, textAlign: 'center', padding: '8px 0 4px' }}>Zatím žádné fotky — přidej je tlačítkem výše.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {(activeSession?.photos || []).map((p, i) => (
                    <div key={i} style={{ position: 'relative', width: 88, height: 88 }}>
                      <img src={p} onClick={() => setLightboxIndex(i)} style={{ width: 88, height: 88, borderRadius: 12, objectFit: 'cover', border: `1px solid ${theme.border}`, cursor: 'pointer' }} />
                      <button onClick={() => onRemovePhoto(i)} style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: '50%', background: theme.em, border: `2px solid ${theme.surfaceSolid}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
                        <Icon.X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showMaterialModal && (
        <div onClick={() => { setShowMaterialModal(false); setEditingMaterialIdx(null); }} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', zIndex: 60, display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxHeight: '78vh', background: theme.surfaceSolid, borderTop: `1px solid ${theme.borderStrong}`, borderTopLeftRadius: 20, borderTopRightRadius: 20, boxShadow: theme.shadow, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px 20px 12px', position: 'relative', flexShrink: 0 }}>
              <span style={{ fontSize: 14.5, fontWeight: 700, color: theme.text }}>Materiál opravy</span>
              <button onClick={() => { setShowMaterialModal(false); setEditingMaterialIdx(null); }} style={{ position: 'absolute', right: 16, width: 30, height: 30, borderRadius: 9, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint }}>
                <Icon.X size={14} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 20px' }}>
              <MaterialList
                theme={theme} materials={activeSession?.materials || []} editingIdx={editingMaterialIdx}
                onEdit={setEditingMaterialIdx} onRemove={onRemoveMaterial}
              />
              <MaterialEditor
                theme={theme}
                initial={typeof editingMaterialIdx === 'number' ? (activeSession?.materials || [])[editingMaterialIdx] : null}
                onSubmit={submitSessionMaterial}
                onCancelEdit={() => setEditingMaterialIdx(null)}
              />
            </div>
          </div>
        </div>
      )}

      {lightboxIndex !== null && (
        <div onClick={() => setLightboxIndex(null)} style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(0,0,0,0.94)', display: 'flex', flexDirection: 'column' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={async () => { await sharePhoto((activeSession?.photos || [])[lightboxIndex], null, lightboxIndex); }}
                style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
              >
                <Icon.ShareIcon size={17} />
              </button>
              <button
                onClick={async () => {
                  const ok = await copyPhotoToClipboard((activeSession?.photos || [])[lightboxIndex]);
                  if (ok) { setLightboxCopyFeedback(true); setTimeout(() => setLightboxCopyFeedback(false), 1800); }
                }}
                style={{ width: 40, height: 40, borderRadius: 11, background: lightboxCopyFeedback ? theme.cmSoft : 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: lightboxCopyFeedback ? theme.cm : '#fff' }}
              >
                {lightboxCopyFeedback ? <Icon.Check size={16} weight="bold" /> : <Icon.Copy size={17} />}
              </button>
              <button
                onClick={async () => { await downloadPhoto((activeSession?.photos || [])[lightboxIndex], null, lightboxIndex); }}
                style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
              >
                <Icon.Download size={17} />
              </button>
              <button
                onClick={() => { onRemovePhoto(lightboxIndex); setLightboxIndex(null); }}
                style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(244,63,94,0.18)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6976' }}
              >
                <Icon.Trash size={17} />
              </button>
              <button onClick={() => setLightboxIndex(null)} style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
                <Icon.X size={18} />
              </button>
            </div>
          </div>
          <div onClick={(e) => e.stopPropagation()} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            <ZoomableImage src={(activeSession?.photos || [])[lightboxIndex]} />
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsScreen({ theme, mode, setMode, onBack, db, onDataRestored, googleUser, syncState, onGoogleSignIn, onGoogleSignOut, onResetAll }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const options = [
    { key: 'light', label: 'Světlý', icon: Icon.Sun },
    { key: 'dark', label: 'Tmavý', icon: Icon.Moon },
    { key: 'system', label: 'Systém', icon: Icon.Monitor },
  ];
  const fileInputRef = useRef(null);
  const [confirmImport, setConfirmImport] = useState(null); // parsed backup data pending confirmation
  const [status, setStatus] = useState(null); // { type: 'success'|'error', text }

  async function handleExport() {
    try {
      const machines = await db.getAll('machines');
      const records = await db.getAll('records');
      const payload = {
        app: 'denik-udrzbare', version: APP_VERSION, exportedAt: new Date().toISOString(),
        machines, records,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = fmtDateKey(Date.now());
      a.href = url;
      a.download = `denik-udrzbare-zaloha-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus({ type: 'success', text: 'Záloha byla stažena.' });
    } catch (e) {
      setStatus({ type: 'error', text: 'Export se nezdařil.' });
    }
  }

  function triggerImport() {
    fileInputRef.current?.click();
  }

  function onFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.machines) || !Array.isArray(data.records)) {
          setStatus({ type: 'error', text: 'Soubor neobsahuje platnou zálohu.' });
          return;
        }
        setConfirmImport(data);
      } catch (e) {
        setStatus({ type: 'error', text: 'Soubor se nepodařilo přečíst.' });
      }
    };
    reader.readAsText(file);
  }

  async function performImport() {
    const data = confirmImport;
    setConfirmImport(null);
    try {
      const existingMachines = await db.getAll('machines');
      const existingRecords = await db.getAll('records');
      for (const m of existingMachines) await db.delete('machines', m.id);
      for (const r of existingRecords) await db.delete('records', r.id);
      for (const m of data.machines) await db.put('machines', m);
      for (const r of data.records) await db.put('records', r);
      setStatus({ type: 'success', text: `Obnoveno: ${data.machines.length} strojů, ${data.records.length} záznamů.` });
      onDataRestored?.();
    } catch (e) {
      setStatus({ type: 'error', text: 'Obnovení se nezdařilo.' });
    }
  }

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title="Nastavení" onBack={onBack} />
      <div style={{ padding: '8px 20px', flex: 1, overflowY: 'auto' }}>
        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Vzhled</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          {options.map(opt => {
            const active = mode === opt.key;
            const IconComp = opt.icon;
            return (
              <button key={opt.key} onClick={() => setMode(opt.key)}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '16px 8px', borderRadius: 14, background: active ? theme.primarySoft : theme.surface, border: `1.5px solid ${active ? theme.primary : theme.border}`, color: active ? theme.primary : theme.textDim, transition: 'all 0.15s ease' }}>
                <IconComp size={20} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</span>
              </button>
            );
          })}
        </div>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Záloha dat</div>
        <Card theme={theme} style={{ padding: '16px 18px', marginBottom: status ? 12 : 24 }}>
          <div style={{ fontSize: 13, color: theme.textDim, lineHeight: 1.5, marginBottom: 14 }}>
            Ulož si zálohu dat do souboru, nebo ji obnov na jiném zařízení.
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={handleExport} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: theme.surfaceElevated, border: `1px solid ${theme.borderStrong}`, borderRadius: 12, padding: '12px', color: theme.text, fontSize: 13.5, fontWeight: 600 }}>
              <Icon.Download size={16} />
              <span>Export</span>
            </button>
            <button onClick={triggerImport} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: theme.surfaceElevated, border: `1px solid ${theme.borderStrong}`, borderRadius: 12, padding: '12px', color: theme.text, fontSize: 13.5, fontWeight: 600 }}>
              <Icon.Upload size={16} />
              <span>Import</span>
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={onFileSelected} />
        </Card>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Cloud synchronizace</div>
        <Card theme={theme} style={{ padding: '16px 18px', marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: theme.textDim, lineHeight: 1.5, marginBottom: 14 }}>
            {googleUser
              ? 'Stroje, záznamy, fotky i běžící časomíra se drží v tvém soukromém cloudovém úložišti a přenášejí se mezi zařízeními samy, hned jak se něco změní.'
              : 'Přihlas se přes Google a data se budou automaticky přenášet mezi tvými zařízeními. Vidí je jen tvůj účet.'}
          </div>

          {!googleUser ? (
            <button onClick={onGoogleSignIn} disabled={syncState.status === 'connecting'}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: theme.surfaceElevated, border: `1px solid ${theme.borderStrong}`, borderRadius: 12, padding: '12px', color: theme.text, fontSize: 13.5, fontWeight: 600, opacity: syncState.status === 'connecting' ? 0.6 : 1 }}>
              <Icon.Cloud size={16} />
              <span>Přihlásit se přes Google</span>
            </button>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text, marginBottom: 12 }}>
                <Icon.Cloud size={16} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{googleUser.email || 'Přihlášen'}</span>
              </div>

              <button onClick={onGoogleSignOut}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: theme.surfaceElevated, border: `1px solid ${theme.borderStrong}`, borderRadius: 12, padding: '12px', color: theme.textDim, fontSize: 13.5, fontWeight: 600 }}>
                Odhlásit
              </button>

              <div style={{ fontSize: 12, color: syncState.status === 'error' ? theme.em : theme.textFaint, marginTop: 10, lineHeight: 1.4 }}>
                {syncState.msg
                  || (syncState.status === 'error' && 'Připojení k cloudu se nezdařilo.')
                  || (syncState.status === 'connecting' && 'Připojuji…')
                  || (syncState.lastSyncAt ? `Naposledy synchronizováno ${fmtSyncTime(syncState.lastSyncAt)}` : 'Čeká se na první synchronizaci…')}
              </div>
            </>
          )}
        </Card>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Reset</div>
        <Card theme={theme} style={{ padding: '16px 18px', marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: theme.textDim, lineHeight: 1.5, marginBottom: 14 }}>
            Smaže všechny stroje, záznamy oprav a kategorie v tomto zařízení.
            {googleUser ? ' Synchronizace zůstane přihlášená — appka si hned vrátí zpět sdílený stav z cloudu (z ostatních zařízení).' : ' Tuto akci nelze vrátit.'}
          </div>
          <button onClick={() => setConfirmReset(true)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: theme.emSoft, border: `1px solid ${theme.em}55`, borderRadius: 12, padding: '12px', color: theme.em, fontSize: 13.5, fontWeight: 700 }}>
            <Icon.Trash size={16} />
            <span>Resetovat vše</span>
          </button>
        </Card>

        {status && (
          <div style={{
            fontSize: 12.5, color: status.type === 'error' ? theme.em : theme.cm,
            background: status.type === 'error' ? theme.emSoft : theme.cmSoft,
            border: `1px solid ${status.type === 'error' ? theme.em : theme.cm}33`,
            borderRadius: 10, padding: '10px 13px', marginBottom: 24,
          }}>
            {status.text}
          </div>
        )}

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>O appce</div>
        <Card theme={theme} style={{ padding: '16px 18px' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: theme.text, marginBottom: 3 }}>Deník údržbáře</div>
          <div style={{ fontSize: 13, color: theme.textFaint }}>Verze {APP_VERSION}</div>
          <div style={{ fontSize: 12.5, color: theme.textFaint, marginTop: 8, lineHeight: 1.5 }}>{googleUser ? 'Data se ukládají v tomto zařízení a synchronizují se v cloudu s tvými ostatními zařízeními.' : 'Data se ukládají pouze v tomto zařízení.'}</div>
        </Card>

        <a
          href="https://buymeacoffee.com/phantomlabs/e/566888"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12,
            background: theme.surfaceElevated, border: `1px solid ${theme.borderStrong}`, borderRadius: 14,
            padding: '13px', color: theme.text, fontSize: 14, fontWeight: 700, textDecoration: 'none',
          }}
        >
          <span style={{ fontSize: 16 }}>☕</span>
          <span>Podpoř vývoj appky</span>
        </a>

        <div style={{ height: 24 }} />
      </div>

      {confirmReset && (
        <div onClick={() => setConfirmReset(false)} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: theme.surfaceSolid, border: `1px solid ${theme.borderStrong}`, borderRadius: 20, padding: 22, width: '100%', maxWidth: 320, boxShadow: theme.shadow }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, marginBottom: 4 }}>Resetovat vše?</div>
            <div style={{ fontSize: 13, color: theme.textDim, marginBottom: 18, lineHeight: 1.5 }}>
              Smažou se všechny stroje, záznamy oprav a kategorie v tomto zařízení{googleUser ? '. Synchronizace zůstane přihlášená — appka si hned natáhne zpátky sdílený stav z cloudu.' : '. Tato akce se nedá vrátit.'}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmReset(false)} style={{ flex: 1, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px', color: theme.text, fontWeight: 600 }}>Zrušit</button>
              <button onClick={() => { setConfirmReset(false); onResetAll?.(); setStatus({ type: 'success', text: 'Data byla vymazána.' }); }} style={{ flex: 1, background: theme.em, border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontWeight: 700 }}>Resetovat</button>
            </div>
          </div>
        </div>
      )}

      {confirmImport && (
        <div onClick={() => setConfirmImport(null)} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: theme.surfaceSolid, border: `1px solid ${theme.borderStrong}`, borderRadius: 20, padding: 22, width: '100%', maxWidth: 320, boxShadow: theme.shadow }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, marginBottom: 4 }}>Nahradit všechna data?</div>
            <div style={{ fontSize: 13, color: theme.textDim, marginBottom: 18, lineHeight: 1.5 }}>
              Import smaže všechny současné stroje a záznamy ({confirmImport.machines.length} strojů, {confirmImport.records.length} záznamů v záloze) a nahradí je obsahem zálohy. Tato akce se nedá vrátit.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmImport(null)} style={{ flex: 1, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px', color: theme.text, fontWeight: 600 }}>Zrušit</button>
              <button onClick={performImport} style={{ flex: 1, background: theme.em, border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontWeight: 700 }}>Nahradit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModalHeader({ theme, title, onBack, onHome, onAction, actionIcon: ActionIcon, actionVariant, onSecondaryAction, secondaryActionIcon: SecondaryIcon }) {
  return (
    <div style={{ ...S.modalHeader, borderBottom: `1px solid ${theme.border}` }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {onBack ? <IconButton theme={theme} onClick={onBack}><Icon.Back size={19} /></IconButton> : <div style={{ width: 42 }} />}
        {onHome && <IconButton theme={theme} onClick={onHome}><Icon.House size={18} /></IconButton>}
      </div>
      <span style={{ ...S.modalTitle, color: theme.text }}>{title}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        {SecondaryIcon && <IconButton theme={theme} onClick={onSecondaryAction}><SecondaryIcon size={18} /></IconButton>}
        {ActionIcon ? <IconButton theme={theme} onClick={onAction} variant={actionVariant}><ActionIcon size={18} /></IconButton> : <div style={{ width: 42 }} />}
      </div>
    </div>
  );
}

function MachinePicker({ theme, db, onPick, onCancel }) {
  const [query, setQuery] = useState('');
  const [machines, setMachines] = useState([]);
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    const all = await db.getAll('machines');
    all.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    setMachines(all);
  }, [db]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 250); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return machines;
    return machines.filter(m => m.name.toLowerCase().includes(q));
  }, [machines, query]);

  const exactMatch = machines.some(m => m.name.toLowerCase() === query.trim().toLowerCase());
  const canCreate = query.trim().length > 0 && !exactMatch;

  async function createAndPick() {
    const name = query.trim();
    if (!name) return;
    const machine = { id: uid(), name, categoryId: null, notes: '', photos: [], createdAt: Date.now(), lastUsed: Date.now() };
    await db.put('machines', machine);
    onPick(machine);
  }

  async function pick(m) {
    m.lastUsed = Date.now();
    await db.put('machines', m);
    onPick(m);
  }

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title="Vyber stroj" onBack={onCancel} />
      <div style={{ padding: '16px 20px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14, padding: '13px 16px', color: theme.textFaint, backdropFilter: theme.blur }}>
          <Icon.Search size={18} />
          <input ref={inputRef} style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: theme.text, fontSize: 16, fontFamily: 'inherit' }} placeholder="Hledat nebo zadat nový název..." value={query} onChange={e => setQuery(e.target.value.toUpperCase())} enterKeyHint="done" />
        </div>
      </div>

      {canCreate && (
        <div style={{ padding: '0 20px 8px' }}>
          <button onClick={createAndPick} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: theme.primarySoft, border: `1.5px dashed ${theme.primary}66`, borderRadius: 14, padding: '15px 16px', color: theme.primary, fontSize: 15, fontWeight: 600 }}>
            <Icon.Plus size={18} />
            <span>Přidat nový stroj „{query.trim()}"</span>
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px' }}>
        {filtered.length === 0 && !canCreate && <div style={{ ...S.emptyState, color: theme.textFaint }}>Zatím žádné stroje. Začni psát název pro vytvoření prvního.</div>}
        {filtered.map(m => (
          <button key={m.id} onClick={() => pick(m)} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14, padding: '15px 16px', marginBottom: 8, color: theme.text, backdropFilter: theme.blur }}>
            <div style={{ color: theme.textFaint, display: 'flex' }}><Icon.Wrench size={16} /></div>
            <span style={{ flex: 1, textAlign: 'left', fontSize: 15, fontWeight: 500 }}>{m.name}</span>
            <div style={{ color: theme.textFaint }}><Icon.ChevronRight size={16} /></div>
          </button>
        ))}
      </div>
    </div>
  );
}

function DurationEditor({ theme, valueMs, onChange }) {
  const totalMin = Math.round(valueMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;

  function update(newH, newM) {
    const clampedM = Math.max(0, Math.min(59, newM));
    const clampedH = Math.max(0, newH);
    onChange((clampedH * 60 + clampedM) * 60000);
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14, padding: '14px 16px', backdropFilter: theme.blur }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="number" min="0" value={h} onChange={e => update(parseInt(e.target.value || '0', 10), m)}
          style={{ width: 56, background: theme.bgSubtle, border: `1px solid ${theme.border}`, borderRadius: 10, padding: '8px 4px', color: theme.text, fontSize: 17, fontWeight: 700, textAlign: 'center', fontFamily: 'inherit', outline: 'none' }} />
        <span style={{ color: theme.textDim, fontSize: 13 }}>h</span>
        <input type="number" min="0" max="59" value={m} onChange={e => update(h, parseInt(e.target.value || '0', 10))}
          style={{ width: 56, background: theme.bgSubtle, border: `1px solid ${theme.border}`, borderRadius: 10, padding: '8px 4px', color: theme.text, fontSize: 17, fontWeight: 700, textAlign: 'center', fontFamily: 'inherit', outline: 'none' }} />
        <span style={{ color: theme.textDim, fontSize: 13 }}>min</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {[15, 30, 60].map(min => (
          <button key={min} onClick={() => update(Math.floor(min / 60), min % 60)} style={{ background: theme.bgSubtle, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '6px 9px', color: theme.textDim, fontSize: 12, fontWeight: 600 }}>
            {min < 60 ? `${min}m` : '1h'}
          </button>
        ))}
      </div>
    </div>
  );
}

// Needitovatelný náhled rozpracované opravy (activeSession) — otevírá se
// klepnutím na kartu "Právě probíhá" v Dnešní opravy, stejně jako appka
// nejdřív ukáže needitovatelný detail u hotového záznamu, než se přejde do
// úprav. Na rozdíl od RecordDetail appka tady nemá uložený záznam s id v
// databázi (jen rozpracovaná data v activeSession), takže není co mazat a
// není třeba stahovat/sdílet — jen zobrazit, co je zatím zadané, a nabídnout
// tlačítko pro editaci.
function LivePreview({ theme, session, liveElapsed, onBack, onHome, onEdit, onUpdateMaterial, onRemoveMaterial }) {
  const [editingMaterialIdx, setEditingMaterialIdx] = useState(null);
  const color = session.type === 'EM' ? theme.em : (session.cmSubtype === 'oprava' ? theme.cmAlt : theme.cm);
  const soft = session.type === 'EM' ? theme.emSoft : (session.cmSubtype === 'oprava' ? theme.cmAltSoft : theme.cmSoft);
  const typeLabel = session.type === 'EM'
    ? (session.emSubtype === 'bezProstoje' ? 'EM · Bez prostoje' : 'EM · S prostojem')
    : `CM · ${CM_SUBTYPES[session.cmSubtype || 'normal'].label}`;

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title="Právě probíhá" onBack={onBack} onHome={onHome} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        <Card theme={theme} style={{ padding: 18, marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: session.machineName ? theme.text : theme.textFaint }}>
              {session.machineName || 'Bez stroje'}
            </div>
            {session.type && (
              <span style={{ display: 'inline-block', padding: '5px 12px', borderRadius: 9, fontSize: 12, fontWeight: 700, color, background: soft, whiteSpace: 'nowrap' }}>
                {typeLabel}
              </span>
            )}
          </div>
          <div style={{ background: theme.emSoft, border: `1px solid ${theme.em}33`, borderRadius: 12, padding: '11px 13px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: theme.em, flexShrink: 0 }} />
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 16, fontWeight: 700, color: theme.em }}>od {fmtTime(session.startTime)} · {fmtDuration(liveElapsed)}</span>
          </div>
        </Card>

        {session.wo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 26 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint }}>WO</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5, fontWeight: 700, color: theme.textDim, background: theme.surfaceElevated, padding: '3px 9px', borderRadius: 7 }}>
              {session.wo}
            </span>
          </div>
        )}
        {session.issue && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint, marginBottom: 8 }}>Závada</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: theme.text, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{session.issue}</div>
          </div>
        )}
        {session.solution && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint, marginBottom: 8 }}>Řešení</div>
            <div style={{ background: theme.bgSubtle, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '13px 16px' }}>
              <div style={{ fontSize: 14.5, fontWeight: 500, color: theme.text, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{session.solution}</div>
            </div>
          </div>
        )}
        {session.photos?.length > 0 && (
          <>
            <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Fotky</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 26 }}>
              {session.photos.map((p, i) => (
                <img key={i} src={p} style={{ width: 100, height: 100, borderRadius: 14, objectFit: 'cover', border: `1px solid ${theme.border}` }} />
              ))}
            </div>
          </>
        )}
        {session.materials?.length > 0 && (
          <div style={{ marginBottom: 26 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint, marginBottom: 8 }}>Materiál</div>
            <MaterialList theme={theme} materials={session.materials} editingIdx={editingMaterialIdx}
              onEdit={(i) => setEditingMaterialIdx(i)}
              onRemove={(i) => { if (editingMaterialIdx === i) setEditingMaterialIdx(null); onRemoveMaterial?.(i); }} />
            {editingMaterialIdx !== null && (session.materials || [])[editingMaterialIdx] && (
              <div style={{ marginTop: 10 }}>
                <MaterialEditor theme={theme} initial={session.materials[editingMaterialIdx]}
                  onSubmit={(mat) => { onUpdateMaterial?.(editingMaterialIdx, mat); setEditingMaterialIdx(null); }}
                  onCancelEdit={() => setEditingMaterialIdx(null)} />
              </div>
            )}
          </div>
        )}
        {!session.wo && !session.issue && !session.solution && !session.photos?.length && !session.materials?.length && (
          <div style={{ fontSize: 13, color: theme.textFaint, textAlign: 'center', padding: '20px 0' }}>
            Zatím nic zadané — klepni na Upravit a doplň, co víš.
          </div>
        )}
      </div>
      <div style={{ padding: '14px 20px', borderTop: `1px solid ${theme.border}`, background: theme.bg }}>
        <button onClick={onEdit} style={{ width: '100%', background: theme.surfaceElevated, border: `1px solid ${theme.borderStrong}`, borderRadius: 14, padding: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: theme.text, fontSize: 15, fontWeight: 700 }}>
          <Icon.Edit size={16} />
          <span>Upravit záznam</span>
        </button>
      </div>
    </div>
  );
}

function RecordForm({ theme, db, session, initialDate, machine: machineProp, onSave, onCancel, resolvedThemeName, liveEdit, onLiveSave, liveElapsed }) {
  // V liveEdit módu appka spravuje vybraný stroj sama (jde ho vybrat i
  // změnit přímo z formuláře) — mimo liveEdit zůstává stroj pevně daný
  // propem, appka ho tam nemění.
  const [liveMachine, setLiveMachine] = useState(() => (session?.machineId ? { id: session.machineId, name: session.machineName } : null));
  const machine = liveEdit ? liveMachine : machineProp;
  const [type, setType] = useState(session?.type || 'CM');
  const [cmSubtype, setCmSubtype] = useState(session?.cmSubtype || 'normal');
  const [emSubtype, setEmSubtype] = useState(session?.emSubtype || 'sProstojem');
  const [wo, setWo] = useState(session?.wo || '');
  const [issue, setIssue] = useState(session?.issue || '');
  const [solution, setSolution] = useState(session?.solution || '');
  const [photos, setPhotos] = useState(() => session?.photos || []);
  const [materials, setMaterials] = useState(() => session?.materials || []);
  const [editingMaterialIdx, setEditingMaterialIdx] = useState(null);
  const [showMachinePicker, setShowMachinePicker] = useState(false); // jen pro liveEdit — výběr/změna stroje bez opuštění formuláře
  const fileInputRef = useRef(null);
  const galleryInputRef = useRef(null);

  // session (ze STOP) má reálný start/end, zaokrouhlený na nejbližších 5 minut
  // (appka takhle zaokrouhluje časy všude — konzistentní, "hezké" hodnoty
  // bez nutnosti řešit sekundovou přesnost). Ruční přidání opravy na DNEŠNÍ
  // den startuje od aktuálního času (taky zaokrouhleného) — nejpravděpodobnější
  // hodnota, kterou uživatel chce. Pro jiný (minulý) den, kde "teď" nedává
  // smysl, zůstává rozumné pevné okno 8:00–8:30, oboje plně editovatelné.
  const initialStart = session ? roundToNearest5Min(session.startTime) : (() => {
    const d = new Date(initialDate);
    const today = new Date();
    const isToday = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    if (isToday) return roundToNearest5Min(Date.now());
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  })();
  const initialEndRaw = session ? roundToNearest5Min(session.endTime) : initialStart + 30 * 60000;
  // Krátké opravy (pod 5 minut) se po zaokrouhlení mohou srazit na stejný čas
  // jako start — v tom případě necháme aspoň jeden 5minutový blok, ať interval
  // nikdy není nulový nebo záporný.
  const initialEnd = session && initialEndRaw <= initialStart ? initialStart + 5 * 60000 : initialEndRaw;

  const [startTime, setStartTime] = useState(initialStart);
  const [endTime, setEndTime] = useState(initialEnd);

  // Délka prostoje u EM má vlastní od-do okno, nezávislé na skutečné době na
  // místě (startTime/endTime) — výchozí je stejné okno, ale editovatelné zvlášť.
  const [downtimeStart, setDowntimeStart] = useState(initialStart);
  const [downtimeEnd, setDowntimeEnd] = useState(initialEnd);
  const [downtimeTouched, setDowntimeTouched] = useState(false);
  const [editingDowntime, setEditingDowntime] = useState(false);

  const actualDuration = Math.max(0, endTime - startTime);
  const effectiveDowntime = emSubtype === 'bezProstoje' ? 0 : (downtimeTouched ? Math.max(0, downtimeEnd - downtimeStart) : actualDuration);
  const isBackfill = !session;

  function updateStartDate(newStart) {
    // Keep the same time-of-day, just move to a different day; also shift endTime by the same delta if needed
    const delta = newStart - startTime;
    setStartTime(newStart);
    setEndTime(e => Math.max(newStart, e + delta));
    if (!downtimeTouched) {
      setDowntimeStart(newStart);
      setDowntimeEnd(e => Math.max(newStart, e + delta));
    }
  }

  // Editace času "Od"/"Do" (doba na místě) posune prostoj stejným způsobem,
  // pokud ho uživatel ještě needitoval ručně — jakmile prostoj upraví sám,
  // dál se s dobou na místě nesynchronizuje (downtimeTouched).
  function updateStartTime(newStart) {
    const delta = newStart - startTime;
    setStartTime(newStart);
    setEndTime(e => Math.max(newStart, e + delta));
    if (!downtimeTouched) {
      setDowntimeStart(s => s + delta);
      setDowntimeEnd(e => e + delta);
    }
  }

  function updateEndTime(newEnd) {
    const delta = newEnd - endTime;
    setEndTime(newEnd);
    if (!downtimeTouched) {
      setDowntimeEnd(e => e + delta);
    }
  }

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }))).then(dataUrls => setPhotos(prev => [...prev, ...dataUrls]));
    e.target.value = '';
  }

  function removePhoto(idx) {
    setPhotos(prev => prev.filter((_, i) => i !== idx));
  }

  function submitMaterial(mat) {
    if (editingMaterialIdx !== null) {
      setMaterials(prev => prev.map((m, i) => i === editingMaterialIdx ? mat : m));
      setEditingMaterialIdx(null);
    } else {
      setMaterials(prev => [...prev, mat]);
    }
  }

  function removeMaterial(idx) {
    setMaterials(prev => prev.filter((_, i) => i !== idx));
    if (editingMaterialIdx === idx) setEditingMaterialIdx(null);
  }

  async function save() {
    if (liveEdit) {
      // V živém módu appka jen průběžně ukládá rozpracovaná data do
      // activeSession — žádný záznam v `records` ještě nevzniká, appka
      // nemá ani čas konce (ten se dopočítá až po STOP), takže se tu
      // neřeší downtime ani finální id/date.
      onLiveSave({
        machineId: machine?.id, machineName: machine?.name, type,
        cmSubtype: type === 'CM' ? cmSubtype : null,
        emSubtype: type === 'EM' ? emSubtype : null,
        wo: wo.trim(), issue: issue.trim(), solution: solution.trim(), photos, materials,
      });
      onSave();
      return;
    }
    const record = {
      id: uid(), machineId: machine.id, machineName: machine.name, type,
      cmSubtype: type === 'CM' ? cmSubtype : null,
      emSubtype: type === 'EM' ? emSubtype : null,
      wo: wo.trim(), issue: issue.trim(), solution: solution.trim(), photos, materials,
      startTime, endTime: Math.max(startTime, endTime),
      downtimeMs: type === 'EM' ? effectiveDowntime : null,
      downtimeStart: type === 'EM' ? downtimeStart : null,
      downtimeEnd: type === 'EM' ? Math.max(downtimeStart, downtimeEnd) : null,
      downtimeOverridden: type === 'EM' && downtimeTouched,
      date: fmtDateKey(startTime), createdAt: Date.now(),
    };
    await db.put('records', record);
    onSave(record);
  }

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title={liveEdit ? 'Právě probíhá' : (isBackfill ? 'Přidat opravu' : 'Zápis opravy')} onBack={onCancel} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        <Card theme={theme} style={{ padding: 18, marginBottom: 22 }}>
          {liveEdit ? (
            <button onClick={() => setShowMachinePicker(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', padding: 0, marginBottom: 4 }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: machine ? theme.text : theme.textFaint }}>{machine ? machine.name : 'Vybrat stroj (volitelné)'}</span>
              <Icon.ChevronRight size={16} style={{ color: theme.textFaint, flexShrink: 0 }} />
            </button>
          ) : (
            <div style={{ fontSize: 18, fontWeight: 700, color: theme.text, marginBottom: 12 }}>{machine.name}</div>
          )}
          {liveEdit ? (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 22, fontWeight: 700, color: theme.em }}>{liveElapsed}</span>
              <span style={{ fontSize: 12, color: theme.textFaint }}>čas doběhne až po STOP</span>
            </div>
          ) : (
            <>
              <DateEditor theme={theme} label="Datum" value={startTime} onChange={updateStartDate} isDark={resolvedThemeName === 'dark'} />
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <TimeEditor theme={theme} label="Od" value={startTime} onChange={updateStartTime} isDark={resolvedThemeName === 'dark'} />
                <TimeEditor theme={theme} label="Do" value={endTime} onChange={updateEndTime} isDark={resolvedThemeName === 'dark'} />
              </div>
              <div style={{ fontSize: 12, color: theme.textFaint, marginTop: 10 }}>doba na místě {fmtDurationShort(actualDuration)}</div>
            </>
          )}
        </Card>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Typ</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: type === 'CM' ? 12 : 22 }}>
          {Object.entries(TYPES).map(([key, cfg]) => {
            const active = type === key;
            const color = key === 'CM' ? theme.cm : theme.em;
            const soft = key === 'CM' ? theme.cmSoft : theme.emSoft;
            return (
              <button key={key} onClick={() => setType(key)}
                style={{ flex: 1, background: active ? soft : theme.surface, border: `1.5px solid ${active ? color : theme.border}`, borderRadius: 14, padding: '14px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, color: active ? color : theme.textDim, transition: 'all 0.15s ease' }}>
                <span style={{ fontSize: 16.5, fontWeight: 700 }}>{cfg.label}</span>
                <span style={{ fontSize: 11 }}>{cfg.desc}</span>
              </button>
            );
          })}
        </div>

        {type === 'CM' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
            {Object.entries(CM_SUBTYPES).map(([key, cfg]) => {
              const active = cmSubtype === key;
              const color = key === 'normal' ? theme.cm : theme.cmAlt;
              const soft = key === 'normal' ? theme.cmSoft : theme.cmAltSoft;
              return (
                <button key={key} onClick={() => setCmSubtype(key)}
                  style={{ flex: 1, background: active ? soft : theme.surface, border: `1.5px solid ${active ? color : theme.border}`, borderRadius: 12, padding: '9px 10px', color: active ? color : theme.textDim, fontSize: 12.5, fontWeight: 700, transition: 'all 0.15s ease' }}>
                  {cfg.label}
                </button>
              );
            })}
          </div>
        )}

        {type === 'EM' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
            {Object.entries(EM_SUBTYPES).map(([key, cfg]) => {
              const active = emSubtype === key;
              const c = key === 'bezProstoje' ? theme.emAlt : theme.em;
              const s = key === 'bezProstoje' ? theme.emAltSoft : theme.emSoft;
              return (
                <button key={key} onClick={() => setEmSubtype(key)}
                  style={{ flex: 1, background: active ? s : theme.surface, border: `1.5px solid ${active ? c : theme.border}`, borderRadius: 12, padding: '9px 10px', color: active ? c : theme.textDim, fontSize: 12.5, fontWeight: 700, transition: 'all 0.15s ease' }}>
                  {cfg.label}
                </button>
              );
            })}
          </div>
        )}

        {!liveEdit && type === 'EM' && emSubtype === 'sProstojem' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ ...S.fieldLabel, color: theme.textFaint, marginBottom: 0 }}>Prostoj (od–do)</div>
              {!editingDowntime && (
                <button onClick={() => setEditingDowntime(true)} style={{ display: 'flex', alignItems: 'center', gap: 5, color: theme.primary, fontSize: 13, fontWeight: 600 }}>
                  <Icon.Edit size={13} />
                  <span>Upravit</span>
                </button>
              )}
            </div>
            {editingDowntime ? (
              <div style={{ marginBottom: 22 }}>
                <div style={{ display: 'flex', gap: 10 }}>
                  <TimeEditor theme={theme} label="Od" value={downtimeStart} onChange={v => { setDowntimeTouched(true); setDowntimeStart(v); }} isDark={resolvedThemeName === 'dark'} />
                  <TimeEditor theme={theme} label="Do" value={downtimeEnd} onChange={v => { setDowntimeTouched(true); setDowntimeEnd(v); }} isDark={resolvedThemeName === 'dark'} />
                </div>
                <div style={{ fontSize: 12, color: theme.textFaint, marginTop: 8 }}>délka prostoje: {fmtDurationMin(effectiveDowntime)}</div>
                <button onClick={() => { setEditingDowntime(false); setDowntimeTouched(false); setDowntimeStart(startTime); setDowntimeEnd(endTime); }} style={{ marginTop: 8, fontSize: 13, color: theme.textFaint }}>
                  Zpět na dobu opravy ({fmtDurationShort(actualDuration)})
                </button>
              </div>
            ) : (
              <div style={{ background: theme.emSoft, border: `1px solid ${theme.em}33`, borderRadius: 14, padding: '14px 16px', marginBottom: 22 }}>
                <span style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: theme.em }}>{fmtDurationShort(effectiveDowntime)}</span>
                <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5, color: theme.textDim, marginTop: 4 }}>
                  {fmtTime(downtimeStart)}–{fmtTime(downtimeEnd)}
                </div>
              </div>
            )}
          </>
        )}

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Číslo pracovního příkazu (WO)</div>
        <input
          type="tel" inputMode="numeric" pattern="[0-9]*"
          style={{ ...S.textInput, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.text, backdropFilter: theme.blur }}
          placeholder="např. 4471" value={wo}
          onChange={e => setWo(e.target.value.replace(/\D/g, ''))}
        />

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Závada</div>
        <textarea style={{ ...S.textArea, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.text, backdropFilter: theme.blur }} placeholder="Co bylo za problém..." value={issue} onChange={e => setIssue(e.target.value)} rows={3} />

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Řešení / co bylo uděláno</div>
        <textarea style={{ ...S.textArea, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.text, backdropFilter: theme.blur }} placeholder="Postup opravy..." value={solution} onChange={e => setSolution(e.target.value)} rows={3} />

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Fotky</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: 'relative', width: 72, height: 72 }}>
              <img src={p} style={{ width: 72, height: 72, borderRadius: 12, objectFit: 'cover', border: `1px solid ${theme.border}` }} />
              <button onClick={() => removePhoto(i)} style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: '50%', background: theme.em, border: `2px solid ${theme.bg}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><Icon.X size={12} /></button>
            </div>
          ))}
          <button onClick={() => fileInputRef.current?.click()} style={{ width: 72, height: 72, borderRadius: 12, background: theme.surface, border: `1.5px dashed ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint, backdropFilter: theme.blur }}>
            <Icon.Camera size={20} />
          </button>
          <button onClick={() => galleryInputRef.current?.click()} style={{ width: 72, height: 72, borderRadius: 12, background: theme.surface, border: `1.5px dashed ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint, backdropFilter: theme.blur }}>
            <Icon.Image size={20} />
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFiles} />
        <input ref={galleryInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFiles} />

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Materiál</div>
        <MaterialList
          theme={theme} materials={materials} editingIdx={editingMaterialIdx}
          onEdit={setEditingMaterialIdx} onRemove={removeMaterial}
        />
        <MaterialEditor
          theme={theme}
          initial={editingMaterialIdx !== null ? materials[editingMaterialIdx] : null}
          onSubmit={submitMaterial}
          onCancelEdit={() => setEditingMaterialIdx(null)}
        />
        <div style={{ height: 12 }} />
      </div>

      <div style={{ padding: '14px 20px', borderTop: `1px solid ${theme.border}`, background: theme.bg }}>
        <button onClick={save} disabled={!liveEdit && !machine} style={{ width: '100%', background: `linear-gradient(155deg, ${theme.primary} 0%, #4338CA 100%)`, border: 'none', borderRadius: 14, padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#fff', fontSize: 16, fontWeight: 700, boxShadow: `0 6px 20px ${theme.primary}40` }}>
          <Icon.Check size={18} />
          <span>{liveEdit ? 'Uložit rozpracované' : 'Uložit záznam'}</span>
        </button>
      </div>
      {showMachinePicker && (
        <MachinePicker
          theme={theme} db={db}
          onPick={(m) => { setLiveMachine(m); setShowMachinePicker(false); }}
          onCancel={() => setShowMachinePicker(false)}
        />
      )}
    </div>
  );
}

// ============================================================
// YEAR SCREEN — dlaždice měsíců s počty a časem prostojů
// ============================================================
function YearScreen({ theme, db, onBack, onHome, onOpenMonth, onAddRecord, onSearch, refreshTick, initialYear }) {
  const isDesktop = useViewportWidth();
  const [records, setRecords] = useState([]);
  const [year, setYear] = useState(initialYear || new Date().getFullYear());
  // Filtr podle typu opravy — appka používá stejné čtyři kategorie a stejné
  // pořadí/barvy jako SEARCH_TYPE_OPTIONS (appka to tak už filtruje ve
  // vyhledávání), ať je konzistentní napříč appkou. Vypnutý typ (není v
  // activeTypes) appka vynechá jak ze statistik nahoře, tak z dlaždic
  // měsíců — funguje jako živý filtr, ne jen vizuální přepínač.
  const [activeTypes, setActiveTypes] = useState(() => new Set(SEARCH_TYPE_OPTIONS.map(o => o.key)));

  function toggleType(key) {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const load = useCallback(async () => {
    const all = await db.getAll('records');
    setRecords(all);
  }, [db]);

  useEffect(() => { load(); }, [load, refreshTick]);

  const monthsInYear = useMemo(() => {
    const map = {};
    records.forEach(r => {
      const [y, m] = r.date.split('-').map(Number);
      if (y !== year) return;
      const typeKey = r.type === 'EM'
        ? ((r.emSubtype || 'sProstojem') === 'sProstojem' ? 'em-sprostojem' : 'em-bezprostoje')
        : (r.cmSubtype === 'oprava' ? 'cm-oprava' : 'cm-normal');
      if (!activeTypes.has(typeKey)) return;
      if (!map[m]) map[m] = { cm: 0, cmOprava: 0, emSProstojem: 0, emBezProstoje: 0, emTime: 0 };
      if (r.type === 'EM') {
        if (typeKey === 'em-sprostojem') map[m].emSProstojem++; else map[m].emBezProstoje++;
        map[m].emTime += r.downtimeMs ?? (r.endTime - r.startTime);
      } else if (r.cmSubtype === 'oprava') {
        map[m].cmOprava++;
      } else {
        map[m].cm++;
      }
    });
    return map;
  }, [records, year, activeTypes]);

  const yearStats = useMemo(() => {
    let cm = 0, cmOprava = 0, emSProstojem = 0, emBezProstoje = 0;
    Object.values(monthsInYear).forEach(m => { cm += m.cm; cmOprava += m.cmOprava; emSProstojem += m.emSProstojem; emBezProstoje += m.emBezProstoje; });
    return { cm, cmOprava, emSProstojem, emBezProstoje };
  }, [monthsInYear]);

  const availableYears = useMemo(() => {
    const ys = new Set(records.map(r => Number(r.date.split('-')[0])));
    ys.add(new Date().getFullYear());
    return Array.from(ys).sort((a, b) => b - a);
  }, [records]);

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title="Přehled" onBack={onBack} onHome={onHome} onAction={() => onAddRecord(fmtDateKey(Date.now()))} actionIcon={Icon.Plus} onSecondaryAction={() => onSearch({ scope: 'year', year })} secondaryActionIcon={Icon.Search} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, padding: '14px 20px 4px' }}>
        <button
          onClick={() => setYear(y => y - 1)}
          style={{ width: 36, height: 36, borderRadius: 10, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text, backdropFilter: theme.blur }}
        ><Icon.Back size={17} /></button>
        <span style={{ fontSize: 20, fontWeight: 800, color: year === new Date().getFullYear() ? theme.text : theme.textDim, minWidth: 64, textAlign: 'center' }}>{year}</span>
        <button
          onClick={() => setYear(y => y + 1)}
          style={{ width: 36, height: 36, borderRadius: 10, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text, backdropFilter: theme.blur }}
        ><Icon.ChevronRight size={17} /></button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 20px 16px' }}>
        <div style={{ display: 'flex', gap: 8, width: '100%' }}>
          {SEARCH_TYPE_OPTIONS.map(opt => {
            const active = activeTypes.has(opt.key);
            const count = opt.key === 'cm-normal' ? yearStats.cm : opt.key === 'cm-oprava' ? yearStats.cmOprava : opt.key === 'em-sprostojem' ? yearStats.emSProstojem : yearStats.emBezProstoje;
            const { prefix, subtype } = splitTypeLabel(opt.label);
            return (
              <button
                key={opt.key}
                onClick={() => toggleType(opt.key)}
                style={{ flex: 1, padding: '9px 6px 8px', textAlign: 'center', borderRadius: 14, background: theme.surface, border: `1px solid ${theme.border}`, backdropFilter: theme.blur, opacity: active ? 1 : 0.4, transition: 'opacity 0.15s ease', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
              >
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, color: theme[opt.colorKey], background: theme[`${opt.colorKey}Soft`], borderRadius: 6, padding: '1.5px 7px' }}>{prefix}</span>
                <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 17, fontWeight: 800, color: theme.text, lineHeight: 1.1 }}>{count}</div>
                <div style={{ fontSize: 9, color: theme.textFaint, lineHeight: 1.2 }}>{subtype}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: isDesktop ? '18px 20px 20px' : '0 20px 20px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
        {isDesktop && (
          <div style={{ fontSize: 12, fontWeight: 700, color: theme.textFaint, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Měsíce</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: isDesktop ? 'repeat(auto-fit, minmax(190px, 1fr))' : '1fr 1fr', gap: 10 }}>
          {MONTH_NAMES.map((name, idx) => {
            const monthNum = idx + 1;
            const data = monthsInYear[monthNum];
            const hasData = !!data && (data.cm > 0 || data.cmOprava > 0 || data.emSProstojem > 0 || data.emBezProstoje > 0);
            const now = new Date();
            const isFuture = year === now.getFullYear() && monthNum > now.getMonth() + 1;
            const isCurrentMonth = year === now.getFullYear() && monthNum === now.getMonth() + 1;
            return (
              <button
                key={monthNum}
                onClick={() => onOpenMonth(`${year}-${pad(monthNum)}`)}
                style={{
                  background: theme.surface, border: `${isCurrentMonth ? 2 : 1}px solid ${isCurrentMonth ? theme.primary : theme.border}`, borderRadius: 16,
                  padding: isCurrentMonth ? '13px 13px' : '14px 14px', textAlign: 'left', backdropFilter: theme.blur,
                  opacity: isFuture && !hasData ? 0.5 : 1, display: 'flex', flexDirection: 'column',
                  aspectRatio: isDesktop ? '2.2' : undefined, justifyContent: isDesktop ? 'center' : undefined,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: isCurrentMonth ? theme.text : theme.textDim, textTransform: 'capitalize', marginBottom: isDesktop ? (hasData ? 8 : 0) : 8 }}>{name}</div>
                {hasData ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', minHeight: !isDesktop ? 15 : undefined }}>
                    {data.cm > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: theme.cm }}>{data.cm} CM</span>}
                    {data.cmOprava > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: theme.cmAlt }}>{data.cmOprava} CM Opr.</span>}
                    {data.emSProstojem > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: theme.em }}>{data.emSProstojem} EM</span>}
                    {data.emBezProstoje > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: theme.emAlt }}>{data.emBezProstoje} EM</span>}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: theme.textFaint, minHeight: !isDesktop ? 15 : undefined }}>bez záznamů</div>
                )}
              </button>
            );
          })}
        </div>
        {!isDesktop && <div style={{ height: 24 }} />}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MONTH SCREEN — dny v měsíci s opravami
// ============================================================
function MonthScreen({ theme, db, monthKey, onBack, onHome, onOpenDay, onAddRecord, onSearch, refreshTick, onNavigateMonth }) {
  const isDesktop = useViewportWidth();
  const [records, setRecords] = useState([]);
  const [activeTypes, setActiveTypes] = useState(() => new Set(SEARCH_TYPE_OPTIONS.map(o => o.key)));

  function toggleType(key) {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const load = useCallback(async () => {
    const all = await db.getAll('records');
    setRecords(all);
  }, [db]);

  useEffect(() => { load(); }, [load, refreshTick]);

  const daysInMonth = useMemo(() => {
    const map = {};
    records.forEach(r => {
      if (fmtMonthKey(r.startTime) !== monthKey) return;
      const typeKey = r.type === 'EM'
        ? ((r.emSubtype || 'sProstojem') === 'sProstojem' ? 'em-sprostojem' : 'em-bezprostoje')
        : (r.cmSubtype === 'oprava' ? 'cm-oprava' : 'cm-normal');
      if (!activeTypes.has(typeKey)) return;
      if (!map[r.date]) map[r.date] = { cm: 0, cmOprava: 0, emSProstojem: 0, emBezProstoje: 0, items: [] };
      if (typeKey === 'em-sprostojem') map[r.date].emSProstojem++;
      else if (typeKey === 'em-bezprostoje') map[r.date].emBezProstoje++;
      else if (typeKey === 'cm-oprava') map[r.date].cmOprava++;
      else map[r.date].cm++;
      map[r.date].items.push(r);
    });
    return map;
  }, [records, monthKey, activeTypes]);

  const monthStats = useMemo(() => {
    let cm = 0, cmOprava = 0, emSProstojem = 0, emBezProstoje = 0;
    Object.values(daysInMonth).forEach(d => {
      cm += d.cm; cmOprava += d.cmOprava; emSProstojem += d.emSProstojem; emBezProstoje += d.emBezProstoje;
    });
    return { cm, cmOprava, emSProstojem, emBezProstoje };
  }, [daysInMonth]);

  // "+" defaults to today if this is the current month, otherwise the 1st of the shown month.
  function defaultDateForMonth() {
    const todayKey = fmtDateKey(Date.now());
    if (fmtMonthKey(Date.now()) === monthKey) return todayKey;
    return `${monthKey}-01`;
  }

  // Build calendar grid: Monday-first weeks, leading/trailing blanks for alignment.
  const grid = useMemo(() => {
    const [y, m] = monthKey.split('-').map(Number);
    const firstOfMonth = new Date(y, m - 1, 1);
    const daysInMonthCount = new Date(y, m, 0).getDate();
    // getDay(): 0=Sun..6=Sat -> convert to Monday-first index 0=Mon..6=Sun
    const firstWeekday = (firstOfMonth.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonthCount; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }, [monthKey]);

  const todayKey = fmtDateKey(Date.now());
  const weekdayLabels = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
  const isCurrentMonth = monthKey === fmtMonthKey(Date.now());

  // Sousední měsíc jako "YYYY-MM" klíč, pro šipky doleva/doprava.
  function shiftMonthKey(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title="Měsíc" onBack={onBack} onHome={onHome} onAction={() => onAddRecord(defaultDateForMonth())} actionIcon={Icon.Plus} onSecondaryAction={() => onSearch({ scope: 'month', monthKey })} secondaryActionIcon={Icon.Search} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, padding: '10px 20px 4px', flexShrink: 0 }}>
        <button
          onClick={() => onNavigateMonth(shiftMonthKey(monthKey, -1))}
          style={{ width: 36, height: 36, borderRadius: 10, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text, backdropFilter: theme.blur }}
        ><Icon.Back size={17} /></button>
        <span style={{ fontSize: 18, fontWeight: 800, color: isCurrentMonth ? theme.text : theme.textDim, minWidth: 150, textAlign: 'center', textTransform: 'capitalize' }}>{fmtMonthLabel(monthKey)}</span>
        <button
          onClick={() => onNavigateMonth(shiftMonthKey(monthKey, 1))}
          style={{ width: 36, height: 36, borderRadius: 10, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text, backdropFilter: theme.blur }}
        ><Icon.ChevronRight size={17} /></button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 20px 10px', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8, width: '100%' }}>
          {SEARCH_TYPE_OPTIONS.map(opt => {
            const active = activeTypes.has(opt.key);
            const count = opt.key === 'cm-normal' ? monthStats.cm : opt.key === 'cm-oprava' ? monthStats.cmOprava : opt.key === 'em-sprostojem' ? monthStats.emSProstojem : monthStats.emBezProstoje;
            const { prefix, subtype } = splitTypeLabel(opt.label);
            return (
              <button
                key={opt.key}
                onClick={() => toggleType(opt.key)}
                style={{ flex: 1, padding: '8px 6px 7px', textAlign: 'center', borderRadius: 13, background: theme.surface, border: `1px solid ${theme.border}`, backdropFilter: theme.blur, opacity: active ? 1 : 0.4, transition: 'opacity 0.15s ease', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
              >
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, color: theme[opt.colorKey], background: theme[`${opt.colorKey}Soft`], borderRadius: 6, padding: '1.5px 7px' }}>{prefix}</span>
                <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 17, fontWeight: 800, color: theme.text, lineHeight: 1.1 }}>{count}</div>
                <div style={{ fontSize: 9, color: theme.textFaint, lineHeight: 1.2 }}>{subtype}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: isDesktop ? '0 16px 16px' : '4px 16px 20px', display: 'flex', justifyContent: 'center', overflowY: isDesktop ? 'hidden' : 'auto' }}>
        <div style={{
          width: '100%', display: 'flex', flexDirection: 'column', minHeight: isDesktop ? 0 : undefined,
          border: isCurrentMonth ? `1.5px solid ${theme.primary}44` : '1.5px solid transparent',
          borderRadius: 16, padding: isCurrentMonth ? 8 : 0,
        }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginBottom: 6, flexShrink: 0 }}>
          {weekdayLabels.map((label, i) => (
            <div key={label} style={{
              textAlign: 'center', fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
              color: i >= 5 ? theme.textDim : theme.textFaint, padding: '4px 0',
            }}>{label}</div>
          ))}
        </div>
        {/* Na desktopu appka roztáhne týdny přes zbylou výšku (flex+gridTemplateRows),
            ať se celý měsíc i s posledním týdnem vejde bez scrollování — na
            mobilu to appka nedělá, tam zůstávají čtvercové buňky a appka
            radši scrolluje, protože přesné natažení na malou výšku obrazovky
            by dny udělalo nečitelně nízké. */}
        {isDesktop ? (
          <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: `repeat(${grid.length}, 1fr)`, gap: 6 }}>
            {grid.map((week, wi) => (
              <div key={wi} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, minHeight: 0 }}>
                {week.map((day, di) => {
                  if (day === null) return <div key={di} />;
                  const dateKey = `${monthKey}-${pad(day)}`;
                  const info = daysInMonth[dateKey];
                  const isWeekend = di >= 5;
                  const isToday = dateKey === todayKey;
                  const dots = [];
                  if (info) {
                    if (info.cm > 0) dots.push(theme.cm);
                    if (info.cmOprava > 0) dots.push(theme.cmAlt);
                    if (info.emSProstojem > 0) dots.push(theme.em);
                    if (info.emBezProstoje > 0) dots.push(theme.emAlt);
                  }
                  return (
                    <button
                      key={di}
                      onClick={() => onOpenDay(dateKey)}
                      style={{
                        borderRadius: 12, display: 'flex', flexDirection: 'column', minHeight: 44,
                        alignItems: 'center', justifyContent: 'center', gap: 4,
                        background: isWeekend ? theme.bgSubtle : theme.surface,
                        border: isToday ? `1.5px solid ${theme.primary}` : `1px solid ${theme.border}`,
                        backdropFilter: theme.blur,
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: isToday ? 800 : 600, color: isToday ? theme.text : theme.textDim }}>{day}</span>
                      <div style={{ display: 'flex', gap: 4, height: 7 }}>
                        {dots.map((c, i) => <div key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: `0 0 0 1px ${theme.bg}` }} />)}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          grid.map((week, wi) => (
            <div key={wi} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginBottom: 6 }}>
              {week.map((day, di) => {
                if (day === null) return <div key={di} />;
                const dateKey = `${monthKey}-${pad(day)}`;
                const info = daysInMonth[dateKey];
                const isWeekend = di >= 5;
                const isToday = dateKey === todayKey;
                const dots = [];
                if (info) {
                  if (info.cm > 0) dots.push(theme.cm);
                  if (info.cmOprava > 0) dots.push(theme.cmAlt);
                  if (info.emSProstojem > 0) dots.push(theme.em);
                  if (info.emBezProstoje > 0) dots.push(theme.emAlt);
                }
                return (
                  <button
                    key={di}
                    onClick={() => onOpenDay(dateKey)}
                    style={{
                      aspectRatio: '1', borderRadius: 12, display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', gap: 4,
                      background: isWeekend ? theme.bgSubtle : theme.surface,
                      border: isToday ? `1.5px solid ${theme.primary}` : `1px solid ${theme.border}`,
                      backdropFilter: theme.blur,
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: isToday ? 800 : 600, color: isToday ? theme.text : theme.textDim }}>{day}</span>
                    <div style={{ display: 'flex', gap: 4, height: 7 }}>
                      {dots.map((c, i) => <div key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: `0 0 0 1px ${theme.bg}` }} />)}
                    </div>
                  </button>
                );
              })}
            </div>
          ))
        )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// DAY SCREEN — jednotlivé záznamy daného dne
// ============================================================
// Typy filtrovatelné při hledání — kombinace type+subtype, protože appka
// rozlišuje čtyři prakticky odlišné kategorie oprav, ne jen CM/EM.
const SEARCH_TYPE_OPTIONS = [
  { key: 'cm-normal', label: 'CM', colorKey: 'cm', match: r => r.type === 'CM' && (r.cmSubtype || 'normal') === 'normal' },
  { key: 'cm-oprava', label: 'CM Oprava', colorKey: 'cmAlt', match: r => r.type === 'CM' && r.cmSubtype === 'oprava' },
  { key: 'em-sprostojem', label: 'EM s prostojem', colorKey: 'em', match: r => r.type === 'EM' && (r.emSubtype || 'sProstojem') === 'sProstojem' },
  { key: 'em-bezprostoje', label: 'EM bez prostoje', colorKey: 'emAlt', match: r => r.type === 'EM' && r.emSubtype === 'bezProstoje' },
];

// Hledání záznamů podle stroje, volného textu (závada/řešení/WO/materiál) a
// typu opravy — rozsah je buď celý rok, nebo jeden konkrétní měsíc, podle
// toho, odkud bylo hledání otevřeno (YearScreen vs MonthScreen).
function SearchScreen({ theme, db, scope, onBack, onHome, onOpenRecord }) {
  const [allRecords, setAllRecords] = useState([]);
  const [query, setQuery] = useState('');
  const [machine, setMachine] = useState(null);
  const [showMachinePicker, setShowMachinePicker] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState([]); // prázdné = všechny typy

  useEffect(() => {
    db.getAll('records').then(all => {
      const inScope = scope.scope === 'year'
        ? all.filter(r => r.date.startsWith(`${scope.year}-`))
        : all.filter(r => r.date.startsWith(scope.monthKey));
      inScope.sort((a, b) => b.startTime - a.startTime);
      setAllRecords(inScope);
    });
  }, [db, scope]);

  const results = useMemo(() => {
    const q = query.trim().toUpperCase();
    return allRecords.filter(r => {
      if (machine && r.machineId !== machine.id) return false;
      if (selectedTypes.length > 0 && !selectedTypes.some(key => SEARCH_TYPE_OPTIONS.find(t => t.key === key).match(r))) return false;
      if (q) {
        const haystack = [
          r.machineName, r.wo, r.issue, r.solution,
          ...(r.materials || []).map(m => `${m.name || ''} ${m.code || ''}`),
        ].filter(Boolean).join(' ').toUpperCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [allRecords, query, machine, selectedTypes]);

  function toggleType(key) {
    setSelectedTypes(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  }

  const scopeLabel = scope.scope === 'year' ? `rok ${scope.year}` : fmtMonthLabel(scope.monthKey);
  const hasFilters = query.trim() || machine || selectedTypes.length > 0;

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title="Hledat" onBack={onBack} onHome={onHome} />
      <div style={{ padding: '14px 20px 0' }}>
        <div style={{ fontSize: 12, color: theme.textFaint, marginBottom: 12 }}>Prohledává se: {scopeLabel}</div>

        <input
          style={{ width: '100%', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14, padding: '12px 16px', color: theme.text, fontSize: 15, fontFamily: 'inherit', backdropFilter: theme.blur, boxSizing: 'border-box', marginBottom: 10 }}
          placeholder="Hledat text (závada, řešení, WO, materiál)..."
          value={query} onChange={e => setQuery(e.target.value)}
        />

        <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginBottom: 10 }}>
          <button
            onClick={() => setShowMachinePicker(true)}
            style={{ flex: 1, textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14, padding: '12px 16px', color: machine ? theme.text : theme.textFaint, fontSize: 15, backdropFilter: theme.blur, minWidth: 0 }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{machine ? machine.name : 'Vybrat stroj (volitelné)'}</span>
            <Icon.ChevronRight size={15} style={{ color: theme.textFaint, flexShrink: 0, marginLeft: 8 }} />
          </button>
          {machine && (
            <button
              onClick={() => setMachine(null)}
              style={{ width: 44, flexShrink: 0, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint, backdropFilter: theme.blur }}
            >
              <Icon.X size={17} />
            </button>
          )}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {SEARCH_TYPE_OPTIONS.map(opt => {
            const active = selectedTypes.includes(opt.key);
            const c = theme[opt.colorKey];
            const s = theme[`${opt.colorKey}Soft`];
            return (
              <button
                key={opt.key}
                onClick={() => toggleType(opt.key)}
                style={{ background: active ? s : theme.surface, border: `1.5px solid ${active ? c : theme.border}`, borderRadius: 10, padding: '7px 12px', color: active ? c : theme.textDim, fontSize: 12.5, fontWeight: 700 }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {!hasFilters && (
          <div style={{ textAlign: 'center', padding: '32px 20px', color: theme.textFaint, fontSize: 13.5 }}>
            Zadej text, vyber stroj nebo typ opravy pro hledání.
          </div>
        )}
        {hasFilters && results.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 20px', color: theme.textFaint, fontSize: 13.5 }}>
            Žádné záznamy neodpovídají hledání.
          </div>
        )}
        {hasFilters && results.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: theme.textFaint, marginBottom: 10 }}>{results.length} {results.length === 1 ? 'záznam' : results.length < 5 ? 'záznamy' : 'záznamů'}</div>
            {results.map(r => {
              const color = r.type === 'EM' ? (r.emSubtype === 'bezProstoje' ? theme.emAlt : theme.em) : (r.cmSubtype === 'oprava' ? theme.cmAlt : theme.cm);
              const soft = r.type === 'EM' ? (r.emSubtype === 'bezProstoje' ? theme.emAltSoft : theme.emSoft) : (r.cmSubtype === 'oprava' ? theme.cmAltSoft : theme.cmSoft);
              const displayDuration = r.type === 'EM' ? (r.downtimeMs ?? (r.endTime - r.startTime)) : (r.endTime - r.startTime);
              return (
                <button
                  key={r.id}
                  onClick={() => onOpenRecord(r)}
                  style={{
                    display: 'flex', width: '100%', textAlign: 'left', marginBottom: 8,
                    background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 16,
                    overflow: 'hidden', backdropFilter: theme.blur,
                  }}
                >
                  <div style={{ width: 4, background: color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0, padding: '13px 15px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, gap: 10 }}>
                      <span style={{ display: 'block', fontSize: 15.5, fontWeight: 700, color: theme.text, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{r.machineName}</span>
                      <span style={{ fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 7, letterSpacing: 0.4, color, background: soft, flexShrink: 0, marginTop: 1 }}>{r.type}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11.5, fontWeight: 600, color: theme.textFaint }}>{fmtDateLabel(r.date)}</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 500, color: theme.textDim }}>
                        {fmtTime(r.startTime)}–{fmtTime(r.endTime)}
                        <span style={{ color: theme.textFaint }}> · {fmtDurationMin(displayDuration)}</span>
                      </span>
                      {r.wo && (
                        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 10.5, fontWeight: 700, color: theme.textDim, background: theme.surfaceElevated, padding: '2px 7px', borderRadius: 6, letterSpacing: 0.3 }}>
                          WO {r.wo}
                        </span>
                      )}
                    </div>
                    {r.issue && <div style={{ fontSize: 13.5, fontWeight: 600, color, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.issue}</div>}
                    {r.materials?.length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: theme.textFaint, marginTop: 4 }}>
                        <Icon.Wrench size={11} /> {r.materials.map(fmtMaterialLine).join(', ')}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </>
        )}
      </div>

      {showMachinePicker && (
        <MachinePicker
          theme={theme} db={db}
          onPick={(m) => { setMachine(m); setShowMachinePicker(false); }}
          onCancel={() => setShowMachinePicker(false)}
        />
      )}
    </div>
  );
}

function DayScreen({ theme, db, dateKey, onBack, onHome, onOpenRecord, onAddRecord, refreshTick, activeSession, onOpenLivePreview, onOpenLiveEdit }) {
  const [records, setRecords] = useState([]);
  const liveElapsed = useElapsed(activeSession?.startTime, !!activeSession);
  const isToday = dateKey === fmtDateKey(Date.now());

  const load = useCallback(async () => {
    const all = await db.getAll('records');
    all.sort((a, b) => a.startTime - b.startTime);
    setRecords(all.filter(r => r.date === dateKey));
  }, [db, dateKey]);

  useEffect(() => { load(); }, [load, refreshTick]);

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title={fmtDateLabel(dateKey)} onBack={onBack} onHome={onHome} onAction={() => onAddRecord(dateKey)} actionIcon={Icon.Plus} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {isToday && activeSession && (
          <div style={{
            display: 'flex', width: '100%', textAlign: 'left', marginBottom: 8,
            background: theme.emSoft, border: `1.5px solid ${theme.em}66`, borderRadius: 16,
            overflow: 'hidden', backdropFilter: theme.blur,
          }}>
            <button onClick={() => onOpenLivePreview()} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: '13px 15px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, gap: 10 }}>
                <span style={{ display: 'block', fontSize: 15.5, fontWeight: 700, color: theme.text, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                  {activeSession.machineName || 'Bez stroje'}
                </span>
                <span style={{ fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 7, letterSpacing: 0.4, color: theme.em, background: theme.emSoft, flexShrink: 0, marginTop: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: theme.em }} />
                  PRÁVĚ PROBÍHÁ
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 2 }}>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 500, color: theme.textDim }}>
                  od {fmtTime(activeSession.startTime)} · {fmtDuration(liveElapsed)}
                </span>
              </div>
              {activeSession.issue && <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.em, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeSession.issue}</div>}
              {activeSession.photos?.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: theme.textFaint, marginTop: 4 }}><Icon.Image size={12} /> {activeSession.photos.length}</div>}
            </button>
            <button onClick={() => onOpenLiveEdit()} style={{ width: 46, flexShrink: 0, background: 'none', border: 'none', borderLeft: `1px solid ${theme.em}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.em }}>
              <Icon.Edit size={17} />
            </button>
          </div>
        )}
        {records.length === 0 && !(isToday && activeSession) && (
          <div style={{ textAlign: 'center', padding: '48px 20px' }}>
            <div style={{ fontSize: 14, color: theme.textFaint, marginBottom: 16 }}>Tento den žádné záznamy.</div>
            <button
              onClick={() => onAddRecord(dateKey)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: theme.primarySoft, border: `1.5px dashed ${theme.primary}66`, borderRadius: 14, padding: '12px 20px', color: theme.primary, fontSize: 14, fontWeight: 600 }}
            >
              <Icon.Plus size={16} />
              <span>Přidat opravu do tohoto dne</span>
            </button>
          </div>
        )}
        {records.map(r => {
          const color = r.type === 'EM' ? (r.emSubtype === 'bezProstoje' ? theme.emAlt : theme.em) : (r.cmSubtype === 'oprava' ? theme.cmAlt : theme.cm);
          const soft = r.type === 'EM' ? (r.emSubtype === 'bezProstoje' ? theme.emAltSoft : theme.emSoft) : (r.cmSubtype === 'oprava' ? theme.cmAltSoft : theme.cmSoft);
          const displayDuration = r.type === 'EM' ? (r.downtimeMs ?? (r.endTime - r.startTime)) : (r.endTime - r.startTime);
          return (
            <button
              key={r.id}
              onClick={() => onOpenRecord(r)}
              style={{
                display: 'flex', width: '100%', textAlign: 'left', marginBottom: 8,
                background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 16,
                overflow: 'hidden', backdropFilter: theme.blur,
              }}
            >
              <div style={{ width: 4, background: color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0, padding: '13px 15px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, gap: 10 }}>
                  <span style={{ display: 'block', fontSize: 15.5, fontWeight: 700, color: theme.text, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{r.machineName}</span>
                  <span style={{ fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 7, letterSpacing: 0.4, color, background: soft, flexShrink: 0, marginTop: 1 }}>{r.type}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 500, color: theme.textDim }}>
                    {fmtTime(r.startTime)}–{fmtTime(r.endTime)}
                    <span style={{ color: theme.textFaint }}> · {fmtDurationMin(displayDuration)}</span>
                  </span>
                  {r.wo && (
                    <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 10.5, fontWeight: 700, color: theme.textDim, background: theme.surfaceElevated, padding: '2px 7px', borderRadius: 6, letterSpacing: 0.3 }}>
                      WO {r.wo}
                    </span>
                  )}
                </div>
                {r.issue && <div style={{ fontSize: 13.5, fontWeight: 600, color, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.issue}</div>}
                {r.photos?.length > 0 && <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: theme.textFaint, marginTop: 4 }}><Icon.Image size={12} /> {r.photos.length}</div>}
              </div>
            </button>
          );
        })}
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

// ============================================================
// TIME-OF-DAY EDITOR — HH:MM vstup pro editaci start/konec (jen minuty)
// ============================================================
function dateInputValue(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtInputTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Otevře systémový sdílecí dialog (na mobilu obvykle nabídne přímo uložení
// do Fotky/Galerie jako jednu z možností, spolu s WhatsApp/e-mail/atd.).
// Vrací false, pokud sdílení není v tomto prohlížeči dostupné vůbec.
async function sharePhoto(dataUrl, record, index) {
  const dateKey = record?.date || fmtDateKey(Date.now());
  const machineSlug = (record?.machineName || 'stroj').replace(/[^a-zA-Z0-9á-žÁ-Ž]+/g, '-').slice(0, 40);
  const filename = `${machineSlug}-${dateKey}-${index + 1}.jpg`;

  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
    if (!navigator.canShare || !navigator.canShare({ files: [file] })) return false;
    await navigator.share({ files: [file] });
    return true;
  } catch (e) {
    // Uživatel zrušil sdílecí dialog — to není chyba, appka zůstává v detailu.
    return false;
  }
}

// Stáhne fotku jako běžný soubor (do Downloads / vyžádá umístění podle prohlížeče).
async function downloadPhoto(dataUrl, record, index) {
  const dateKey = record?.date || fmtDateKey(Date.now());
  const machineSlug = (record?.machineName || 'stroj').replace(/[^a-zA-Z0-9á-žÁ-Ž]+/g, '-').slice(0, 40);
  const filename = `${machineSlug}-${dateKey}-${index + 1}.jpg`;

  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  } catch (e) {
    return false;
  }
}

// Zkopíruje fotku do schránky, aby šla rovnou vložit (Vložit / dlouhý stisk)
// do zprávy, e-mailu nebo dokumentu. Clipboard API pro obrázky spolehlivě
// podporuje jen image/png napříč prohlížeči, takže fotku (často JPEG z
// fotoaparátu) nejdřív překreslíme na canvas a exportujeme jako PNG.
async function copyPhotoToClipboard(dataUrl) {
  if (!navigator.clipboard || !window.ClipboardItem) return false;
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch (e) {
    return false;
  }
}

// Zkopíruje text do schránky. Nejdřív zkusí moderní Clipboard API; pokud to
// selže (starší mobilní prohlížeče to občas odmítnou i v secure contextu),
// spadne na osvědčený trik s dočasným textarea + execCommand('copy'), který
// funguje mnohem šířeji. Volitelný setFeedback callback dostane true/false.
async function copyTextToClipboard(text, setFeedback) {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {
      ok = false;
    }
  }
  if (setFeedback) {
    setFeedback(ok);
    if (ok) setTimeout(() => setFeedback(false), 1800);
  }
  return ok;
}

// ============================================================
// DATE PICKER SCREEN — výběr konkrétního dne před výběrem stroje
// (používá se při přidávání opravy z přehledu Roku nebo Měsíce)
// ============================================================
function DatePickerScreen({ theme, initialDate, onConfirm, onBack, resolvedThemeName }) {
  const [dateMs, setDateMs] = useState(() => {
    const d = new Date(initialDate);
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  });

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title="Vyber den opravy" onBack={onBack} />
      <div style={{ flex: 1, padding: '20px 20px' }}>
        <Card theme={theme} style={{ padding: 18 }}>
          <DateEditor theme={theme} label="Datum opravy" value={dateMs} onChange={setDateMs} isDark={resolvedThemeName === 'dark'} />
        </Card>
        <div style={{ fontSize: 13, color: theme.textFaint, marginTop: 12, lineHeight: 1.5 }}>
          Čas opravy nastavíš v dalším kroku — teď stačí vybrat den.
        </div>
      </div>
      <div style={{ padding: '14px 20px', borderTop: `1px solid ${theme.border}`, background: theme.bg }}>
        <button
          onClick={() => onConfirm(fmtDateKey(dateMs))}
          style={{ width: '100%', background: `linear-gradient(155deg, ${theme.primary} 0%, #4338CA 100%)`, border: 'none', borderRadius: 14, padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#fff', fontSize: 16, fontWeight: 700, boxShadow: `0 6px 20px ${theme.primary}40` }}
        >
          <span>Pokračovat</span>
          <Icon.ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

function DateEditor({ theme, label, value, onChange, isDark }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: theme.textFaint, marginBottom: 6, fontWeight: 600 }}>{label}</div>
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '10px 12px', backdropFilter: theme.blur }}>
        <input
          type="date"
          value={dateInputValue(value)}
          onChange={e => {
            if (!e.target.value) return;
            const [y, m, d] = e.target.value.split('-').map(Number);
            const nd = new Date(value);
            nd.setFullYear(y, m - 1, d);
            onChange(nd.getTime());
          }}
          style={{ width: '100%', background: 'none', border: 'none', outline: 'none', color: theme.text, fontSize: 15, fontWeight: 600, fontFamily: 'inherit', colorScheme: isDark ? 'dark' : 'light' }}
        />
      </div>
    </div>
  );
}

// Vlastní time picker — nahrazuje nativní <input type="time">, který na
// Android telefonech vyvolá systémový kruhový picker přetékající mimo
// obrazovku appky. Minuty jsou vždy v krocích po 5, ať je výběr rychlý
// a časy zůstávají konzistentně zaokrouhlené.
function CustomTimePicker({ theme, initialValue, onConfirm, onCancel }) {
  const initial = new Date(initialValue);
  const [hour, setHour] = useState(initial.getHours());
  const [minute, setMinute] = useState(Math.round(initial.getMinutes() / 5) * 5 % 60);
  const hourRef = useRef(null);
  const minuteRef = useRef(null);
  const scrollEndTimer = useRef(null);
  const ITEM_H = 44;

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);

  useEffect(() => {
    // Vycentruje scroll na aktuální hodnotu při otevření, bez animace.
    hourRef.current?.scrollTo({ top: hour * ITEM_H, behavior: 'instant' });
    minuteRef.current?.scrollTo({ top: (minute / 5) * ITEM_H, behavior: 'instant' });
  }, []);

  // Kolečko myši na desktopu posílá scroll v mnohem větších a nepravidelnějších
  // krocích než dotykové táhnutí na mobilu, takže počítání za KAŽDÝ scroll
  // event snadno "přeskočí" o víc řádků, než uživatel čekal. Místo toho appka
  // čeká, až scroll na chvíli ustane (debounce), a teprve pak dopočítá a
  // dorovná na nejbližší řádek — jeden spolehlivý výsledek místo řady
  // nepřesných mezikroků.
  function handleScroll(ref, setter, step, max) {
    clearTimeout(scrollEndTimer.current);
    scrollEndTimer.current = setTimeout(() => {
      if (!ref.current) return;
      const idx = Math.round(ref.current.scrollTop / ITEM_H);
      const clamped = Math.max(0, Math.min(max, idx));
      setter(clamped * step);
      ref.current.scrollTo({ top: clamped * ITEM_H, behavior: 'smooth' });
    }, 90);
  }

  function pickHour(h) {
    setHour(h);
    hourRef.current?.scrollTo({ top: h * ITEM_H, behavior: 'smooth' });
  }

  function pickMinute(m) {
    setMinute(m);
    minuteRef.current?.scrollTo({ top: (m / 5) * ITEM_H, behavior: 'smooth' });
  }

  function confirm() {
    const nd = new Date(initialValue);
    nd.setHours(hour, minute, 0, 0);
    onConfirm(nd.getTime());
  }

  return (
    <Portal>
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 90 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: theme.surfaceSolid, border: `1px solid ${theme.borderStrong}`, borderRadius: 22, padding: 20, width: '100%', maxWidth: 300, boxShadow: theme.shadow }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: theme.text, textAlign: 'center', marginBottom: 14 }}>
          {pad(hour)}:{pad(minute)}
        </div>
        <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', gap: 4, height: ITEM_H * 3 }}>
          <div style={{
            position: 'absolute', top: ITEM_H, left: 8, right: 8, height: ITEM_H,
            background: theme.primarySoft, border: `1px solid ${theme.primary}44`, borderRadius: 12, pointerEvents: 'none',
          }} />
          <div
            ref={hourRef}
            onScroll={() => handleScroll(hourRef, setHour, 1, 23)}
            style={{ width: 70, height: ITEM_H * 3, overflowY: 'scroll', scrollSnapType: 'y mandatory', scrollbarWidth: 'none' }}
          >
            <div style={{ height: ITEM_H }} />
            {hours.map(h => (
              <button
                key={h}
                onClick={() => pickHour(h)}
                style={{
                  width: '100%', height: ITEM_H, display: 'flex', alignItems: 'center', justifyContent: 'center', scrollSnapAlign: 'start',
                  fontSize: 20, fontWeight: h === hour ? 700 : 500, fontVariantNumeric: 'tabular-nums',
                  color: h === hour ? theme.text : theme.textFaint, background: 'none', border: 'none',
                }}
              >{pad(h)}</button>
            ))}
            <div style={{ height: ITEM_H }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', fontSize: 20, fontWeight: 700, color: theme.textFaint }}>:</div>
          <div
            ref={minuteRef}
            onScroll={() => handleScroll(minuteRef, setMinute, 5, 11)}
            style={{ width: 70, height: ITEM_H * 3, overflowY: 'scroll', scrollSnapType: 'y mandatory', scrollbarWidth: 'none' }}
          >
            <div style={{ height: ITEM_H }} />
            {minutes.map(m => (
              <button
                key={m}
                onClick={() => pickMinute(m)}
                style={{
                  width: '100%', height: ITEM_H, display: 'flex', alignItems: 'center', justifyContent: 'center', scrollSnapAlign: 'start',
                  fontSize: 20, fontWeight: m === minute ? 700 : 500, fontVariantNumeric: 'tabular-nums',
                  color: m === minute ? theme.text : theme.textFaint, background: 'none', border: 'none',
                }}
              >{pad(m)}</button>
            ))}
            <div style={{ height: ITEM_H }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onCancel} style={{ flex: 1, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px', color: theme.text, fontWeight: 600 }}>Zrušit</button>
          <button onClick={confirm} style={{ flex: 1, background: theme.primary, border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontWeight: 700 }}>Nastavit</button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

// Vlastní number picker (0-99) — stejný vzhled a mechanismus jako
// CustomTimePicker, jen jeden scroll sloupec. Používá se pro zadání počtu
// kusů materiálu.
function NumberPicker({ theme, initialValue, onConfirm, onCancel }) {
  const current = Math.max(0, Math.min(99, initialValue ?? 1));
  const colRef = useRef(null);
  const ITEM_H = 44;
  const numbers = Array.from({ length: 100 }, (_, i) => i);

  useEffect(() => {
    // Vycentruje scroll na aktuální hodnotu při otevření, bez animace.
    const idx = colRef.current?.querySelector(`[data-n="${current}"]`);
    idx?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, []);

  return (
    <Portal>
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 90 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: theme.surfaceSolid, border: `1px solid ${theme.borderStrong}`, borderRadius: 22, padding: 16, width: '100%', maxWidth: 200, boxShadow: theme.shadow }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: theme.textFaint, textAlign: 'center', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Počet kusů
        </div>
        <div ref={colRef} style={{ height: ITEM_H * 4, overflowY: 'auto' }}>
          {numbers.map(n => (
            <button
              key={n}
              data-n={n}
              onClick={() => onConfirm(n)}
              style={{
                width: '100%', height: ITEM_H, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: n === current ? theme.primarySoft : 'none', border: 'none', borderRadius: 10,
                fontSize: 18, fontWeight: n === current ? 700 : 500, fontVariantNumeric: 'tabular-nums',
                color: n === current ? theme.primary : theme.text,
              }}
            >{n}</button>
          ))}
        </div>
      </div>
    </div>
    </Portal>
  );
}

function TimeEditor({ theme, label, value, onChange, isDark }) {
  const [showPicker, setShowPicker] = useState(false);
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 11, color: theme.textFaint, marginBottom: 6, fontWeight: 600 }}>{label}</div>
      <button
        onClick={() => setShowPicker(true)}
        style={{ width: '100%', textAlign: 'left', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '10px 12px', backdropFilter: theme.blur, color: theme.text, fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
      >
        {fmtTime(value)}
      </button>
      {showPicker && (
        <CustomTimePicker
          theme={theme}
          initialValue={value}
          onCancel={() => setShowPicker(false)}
          onConfirm={(newTs) => { onChange(newTs); setShowPicker(false); }}
        />
      )}
    </div>
  );
}

// Formátuje jednu položku materiálu jako řádek "2x SP55235 ŘEMEN" — počet
// se zobrazí jen když je > 0, skladové číslo a název se spojí mezerou.
function fmtMaterialLine(mat) {
  const parts = [];
  if (mat.name) parts.push(mat.name);
  if (mat.code) parts.push(mat.code);
  const label = parts.join(' ');
  return mat.qty > 0 ? `${mat.qty}x ${label}` : label;
}

// Sdílený vstupní formulář pro přidání/editaci jedné položky materiálu —
// tři pole (počet přes vlastní NumberPicker, skladové číslo, název).
// Používá se v RecordForm i RecordDetail, ať je chování na obou místech
// identické. onSubmit dostane { qty, code, name } a formulář se vyprázdní.
function MaterialEditor({ theme, initial, onSubmit, onCancelEdit }) {
  const [qty, setQty] = useState(initial?.qty ?? 1);
  const [code, setCode] = useState(initial?.code ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [showQtyPicker, setShowQtyPicker] = useState(false);

  const canSubmit = qty > 0 && (code.trim() || name.trim());

  function submit() {
    if (!canSubmit) return;
    onSubmit({ qty, code: code.trim(), name: name.trim() });
    if (!initial) { setQty(1); setCode(''); setName(''); }
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ width: 76 }}>
          <div style={{ fontSize: 10.5, color: theme.textFaint, marginBottom: 5, fontWeight: 600 }}>Počet</div>
          <button
            onClick={() => setShowQtyPicker(true)}
            style={{ width: '100%', textAlign: 'center', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '10px 8px', color: theme.text, fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', backdropFilter: theme.blur }}
          >
            {qty}
          </button>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10.5, color: theme.textFaint, marginBottom: 5, fontWeight: 600 }}>Název materiálu</div>
          <input
            style={{ width: '100%', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '10px 12px', color: theme.text, fontSize: 14, fontFamily: 'inherit', backdropFilter: theme.blur, boxSizing: 'border-box' }}
            placeholder="Řemen" value={name} onChange={e => setName(e.target.value.toUpperCase())}
          />
        </div>
      </div>
      <div style={{ fontSize: 10.5, color: theme.textFaint, marginBottom: 5, fontWeight: 600 }}>Skladové číslo</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ flex: 1, background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '10px 12px', color: theme.text, fontSize: 14, fontFamily: 'inherit', backdropFilter: theme.blur, minWidth: 0 }}
          placeholder="SP365655" value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          enterKeyHint="done"
        />
        {initial && (
          <button onClick={onCancelEdit} style={{ width: 44, borderRadius: 12, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint, flexShrink: 0 }}>
            <Icon.X size={18} />
          </button>
        )}
        <button onClick={submit} disabled={!canSubmit} title={initial ? 'Uložit úpravu' : 'Přidat materiál'} style={{ width: 44, borderRadius: 12, background: canSubmit ? theme.primarySoft : theme.surface, border: `1px solid ${canSubmit ? theme.primary : theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: canSubmit ? theme.primary : theme.textFaint, flexShrink: 0 }}>
          {initial ? <Icon.Check size={18} weight="bold" /> : <Icon.Plus size={18} weight="bold" />}
        </button>
      </div>
      {showQtyPicker && (
        <NumberPicker
          theme={theme}
          initialValue={qty}
          onCancel={() => setShowQtyPicker(false)}
          onConfirm={(v) => { setQty(v); setShowQtyPicker(false); }}
        />
      )}
    </div>
  );
}

// Sdílený výpis položek materiálu jako řádky (ne tagy) — každá s tlačítky
// upravit/smazat. Klepnutí na "upravit" nahradí vstupní formulář daty
// položky, ať jde snadno opravit překlep bez nutnosti smazat a přidat znovu.
function MaterialList({ theme, materials, editingIdx, onEdit, onRemove }) {
  if (!materials?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
      {materials.map((mat, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          background: editingIdx === i ? theme.primarySoft : theme.surfaceElevated,
          border: `1px solid ${editingIdx === i ? theme.primary : theme.border}`,
          borderRadius: 10, padding: '9px 8px 9px 12px',
        }}>
          <span style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 7, overflow: 'hidden' }}>
            {mat.qty > 0 && (
              <span style={{ flexShrink: 0, fontSize: 13, fontWeight: 700, color: theme.text, fontVariantNumeric: 'tabular-nums' }}>
                {mat.qty}×
              </span>
            )}
            {mat.name && (
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {mat.name}
              </span>
            )}
            {mat.code && (
              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: theme.textFaint, background: theme.bgSubtle, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '2px 6px', fontVariantNumeric: 'tabular-nums', letterSpacing: 0.3 }}>
                {mat.code}
              </span>
            )}
          </span>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button onClick={() => onEdit(i)} style={{ width: 26, height: 26, borderRadius: 8, background: 'none', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint }}>
              <Icon.Edit size={13} />
            </button>
            <button onClick={() => onRemove(i)} style={{ width: 26, height: 26, borderRadius: 8, background: 'none', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint }}>
              <Icon.Trash size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// RECORD DETAIL — needitovatelné zobrazení + přepnutí na editaci
// ============================================================
function RecordDetail({ theme, db, record, onBack, onHome, onDelete, onUpdated, resolvedThemeName }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(null); // index into view.photos, or null when closed
  const [copyFeedback, setCopyFeedback] = useState(false); // brief "Zkopírováno" confirmation after copy
  const [solutionCopied, setSolutionCopied] = useState(false); // brief confirmation after copying solution text
  const [showMachinePicker, setShowMachinePicker] = useState(false); // overlay for changing the machine while editing
  const [editingMaterialIdx, setEditingMaterialIdx] = useState(null);
  const [viewMaterialEditIdx, setViewMaterialEditIdx] = useState(null); // inline editace materiálu z needitovatelného zobrazení, bez vstupu do celkového editačního módu

  // Draft fields used only while editing
  const [draft, setDraft] = useState(() => ({ ...record }));
  const [downtimeStart, setDowntimeStart] = useState(record.downtimeStart ?? record.startTime);
  const [downtimeEnd, setDowntimeEnd] = useState(record.downtimeEnd ?? (record.downtimeMs != null ? record.startTime + record.downtimeMs : record.endTime));
  const [downtimeTouched, setDowntimeTouched] = useState(false);
  const [editingDowntime, setEditingDowntime] = useState(false);

  useEffect(() => {
    setDraft({ ...record });
    setDowntimeStart(record.downtimeStart ?? record.startTime);
    setDowntimeEnd(record.downtimeEnd ?? (record.downtimeMs != null ? record.startTime + record.downtimeMs : record.endTime));
    setDowntimeTouched(false);
    setEditingDowntime(false);
  }, [record, editing]);

  const view = editing ? draft : record;
  const color = view.type === 'EM' ? (view.emSubtype === 'bezProstoje' ? theme.emAlt : theme.em) : (view.cmSubtype === 'oprava' ? theme.cmAlt : theme.cm);
  const soft = view.type === 'EM' ? (view.emSubtype === 'bezProstoje' ? theme.emAltSoft : theme.emSoft) : (view.cmSubtype === 'oprava' ? theme.cmAltSoft : theme.cmSoft);
  const actualDuration = view.endTime - view.startTime;
  const draftDowntime = editing ? Math.max(0, downtimeEnd - downtimeStart) : null;
  const displayDuration = view.type === 'EM' ? (editing ? draftDowntime : (view.downtimeMs ?? actualDuration)) : actualDuration;

  function updateDraft(patch) {
    setDraft(d => ({ ...d, ...patch }));
  }

  function submitMaterialEdit(mat) {
    const current = draft.materials || [];
    if (editingMaterialIdx !== null) {
      updateDraft({ materials: current.map((m, i) => i === editingMaterialIdx ? mat : m) });
      setEditingMaterialIdx(null);
    } else {
      updateDraft({ materials: [...current, mat] });
    }
  }

  function removeMaterialEdit(idx) {
    updateDraft({ materials: (draft.materials || []).filter((_, i) => i !== idx) });
    if (editingMaterialIdx === idx) setEditingMaterialIdx(null);
  }

  // Úprava/smazání materiálu přímo z needitovatelného zobrazení — uloží se
  // rovnou do databáze bez nutnosti vstoupit do editačního módu celého
  // záznamu. onUpdated appce řekne, ať si znovu načte aktuální data.
  async function submitMaterialFromView(mat) {
    const current = record.materials || [];
    const updatedMaterials = viewMaterialEditIdx !== null
      ? current.map((m, i) => i === viewMaterialEditIdx ? mat : m)
      : [...current, mat];
    const updated = { ...record, materials: updatedMaterials };
    await db.put('records', updated);
    setViewMaterialEditIdx(null);
    onUpdated(updated);
  }

  async function removeMaterialFromView(idx) {
    const updated = { ...record, materials: (record.materials || []).filter((_, i) => i !== idx) };
    await db.put('records', updated);
    if (viewMaterialEditIdx === idx) setViewMaterialEditIdx(null);
    onUpdated(updated);
  }

  // Editace "Od"/"Do" v needitovaném módu posune prostoj stejným způsobem,
  // pokud ho uživatel ještě needitoval ručně — stejná logika jako v RecordForm.
  function updateDraftStartTime(newStart) {
    const delta = newStart - draft.startTime;
    setDraft(d => ({ ...d, startTime: newStart, endTime: Math.max(newStart, d.endTime + delta) }));
    if (!downtimeTouched) {
      setDowntimeStart(s => s + delta);
      setDowntimeEnd(e => e + delta);
    }
  }

  function updateDraftEndTime(newEnd) {
    const delta = newEnd - draft.endTime;
    setDraft(d => ({ ...d, endTime: newEnd }));
    if (!downtimeTouched) {
      setDowntimeEnd(e => e + delta);
    }
  }

  async function saveEdits() {
    const isBezProstoje = draft.type === 'EM' && draft.emSubtype === 'bezProstoje';
    const finalDowntime = draft.type === 'EM' ? (isBezProstoje ? 0 : (downtimeTouched ? Math.max(0, downtimeEnd - downtimeStart) : (draft.downtimeMs ?? (draft.endTime - draft.startTime)))) : null;
    const finalDowntimeStart = draft.type === 'EM' ? (downtimeTouched ? downtimeStart : (draft.downtimeStart ?? draft.startTime)) : null;
    const finalDowntimeEnd = draft.type === 'EM' ? (downtimeTouched ? Math.max(downtimeStart, downtimeEnd) : (draft.downtimeEnd ?? draft.endTime)) : null;
    const updated = {
      ...draft,
      date: fmtDateKey(draft.startTime),
      downtimeMs: finalDowntime,
      downtimeStart: finalDowntimeStart,
      downtimeEnd: finalDowntimeEnd,
      downtimeOverridden: draft.type === 'EM' && (downtimeTouched || draft.downtimeOverridden),
    };
    await db.put('records', updated);
    setEditing(false);
    setEditingDowntime(false);
    onUpdated(updated);
  }

  function cancelEdits() {
    setDraft({ ...record });
    setEditing(false);
    setEditingDowntime(false);
  }

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }))).then(dataUrls => {
      setDraft(d => ({ ...d, photos: [...(d.photos || []), ...dataUrls] }));
    });
    e.target.value = '';
  }

  function removePhoto(idx) {
    updateDraft({ photos: draft.photos.filter((_, i) => i !== idx) });
  }

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader
        theme={theme}
        title={editing ? 'Upravit záznam' : 'Detail záznamu'}
        onBack={editing ? cancelEdits : onBack}
        onHome={editing ? undefined : onHome}
        onAction={editing ? undefined : () => setConfirmDelete(true)}
        actionIcon={editing ? undefined : Icon.Trash}
        actionVariant="danger"
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        <Card theme={theme} style={{ padding: 18, marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: editing ? 12 : 14 }}>
            {editing ? (
              <button
                onClick={() => setShowMachinePicker(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 7, background: theme.surfaceElevated, border: `1px solid ${theme.borderStrong}`, borderRadius: 10, padding: '8px 12px', color: theme.primary }}
              >
                <span style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>{draft.machineName}</span>
                <Icon.Edit size={13} />
              </button>
            ) : (
              <div style={{ fontSize: 18, fontWeight: 700, color: theme.text }}>{view.machineName}</div>
            )}
            {!editing && (
              <span style={{ display: 'inline-block', padding: '5px 12px', borderRadius: 9, fontSize: 12, fontWeight: 700, color, background: soft, whiteSpace: 'nowrap' }}>
                {view.type} · {view.type === 'CM' ? CM_SUBTYPES[view.cmSubtype || 'normal'].label : TYPES.EM.full}
              </span>
            )}
          </div>

          {editing ? (
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint, marginBottom: 6 }}>
                {draft.type === 'CM' && draft.cmSubtype !== 'oprava' ? 'Práce' : 'Oprava'}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <TimeEditor theme={theme} label="Od" value={draft.startTime} onChange={updateDraftStartTime} isDark={resolvedThemeName === 'dark'} />
                <TimeEditor theme={theme} label="Do" value={draft.endTime} onChange={updateDraftEndTime} isDark={resolvedThemeName === 'dark'} />
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1, background: theme.bgSubtle, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '11px 13px' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint, marginBottom: 4 }}>
                  {view.type === 'CM' && view.cmSubtype !== 'oprava' ? 'Práce' : 'Oprava'}
                </div>
                <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 16, fontWeight: 700, color: theme.text }}>{fmtTime(view.startTime)}–{fmtTime(view.endTime)}</div>
                <div style={{ fontSize: 11, color: theme.textFaint, marginTop: 2 }}>{fmtDurationShort(actualDuration)}</div>
              </div>
              {view.type === 'EM' && view.emSubtype !== 'bezProstoje' && (view.downtimeStart != null && view.downtimeEnd != null) && (
                <div style={{ flex: 1, background: theme.emSoft, border: `1px solid ${theme.em}33`, borderRadius: 12, padding: '11px 13px' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.em, opacity: 0.8, marginBottom: 4 }}>Prostoj</div>
                  <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 16, fontWeight: 700, color: theme.em }}>{fmtTime(view.downtimeStart)}–{fmtTime(view.downtimeEnd)}</div>
                  <div style={{ fontSize: 11, color: theme.em, opacity: 0.75, marginTop: 2 }}>{fmtDurationShort(displayDuration)}</div>
                </div>
              )}
            </div>
          )}
        </Card>

        {editing && (
          <>
            <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Typ</div>
            <div style={{ display: 'flex', gap: 10, marginBottom: draft.type === 'CM' ? 12 : 22 }}>
              {Object.entries(TYPES).map(([key, cfg]) => {
                const active = draft.type === key;
                const c = key === 'CM' ? theme.cm : theme.em;
                const s = key === 'CM' ? theme.cmSoft : theme.emSoft;
                return (
                  <button key={key} onClick={() => updateDraft({ type: key, cmSubtype: key === 'CM' ? (draft.cmSubtype || 'normal') : draft.cmSubtype })}
                    style={{ flex: 1, background: active ? s : theme.surface, border: `1.5px solid ${active ? c : theme.border}`, borderRadius: 14, padding: '14px 12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, color: active ? c : theme.textDim, transition: 'all 0.15s ease' }}>
                    <span style={{ fontSize: 16.5, fontWeight: 700 }}>{cfg.label}</span>
                    <span style={{ fontSize: 11 }}>{cfg.desc}</span>
                  </button>
                );
              })}
            </div>

            {draft.type === 'CM' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
                {Object.entries(CM_SUBTYPES).map(([key, cfg]) => {
                  const active = (draft.cmSubtype || 'normal') === key;
                  const c = key === 'normal' ? theme.cm : theme.cmAlt;
                  const s = key === 'normal' ? theme.cmSoft : theme.cmAltSoft;
                  return (
                    <button key={key} onClick={() => updateDraft({ cmSubtype: key })}
                      style={{ flex: 1, background: active ? s : theme.surface, border: `1.5px solid ${active ? c : theme.border}`, borderRadius: 12, padding: '9px 10px', color: active ? c : theme.textDim, fontSize: 12.5, fontWeight: 700, transition: 'all 0.15s ease' }}>
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            )}

            {draft.type === 'EM' && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
                {Object.entries(EM_SUBTYPES).map(([key, cfg]) => {
                  const active = (draft.emSubtype || 'sProstojem') === key;
                  const c = key === 'bezProstoje' ? theme.emAlt : theme.em;
                  const s = key === 'bezProstoje' ? theme.emAltSoft : theme.emSoft;
                  return (
                    <button key={key} onClick={() => updateDraft({ emSubtype: key })}
                      style={{ flex: 1, background: active ? s : theme.surface, border: `1.5px solid ${active ? c : theme.border}`, borderRadius: 12, padding: '9px 10px', color: active ? c : theme.textDim, fontSize: 12.5, fontWeight: 700, transition: 'all 0.15s ease' }}>
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            )}

            {draft.type === 'EM' && (draft.emSubtype || 'sProstojem') === 'sProstojem' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ ...S.fieldLabel, color: theme.textFaint, marginBottom: 0 }}>Prostoj (od–do)</div>
                  {!editingDowntime && (
                    <button onClick={() => setEditingDowntime(true)} style={{ display: 'flex', alignItems: 'center', gap: 5, color: theme.primary, fontSize: 13, fontWeight: 600 }}>
                      <Icon.Edit size={13} />
                      <span>Upravit</span>
                    </button>
                  )}
                </div>
                {editingDowntime ? (
                  <div style={{ marginBottom: 22 }}>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <TimeEditor theme={theme} label="Od" value={downtimeStart} onChange={v => { setDowntimeTouched(true); setDowntimeStart(v); }} isDark={resolvedThemeName === 'dark'} />
                      <TimeEditor theme={theme} label="Do" value={downtimeEnd} onChange={v => { setDowntimeTouched(true); setDowntimeEnd(v); }} isDark={resolvedThemeName === 'dark'} />
                    </div>
                    <div style={{ fontSize: 12, color: theme.textFaint, marginTop: 8 }}>délka prostoje: {fmtDurationMin(Math.max(0, downtimeEnd - downtimeStart))}</div>
                    <button onClick={() => { setEditingDowntime(false); setDowntimeTouched(false); setDowntimeStart(draft.startTime); setDowntimeEnd(draft.endTime); }} style={{ marginTop: 8, fontSize: 13, color: theme.textFaint }}>
                      Zpět na dobu opravy ({fmtDurationShort(actualDuration)})
                    </button>
                  </div>
                ) : (
                  <div style={{ background: theme.emSoft, border: `1px solid ${theme.em}33`, borderRadius: 14, padding: '14px 16px', marginBottom: 22 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: theme.em }}>{fmtDurationShort(draft.downtimeMs ?? actualDuration)}</span>
                    </div>
                    {(downtimeStart != null && downtimeEnd != null) && (
                      <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5, color: theme.textDim, marginTop: 4 }}>
                        {fmtTime(downtimeStart)}–{fmtTime(downtimeEnd)}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Číslo pracovního příkazu (WO)</div>
            <input
              type="tel" inputMode="numeric" pattern="[0-9]*"
              style={{ ...S.textInput, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.text, backdropFilter: theme.blur }}
              value={draft.wo || ''} onChange={e => updateDraft({ wo: e.target.value.replace(/\D/g, '') })} placeholder="např. 4471"
            />

            <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Závada</div>
            <textarea style={{ ...S.textArea, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.text, backdropFilter: theme.blur }} value={draft.issue || ''} onChange={e => updateDraft({ issue: e.target.value })} rows={3} placeholder="Co bylo za problém..." />

            <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Řešení / co bylo uděláno</div>
            <textarea style={{ ...S.textArea, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.text, backdropFilter: theme.blur }} value={draft.solution || ''} onChange={e => updateDraft({ solution: e.target.value })} rows={3} placeholder="Postup opravy..." />

            <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Fotky</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
              {(draft.photos || []).map((p, i) => (
                <div key={i} style={{ position: 'relative', width: 72, height: 72 }}>
                  <img src={p} style={{ width: 72, height: 72, borderRadius: 12, objectFit: 'cover', border: `1px solid ${theme.border}` }} />
                  <button onClick={() => removePhoto(i)} style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: '50%', background: theme.em, border: `2px solid ${theme.bg}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><Icon.X size={12} /></button>
                </div>
              ))}
              <PhotoAddButtons theme={theme} onFiles={handleFiles} />
            </div>

            <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Materiál</div>
            <MaterialList
              theme={theme} materials={draft.materials} editingIdx={editingMaterialIdx}
              onEdit={setEditingMaterialIdx} onRemove={removeMaterialEdit}
            />
            <MaterialEditor
              theme={theme}
              initial={editingMaterialIdx !== null ? (draft.materials || [])[editingMaterialIdx] : null}
              onSubmit={submitMaterialEdit}
              onCancelEdit={() => setEditingMaterialIdx(null)}
            />
          </>
        )}

        {!editing && (
          <>
            {view.wo && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 26 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint }}>WO</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5, fontWeight: 700, color: theme.textDim, background: theme.surfaceElevated, padding: '3px 9px', borderRadius: 7 }}>
                  {view.wo}
                </span>
              </div>
            )}
            {view.issue && (
              <div style={{ marginBottom: 26 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint, marginBottom: 8 }}>Závada</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: theme.text, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{view.issue}</div>
              </div>
            )}
            {view.solution && (
              <div style={{ marginBottom: 26 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint, marginBottom: 8 }}>Řešení</div>
                <div style={{ position: 'relative', background: theme.bgSubtle, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '13px 16px' }}>
                  <button
                    onClick={() => copyTextToClipboard(view.solution, setSolutionCopied)}
                    style={{
                      position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 8,
                      background: solutionCopied ? theme.cmSoft : theme.surfaceElevated,
                      border: `1px solid ${solutionCopied ? theme.cm : theme.border}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: solutionCopied ? theme.cm : theme.textDim,
                    }}
                  >
                    {solutionCopied ? <Icon.Check size={14} weight="bold" /> : <Icon.Copy size={14} />}
                  </button>
                  <div style={{ fontSize: 14.5, fontWeight: 500, color: theme.text, lineHeight: 1.5, whiteSpace: 'pre-wrap', paddingRight: 34 }}>{view.solution}</div>
                </div>
              </div>
            )}
            {view.photos?.length > 0 && (
              <>
                <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Fotky</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 26 }}>
                  {view.photos.map((p, i) => (
                    <img
                      key={i} src={p} onClick={() => setLightboxIndex(i)}
                      style={{ width: 100, height: 100, borderRadius: 14, objectFit: 'cover', border: `1px solid ${theme.border}`, cursor: 'pointer' }}
                    />
                  ))}
                </div>
              </>
            )}
            {view.materials?.length > 0 && (
              <div style={{ marginBottom: 26 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: theme.textFaint, marginBottom: 8 }}>Materiál</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {view.materials.map((mat, i) => (
                    viewMaterialEditIdx === i ? (
                      <MaterialEditor
                        key={i}
                        theme={theme}
                        initial={mat}
                        onSubmit={submitMaterialFromView}
                        onCancelEdit={() => setViewMaterialEditIdx(null)}
                      />
                    ) : (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '10px 14px' }}>
                        <span style={{ flex: 1, display: 'flex', alignItems: 'baseline', gap: 7, overflow: 'hidden' }}>
                          {mat.qty > 0 && (
                            <span style={{ flexShrink: 0, fontSize: 13.5, fontWeight: 700, color: theme.text, fontVariantNumeric: 'tabular-nums' }}>
                              {mat.qty}×
                            </span>
                          )}
                          {mat.name && (
                            <span style={{ fontSize: 13.5, fontWeight: 600, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {mat.name}
                            </span>
                          )}
                          {mat.code && (
                            <span style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 700, color: theme.textFaint, background: theme.bgSubtle, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '2px 6px', fontVariantNumeric: 'tabular-nums', letterSpacing: 0.3 }}>
                              {mat.code}
                            </span>
                          )}
                        </span>
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          <button onClick={() => setViewMaterialEditIdx(i)} style={{ width: 26, height: 26, borderRadius: 8, background: 'none', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint }}>
                            <Icon.Edit size={13} />
                          </button>
                          <button onClick={() => removeMaterialFromView(i)} style={{ width: 26, height: 26, borderRadius: 8, background: 'none', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint }}>
                            <Icon.Trash size={13} />
                          </button>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        <div style={{ height: 24 }} />
      </div>

      <div style={{ padding: '14px 20px', borderTop: `1px solid ${theme.border}`, background: theme.bg }}>
        {editing ? (
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={cancelEdits} style={{ flex: 1, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 14, padding: '15px', color: theme.text, fontWeight: 600 }}>Zrušit</button>
            <button onClick={saveEdits} style={{ flex: 2, background: `linear-gradient(155deg, ${theme.primary} 0%, #4338CA 100%)`, border: 'none', borderRadius: 14, padding: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#fff', fontSize: 15, fontWeight: 700, boxShadow: `0 6px 20px ${theme.primary}40` }}>
              <Icon.Check size={17} />
              <span>Uložit změny</span>
            </button>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} style={{ width: '100%', background: theme.surfaceElevated, border: `1px solid ${theme.borderStrong}`, borderRadius: 14, padding: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: theme.text, fontSize: 15, fontWeight: 700 }}>
            <Icon.Edit size={16} />
            <span>Upravit záznam</span>
          </button>
        )}
      </div>

      {confirmDelete && (
        <div onClick={() => setConfirmDelete(false)} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: theme.surfaceSolid, border: `1px solid ${theme.borderStrong}`, borderRadius: 20, padding: 22, width: '100%', maxWidth: 320, boxShadow: theme.shadow }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, marginBottom: 4 }}>Smazat záznam?</div>
            <div style={{ fontSize: 13, color: theme.textDim, marginBottom: 18 }}>Tato akce se nedá vrátit.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px', color: theme.text, fontWeight: 600 }}>Zrušit</button>
              <button onClick={() => onDelete(record.id)} style={{ flex: 1, background: theme.em, border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontWeight: 700 }}>Smazat</button>
            </div>
          </div>
        </div>
      )}

      {lightboxIndex !== null && view.photos?.[lightboxIndex] && (
        <div
          onClick={() => setLightboxIndex(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
        >
          <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 8, zIndex: 2 }} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={async () => { await sharePhoto(view.photos[lightboxIndex], record, lightboxIndex); }}
              style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
            >
              <Icon.ShareIcon size={19} />
            </button>
            <button
              onClick={async () => {
                const ok = await copyPhotoToClipboard(view.photos[lightboxIndex]);
                if (ok) { setCopyFeedback(true); setTimeout(() => setCopyFeedback(false), 1800); }
              }}
              style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
            >
              <Icon.Copy size={19} />
            </button>
            <button
              onClick={async () => { await downloadPhoto(view.photos[lightboxIndex], record, lightboxIndex); }}
              style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
            >
              <Icon.Download size={19} />
            </button>
            <button
              onClick={() => setLightboxIndex(null)}
              style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
            >
              <Icon.X size={20} weight="bold" />
            </button>
          </div>
          {copyFeedback && (
            <div style={{ position: 'absolute', top: 68, right: 16, fontSize: 12.5, fontWeight: 600, color: '#fff', background: 'rgba(0,0,0,0.75)', padding: '7px 12px', borderRadius: 10, zIndex: 2 }}>
              Zkopírováno do schránky
            </div>
          )}
          {view.photos.length > 1 && (
            <div style={{ position: 'absolute', top: 16, left: 16, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.8)', background: 'rgba(255,255,255,0.1)', padding: '6px 12px', borderRadius: 20 }}>
              {lightboxIndex + 1} / {view.photos.length}
            </div>
          )}
          {view.photos.length > 1 && lightboxIndex > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxIndex(i => i - 1); }}
              style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 2 }}
            >
              <Icon.Back size={20} />
            </button>
          )}
          {view.photos.length > 1 && lightboxIndex < view.photos.length - 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxIndex(i => i + 1); }}
              style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 2 }}
            >
              <Icon.ChevronRight size={20} />
            </button>
          )}
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ZoomableImage src={view.photos[lightboxIndex]} />
          </div>
        </div>
      )}

      {showMachinePicker && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 70, background: theme.bg }}>
          <MachinePicker
            theme={theme}
            db={db}
            onPick={(machine) => {
              updateDraft({ machineId: machine.id, machineName: machine.name });
              setShowMachinePicker(false);
            }}
            onCancel={() => setShowMachinePicker(false)}
          />
        </div>
      )}
    </div>
  );
}

function PhotoAddButtons({ theme, onFiles }) {
  const fileInputRef = useRef(null);
  const galleryInputRef = useRef(null);
  return (
    <>
      <button onClick={() => fileInputRef.current?.click()} style={{ width: 72, height: 72, borderRadius: 12, background: theme.surface, border: `1.5px dashed ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint, backdropFilter: theme.blur }}>
        <Icon.Camera size={20} />
      </button>
      <button onClick={() => galleryInputRef.current?.click()} style={{ width: 72, height: 72, borderRadius: 12, background: theme.surface, border: `1.5px dashed ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint, backdropFilter: theme.blur }}>
        <Icon.Image size={20} />
      </button>
      <input ref={fileInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onFiles} />
      <input ref={galleryInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onFiles} />
    </>
  );
}

// Omezuje šířku formulářových a detailových obrazovek na desktopu, ať se
// dlouhá textová pole a karty nenatahují přes celou širokou obrazovku —
// appka na těchhle obrazovkách nemá vlastní vícesloupcový layout (na rozdíl
// od mřížek jako Stroje/Galerie), takže plná šířka jen zhoršuje čitelnost.
// Na mobilu (isDesktop=false) se chová jako transparentní průchozí wrapper.
function CenteredFormWrap({ isDesktop, maxWidth = 640, children }) {
  if (!isDesktop) return children;
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}

function App() {
  const [db, setDb] = useState(null);
  const [activeTab, setActiveTab] = useState('timer'); // 'timer' | 'history' | 'machines'
  const [stack, setStack] = useState([{ screen: 'home' }]);
  const [activeSession, setActiveSession] = useState(null);
  const [pendingSession, setPendingSession] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [galleryColumns, setGalleryColumns] = useState(3);
  const [machineColumns, setMachineColumns] = useState(3);
  const [googleUser, setGoogleUser] = useState(null); // { email } nebo null
  const [syncState, setSyncState] = useState({ status: 'idle', lastSyncAt: null, msg: null }); // idle|connecting|online|error
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const { mode, setMode, theme, resolvedName: resolvedThemeName } = useTheme();
  const isDesktop = useViewportWidth();
  const liveEditElapsed = useElapsed(activeSession?.startTime, !!activeSession);

  const route = stack[stack.length - 1];
  const atRoot = stack.length === 1;

  useEffect(() => {
    getDB().then(async (database) => {
      setDb(database);
      const sessions = await database.getAll('activeSession');
      if (sessions.length > 0) setActiveSession(sessions[0]);
      const settings = await database.get('settings', 'theme');
      if (settings?.mode) setMode(settings.mode);
      const gallerySettings = await database.get('settings', 'gallery').catch(() => null);
      const machineSettings = await database.get('settings', 'machines').catch(() => null);
      // Na desktopu appka rovnou zobrazí víc sloupců, ať se rozumně využije
      // šířka obrazovky bez nutnosti ručně přepínat — ale jen pokud uživatel
      // ještě nikdy počet sloupců sám nenastavil (jeho volba má přednost).
      const wideDefault = window.innerWidth >= DESKTOP_BREAKPOINT ? 5 : 3;
      setGalleryColumns(gallerySettings?.columns || wideDefault);
      setMachineColumns(machineSettings?.columns || wideDefault);
    });
  }, []);

  // Firebase Auth — appka jen odposlouchává stav přihlášení (samo se drží
  // i po refreshi, žádný ruční token na starost). Jakmile je uživatel
  // přihlášený, napojí se realtime poslech Firestore; při odhlášení se
  // odpojí. Lokální data v IndexedDB se odhlášením nemažou, appka funguje
  // dál offline.
  useEffect(() => {
    if (!db) return;
    const fb = ensureFirebase();
    if (!fb) { setSyncState({ status: 'idle', lastSyncAt: null, msg: null }); return; }
    const unsub = fb.auth.onAuthStateChanged((user) => {
      if (user) {
        setGoogleUser({ email: user.email });
        setSyncState(st => ({ ...st, status: 'connecting', msg: null }));
        cloudSync.startListening(db, user.uid, async (store) => {
          setSyncState({ status: 'online', lastSyncAt: Date.now(), msg: null });
          setRefreshTick(t => t + 1);
          if (store === 'activeSession') {
            const sessions = await db.getAll('activeSession');
            setActiveSession(sessions[0] || null);
          }
        });
      } else {
        cloudSync.stopListening();
        setGoogleUser(null);
        setSyncState({ status: 'idle', lastSyncAt: null, msg: null });
      }
    });
    return () => unsub();
  }, [db]);

  const handleGoogleSignIn = useCallback(async () => {
    setSyncState(st => ({ ...st, status: 'connecting', msg: null }));
    try {
      await cloudSync.signIn();
      // zbytek (nastavení googleUser, napojení poslechu) udělá onAuthStateChanged výše
    } catch (e) {
      setSyncState(st => ({ ...st, status: 'error', msg: e?.message || 'Přihlášení se nezdařilo.' }));
    }
  }, []);

  const handleGoogleSignOut = useCallback(async () => {
    await cloudSync.signOut();
  }, []);

  // Kompletní reset dat tohoto zařízení (stroje, záznamy, kategorie, běžící
  // časomíra). Vzhled a přihlášení zůstávají. Maže se jen lokálně (přes
  // rawDelete, mimo hook co posílá změny do Firestore) a appka si hned
  // potom natáhne aktuální sdílený stav zpátky z cloudu — zařízení se tak
  // jen "vrátí do hry", reset se do cloudu ani na jiná zařízení nepropaguje.
  const handleResetAll = useCallback(async () => {
    if (!db) return;
    for (const s of ['machines', 'records', 'categories', 'activeSession']) {
      const all = await db.getAll(s).catch(() => []);
      for (const e of all) await rawDelete(db, s, e.id);
    }
    setActiveSession(null);
    setRefreshTick(t => t + 1);
    if (cloudSync.uid) await cloudSync.pullAllFromCloud(db);
  }, [db]);

  useEffect(() => {
    // Appka potřebuje aspoň dvě vrstvy v historii prohlížeče hned od startu,
    // jinak první stisk tlačítka/gesta zpět nezachytí náš popstate handler
    // vůbec — prohlížeč appku rovnou opustí, protože žádná "předchozí" vrstva
    // uvnitř appky neexistuje. Tahle extra vrstva se spotřebuje při prvním
    // popstate z kteréhokoli kořene — proto onPop na Timer kořenu musí sám
    // znovu poslat historii zpět (history.back()), aby "zpět" appku skutečně
    // opustilo na první stisk, ne až na druhý.
    window.history.replaceState({ depth: 1 }, '');
    window.history.pushState({ depth: 1 }, '');

    function onPop() {
      setStack(s => {
        if (s.length > 1) return s.slice(0, -1);
        if (activeTabRef.current !== 'timer') {
          // Na kořenu jiné záložky: "zpět" přepne na Timer místo opuštění appky.
          setActiveTab('timer');
          window.history.pushState({ depth: 1 }, '');
          return [{ screen: 'home' }];
        }
        // Na kořenu Timeru: necháváme appku standardně opustit — o vrstvu
        // navíc z inicializace se appka zbaví tím, že pošle historii ještě
        // jednou zpět, což prohlížeč/systém interpretuje jako opuštění appky.
        window.history.back();
        return s;
      });
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function push(screen, params = {}) {
    window.history.pushState({ depth: stackRef.current.length + 1 }, '');
    setStack(s => [...s, { screen, ...params }]);
  }

  // Push more than one screen at once (e.g. jump straight to "today" via month+day)
  // so back navigation still steps through the natural hierarchy.
  function pushMany(entries) {
    entries.forEach(() => window.history.pushState({ depth: stackRef.current.length + 1 }, ''));
    setStack(s => [...s, ...entries]);
  }

  function pop(n = 1) {
    // Only drive navigation via the browser history; the popstate handler below
    // is the single source of truth for removing stack entries, so we don't
    // double-pop by also mutating the stack directly here.
    if (window.history.state && window.history.state.depth > 1) {
      window.history.go(-n);
    } else {
      setStack(s => (s.length > n ? s.slice(0, -n) : [s[0]]));
    }
  }

  // Nahradí parametry aktuální (poslední) položky v navigačním zásobníku, beze
  // změny hloubky historie prohlížeče — používá se při procházení měsíců
  // šipkami uvnitř MonthScreen, ať "zpět" z vnořeného Dne vede na ten měsíc,
  // který je právě zobrazený, ne na ten, kterým appka na MonthScreen vstoupila.
  function replaceTop(params) {
    setStack(s => [...s.slice(0, -1), { ...s[s.length - 1], ...params }]);
  }

  function resetToHome() { setStack([{ screen: 'home' }]); }

  function handleDataRestored() {
    setRefreshTick(t => t + 1);
    setActiveSession(null);
  }

  async function handleSetMode(newMode) {
    setMode(newMode);
    if (db) await db.put('settings', { id: 'theme', mode: newMode });
  }

  async function handleGalleryColumnsChange(cols) {
    setGalleryColumns(cols);
    if (db) await db.put('settings', { id: 'gallery', columns: cols });
  }

  async function handleMachineColumnsChange(cols) {
    setMachineColumns(cols);
    if (db) await db.put('settings', { id: 'machines', columns: cols });
  }

  async function startTimer() {
    const session = { id: 'active', startTime: Date.now(), photos: [] };
    await db.put('activeSession', session);
    setActiveSession(session);
    setRefreshTick(t => t + 1); // ať se spuštěná časomíra propíše i na druhé zařízení
  }

  // Změna běžící časomíry (fotka / materiál / rozpracovaný text). Čte AKTUÁLNÍ
  // stav z IndexedDB (ne ze zastaralé closure), aby rychlá úprava hned po
  // synchronizační echo změně nepřepsala to, co mezitím doplnilo druhé
  // zařízení. `fn` dostane aktuální session a vrátí novou.
  const mutateSession = useCallback(async (fn) => {
    if (!db) return;
    const cur = (await db.getAll('activeSession').catch(() => []))[0];
    if (!cur) return;
    const updated = fn(cur);
    if (!updated) return;
    await db.put('activeSession', updated);
    setActiveSession(updated);
  }, [db]);

  const updateSessionDraft = (patch) => mutateSession(cur => ({ ...cur, ...patch }));
  const addSessionPhoto = (dataUrls) => {
    const newPhotos = Array.isArray(dataUrls) ? dataUrls : [dataUrls];
    return mutateSession(cur => ({ ...cur, photos: [...(cur.photos || []), ...newPhotos] }));
  };
  const removeSessionPhoto = (idx) => mutateSession(cur => ({ ...cur, photos: (cur.photos || []).filter((_, i) => i !== idx) }));
  const addSessionMaterial = (mat) => mutateSession(cur => ({ ...cur, materials: [...(cur.materials || []), mat] }));
  const updateSessionMaterial = (idx, mat) => mutateSession(cur => ({ ...cur, materials: (cur.materials || []).map((m, i) => i === idx ? mat : m) }));
  const removeSessionMaterial = (idx) => mutateSession(cur => ({ ...cur, materials: (cur.materials || []).filter((_, i) => i !== idx) }));

  async function stopTimer() {
    const endTime = Date.now();
    const draft = {
      startTime: activeSession.startTime, endTime,
      photos: activeSession.photos || [], materials: activeSession.materials || [],
      type: activeSession.type, cmSubtype: activeSession.cmSubtype, emSubtype: activeSession.emSubtype,
      wo: activeSession.wo, issue: activeSession.issue, solution: activeSession.solution,
    };
    setPendingSession(draft);
    await db.delete('activeSession', 'active');
    setActiveSession(null);
    setRefreshTick(t => t + 1); // ať zastavená časomíra zmizí i na druhém zařízení
    // Stroj zadaný už za běhu timeru appka nenechá vybírat znovu — jde
    // rovnou do zbytku formuláře, předvyplněného vším, co bylo zadané živě.
    if (activeSession.machineId) {
      push('recordForm', { machine: { id: activeSession.machineId, name: activeSession.machineName } });
    } else {
      push('pickMachine');
    }
  }

  // Ruční přidání opravy zpětně do libovolného (i minulého) dne, z obrazovky dne.
  // Datum je tam už jasné, takže jde rovnou na výběr stroje.
  function startBackfill(dateKey) {
    setPendingSession(null);
    push('pickMachine', { backfillDate: dateKey });
  }

  // Z přehledu Roku/Měsíce datum ještě není jasné, takže nejdřív ukážeme
  // výběr konkrétního dne a teprve po potvrzení pokračujeme na výběr stroje.
  function startBackfillWithPicker(defaultDateKey) {
    setPendingSession(null);
    push('datePicker', { defaultDateKey });
  }

  function onMachinePicked(machine, backfillDate) {
    if (backfillDate) {
      push('recordForm', { machine, initialDate: backfillDate });
    } else {
      push('recordForm', { machine });
    }
  }

  function onRecordSaved() {
    setPendingSession(null);
    setRefreshTick(t => t + 1);
    resetToHome();
  }

  function onRecordSavedToDay() {
    setRefreshTick(t => t + 1);
    returnFromBackfill();
  }

  function onRecordFormCancel() {
    setPendingSession(null);
    resetToHome();
  }

  function onBackfillCancel(isBackfill) {
    if (isBackfill) {
      returnFromBackfill();
    } else {
      resetToHome();
    }
  }

  // Drop back to whichever screen (day/month/year) we were on before entering
  // the datePicker/pickMachine/recordForm backfill flow, by popping those off the stack.
  function returnFromBackfill() {
    setStack(s => {
      const backfillScreens = new Set(['datePicker', 'pickMachine', 'recordForm']);
      let idx = s.length;
      while (idx > 0 && backfillScreens.has(s[idx - 1].screen)) idx--;
      return idx > 0 ? s.slice(0, idx) : [s[0]];
    });
  }

  async function deleteRecord(id) {
    await db.delete('records', id);
    setRefreshTick(t => t + 1);
    pop(1);
  }

  function onRecordUpdated(updated) {
    setRefreshTick(t => t + 1);
    // replace the record in the current stack entry so the detail view reflects the save
    setStack(s => s.map(entry => (entry.screen === 'recordDetail' && entry.record?.id === updated.id) ? { ...entry, record: updated } : entry));
  }

  if (!db) return <div style={{ ...S.loadingScreen, background: theme.bg, color: theme.textDim }}>Načítání...</div>;

  const todayKey = fmtDateKey(Date.now());

  function goToTodayInHistory() {
    push('day', { dateKey: todayKey });
  }

  function switchTab(tab) {
    setActiveTab(tab);
    const rootEntry =
      tab === 'history' ? { screen: 'year' } :
      tab === 'machines' ? { screen: 'machines' } :
      tab === 'gallery' ? { screen: 'gallery' } :
      { screen: 'home' };
    // Collapse browser history back to a single depth-1 entry so hardware/gesture
    // back behaves like "leave the app" from any tab's root, consistent with push/pop.
    window.history.replaceState({ depth: 1 }, '');
    setStack([rootEntry]);
  }

  return (
    <div style={{ height: '100vh', background: theme.bg, transition: 'background 0.2s ease', display: 'flex', flexDirection: isDesktop ? 'row' : 'column' }}>
      {isDesktop && (
        <SideNav theme={theme} activeTab={activeTab} onSwitch={switchTab} onOpenSettings={() => push('settings')}
          googleUser={googleUser} syncState={syncState} onSyncClick={() => cloudSync.reconnect()} />
      )}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {route.screen === 'home' && (
          <HomeScreen
            theme={theme}
            db={db}
            activeSession={activeSession}
            onStart={startTimer}
            onStop={stopTimer}
            onOpenSettings={() => push('settings')}
            onOpenToday={goToTodayInHistory}
            onOpenRecord={(r) => push('recordDetail', { record: r })}
            onAddPhoto={addSessionPhoto}
            onRemovePhoto={removeSessionPhoto}
            onAddMaterial={addSessionMaterial}
            onUpdateMaterial={updateSessionMaterial}
            onRemoveMaterial={removeSessionMaterial}
            isDesktop={isDesktop}
            refreshTick={refreshTick}
            googleUser={googleUser}
            syncState={syncState}
            onSyncClick={() => cloudSync.reconnect()}
          />
        )}
        {route.screen === 'machines' && (
          <MachinesScreen
            theme={theme} db={db} refreshTick={refreshTick}
            machineColumns={machineColumns} onMachineColumnsChange={handleMachineColumnsChange}
            onOpenMachine={(m) => push('machineForm', { machine: m })}
            onOpenCategory={(c) => push('categoryForm', { category: c })}
            onCreateMachine={() => push('machineForm', { machine: null })}
            onCreateCategory={() => push('categoryForm', { category: null })}
            onDataChanged={() => setRefreshTick(t => t + 1)}
          />
        )}
        {route.screen === 'machineForm' && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <MachineFormScreen
              theme={theme} db={db} machine={route.machine}
              onBack={() => pop(1)}
              onSaved={() => { setRefreshTick(t => t + 1); pop(1); }}
              onDeleted={() => { setRefreshTick(t => t + 1); pop(1); }}
            />
          </CenteredFormWrap>
        )}
        {route.screen === 'categoryForm' && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <CategoryFormScreen
              theme={theme} db={db} category={route.category}
              onBack={() => pop(1)}
              onSaved={() => { setRefreshTick(t => t + 1); pop(1); }}
              onDeleted={() => { setRefreshTick(t => t + 1); pop(1); }}
            />
          </CenteredFormWrap>
        )}
        {route.screen === 'gallery' && (
          <GalleryScreen
            theme={theme} db={db} refreshTick={refreshTick}
            onOpenRecord={(r) => push('recordDetail', { record: r, fromGallery: true })}
            columns={galleryColumns} onColumnsChange={handleGalleryColumnsChange}
          />
        )}
        {route.screen === 'settings' && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <SettingsScreen theme={theme} mode={mode} setMode={handleSetMode} onBack={() => pop(1)} db={db} onDataRestored={handleDataRestored}
              googleUser={googleUser} syncState={syncState}
              onGoogleSignIn={handleGoogleSignIn} onGoogleSignOut={handleGoogleSignOut} onResetAll={handleResetAll} />
          </CenteredFormWrap>
        )}
        {route.screen === 'datePicker' && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <DatePickerScreen
              theme={theme}
              initialDate={route.defaultDateKey}
              onConfirm={(dateKey) => push('pickMachine', { backfillDate: dateKey })}
              onBack={() => onBackfillCancel(true)}
              resolvedThemeName={resolvedThemeName}
            />
          </CenteredFormWrap>
        )}
        {route.screen === 'pickMachine' && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <MachinePicker
              theme={theme} db={db}
              onPick={(machine) => onMachinePicked(machine, route.backfillDate)}
              onCancel={() => (route.backfillDate ? onBackfillCancel(true) : onRecordFormCancel())}
            />
          </CenteredFormWrap>
        )}
        {route.screen === 'recordForm' && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <RecordForm
              theme={theme} db={db}
              session={route.initialDate ? null : pendingSession}
              initialDate={route.initialDate}
              machine={route.machine}
              onSave={route.initialDate ? () => onRecordSavedToDay(route.initialDate) : onRecordSaved}
              onCancel={route.initialDate ? () => onBackfillCancel(true) : onRecordFormCancel}
              resolvedThemeName={resolvedThemeName}
            />
          </CenteredFormWrap>
        )}
        {route.screen === 'livePreview' && activeSession && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <LivePreview
              theme={theme} session={activeSession} liveElapsed={liveEditElapsed}
              onBack={() => pop(1)} onHome={() => switchTab('timer')}
              onEdit={() => replaceTop({ screen: 'liveEdit' })}
              onUpdateMaterial={updateSessionMaterial} onRemoveMaterial={removeSessionMaterial}
            />
          </CenteredFormWrap>
        )}
        {route.screen === 'liveEdit' && activeSession && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <RecordForm
              theme={theme} db={db}
              session={activeSession}
              liveEdit
              onLiveSave={updateSessionDraft}
              liveElapsed={fmtDuration(liveEditElapsed)}
              onSave={() => pop(1)}
              onCancel={() => pop(1)}
              resolvedThemeName={resolvedThemeName}
            />
          </CenteredFormWrap>
        )}
        {route.screen === 'year' && (
          <CenteredFormWrap isDesktop={isDesktop} maxWidth={900}>
            <YearScreen theme={theme} db={db} onBack={atRoot ? undefined : () => pop(1)} onHome={() => switchTab('timer')} onOpenMonth={(monthKey) => push('month', { monthKey })} onAddRecord={startBackfillWithPicker} onSearch={(scope) => push('search', { scope })} refreshTick={refreshTick} />
          </CenteredFormWrap>
        )}
        {route.screen === 'month' && (
          <CenteredFormWrap isDesktop={isDesktop} maxWidth={900}>
            <MonthScreen theme={theme} db={db} monthKey={route.monthKey} onBack={() => pop(1)} onHome={() => switchTab('timer')} onOpenDay={(dateKey) => push('day', { dateKey })} onAddRecord={startBackfillWithPicker} onSearch={(scope) => push('search', { scope })} refreshTick={refreshTick} onNavigateMonth={(mk) => replaceTop({ monthKey: mk })} />
          </CenteredFormWrap>
        )}
        {route.screen === 'day' && (
          <CenteredFormWrap isDesktop={isDesktop} maxWidth={900}>
            <DayScreen theme={theme} db={db} dateKey={route.dateKey} onBack={() => pop(1)} onHome={() => switchTab('timer')} onOpenRecord={(r) => push('recordDetail', { record: r })} onAddRecord={startBackfill} refreshTick={refreshTick} activeSession={activeSession} onOpenLivePreview={() => push('livePreview')} onOpenLiveEdit={() => push('liveEdit')} />
          </CenteredFormWrap>
        )}
        {route.screen === 'search' && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <SearchScreen theme={theme} db={db} scope={route.scope} onBack={() => pop(1)} onHome={() => switchTab('timer')} onOpenRecord={(r) => push('recordDetail', { record: r })} />
          </CenteredFormWrap>
        )}
        {route.screen === 'recordDetail' && (
          <CenteredFormWrap isDesktop={isDesktop}>
            <RecordDetail theme={theme} db={db} record={route.record} onBack={() => pop(1)} onHome={() => switchTab('timer')} onDelete={deleteRecord} onUpdated={onRecordUpdated} resolvedThemeName={resolvedThemeName} />
          </CenteredFormWrap>
        )}
      </div>
      {isDesktop && !(route.screen === 'day' && route.dateKey === fmtDateKey(Date.now())) && (
        <TodayPanel
          theme={theme} db={db} refreshTick={refreshTick} activeSession={activeSession}
          onOpenRecord={(r) => push('recordDetail', { record: r })}
          onOpenLivePreview={() => push('livePreview')}
          onOpenLiveEdit={() => push('liveEdit')}
          onOpenToday={goToTodayInHistory}
          onAddRecord={startBackfill}
        />
      )}
      {atRoot && !isDesktop && (
        <TabBar theme={theme} activeTab={activeTab} onSwitch={switchTab} />
      )}
    </div>
  );
}

// Postranní menu pro desktop layout — nahrazuje TabBar na širokých
// obrazovkách (nad DESKTOP_BREAKPOINT). Stejné čtyři záložky, svisle vlevo,
// s logem appky a nastavením nahoře, ať se navigace nemusí hledat na dvou
// různých místech podle šířky okna.
// Barva ikony synchronizace podle stavu — sdílená pro postranní i spodní menu.
// idle = odhlášen (ikona se nezobrazí), connecting = právě se připojuje,
// online = živě synchronizováno, error = spojení se nepovedlo.
function syncColor(theme, status) {
  if (status === 'error') return theme.em;
  return theme.primary;
}

// Ikona/tlačítko synchronizace do menu. Zobrazí se jen když je uživatel
// přihlášený ke cloudu. Klik = zkusí znovu navázat spojení (užitečné po
// výpadku); jinak jen ukazuje stav — appka jinak synchronizuje sama.
function SyncMenuButton({ theme, googleUser, syncState, onClick, variant }) {
  if (!googleUser) return null;
  const st = syncState?.status;
  const col = syncColor(theme, st);
  const spin = st === 'connecting' ? { animation: 'spin 0.8s linear infinite' } : null;
  const title = st === 'connecting' ? 'Připojuji…' : st === 'error' ? 'Spojení se nezdařilo — ťukni pro nové zkusit' : 'Synchronizováno';
  if (variant === 'icon') {
    return (
      <button onClick={onClick} title={title}
        style={{ width: 42, height: 42, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', background: st === 'error' ? theme.primarySoft : 'none', border: 'none', color: col }}>
        <span style={{ display: 'inline-flex', ...spin }}><Icon.Refresh size={19} /></span>
      </button>
    );
  }
  if (variant === 'tab') {
    return (
      <button onClick={onClick} title={title}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '10px 0 8px', color: col, background: 'none', border: 'none' }}>
        <span style={{ display: 'inline-flex', ...spin }}><Icon.Refresh size={21} /></span>
        <span style={{ fontSize: 10.5, fontWeight: 500 }}>Sync</span>
      </button>
    );
  }
  return (
    <button onClick={onClick} title={title}
      style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', borderRadius: 11, background: st === 'error' ? theme.primarySoft : 'none', border: 'none', color: col, textAlign: 'left' }}>
      <span style={{ display: 'inline-flex', ...spin }}><Icon.Refresh size={19} /></span>
      <span style={{ fontSize: 14, fontWeight: 500 }}>Obnovit</span>
    </button>
  );
}

function SideNav({ theme, activeTab, onSwitch, onOpenSettings, googleUser, syncState, onSyncClick }) {
  const tabs = [
    { key: 'timer', label: 'Timer', icon: Icon.Clock },
    { key: 'history', label: 'Historie', icon: Icon.Calendar },
    { key: 'gallery', label: 'Galerie', icon: Icon.Image },
    { key: 'machines', label: 'Stroje', icon: Icon.Wrench },
  ];
  return (
    <div style={{
      width: 232, flexShrink: 0, display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${theme.border}`, background: theme.surfaceSolid,
      padding: '20px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px', marginBottom: 28 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: theme.primarySoft, border: `1px solid ${theme.primary}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.primary, flexShrink: 0 }}>
          <Icon.Wrench size={16} weight="fill" />
        </div>
        <span style={{ fontSize: 15, fontWeight: 700, color: theme.text, whiteSpace: 'nowrap' }}>Deník údržbáře</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {tabs.map(tab => {
          const active = activeTab === tab.key;
          const IconComp = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => onSwitch(tab.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', borderRadius: 11,
                background: active ? theme.primarySoft : 'none', border: 'none',
                color: active ? theme.primary : theme.textDim, textAlign: 'left',
              }}
            >
              <IconComp size={19} weight={active ? 'fill' : 'regular'} />
              <span style={{ fontSize: 14, fontWeight: active ? 700 : 500 }}>{tab.label}</span>
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      <SyncMenuButton theme={theme} googleUser={googleUser} syncState={syncState} onClick={onSyncClick} />
      <button
        onClick={onOpenSettings}
        style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', borderRadius: 11, background: 'none', border: 'none', color: theme.textDim, textAlign: 'left' }}
      >
        <Icon.Settings size={19} />
        <span style={{ fontSize: 14, fontWeight: 500 }}>Nastavení</span>
      </button>
    </div>
  );
}

// Postranní panel s dnešními opravami — na desktopu vždy viditelný napravo,
// nezávisle na tom, na jaké obrazovce appka zrovna je (Timer/Historie/
// Galerie/Stroje), stejně jako SideNav vlevo. Zahrnuje i živou kartu
// "Právě probíhá", pokud běží timer, hned nad hotovými dnešními záznamy.
function TodayPanel({ theme, db, refreshTick, activeSession, onOpenRecord, onOpenLivePreview, onOpenLiveEdit, onOpenToday, onAddRecord }) {
  const [todayRecords, setTodayRecords] = useState([]);
  const liveElapsed = useElapsed(activeSession?.startTime, !!activeSession);
  // collapsed = ručně zasunuto (přetrvává, dokud znovu neklikneš na šipku).
  // autoHide = ikona oka vypnutá — panel se pak řídí najetím myši místo
  // ručního stavu: v klidu zasunutý, po hoveru se vysune, po opuštění zase
  // zpátky. Aktivní oko (autoHide=false) = panel zůstává trvale vidět.
  // openWidth je šířka panelu v otevřeném stavu, jde ji natáhnout
  // tažením za úchyt. Všechno tři se ukládá do settings, ať appka nezapomene
  // volbu po refreshi — stejný vzor jako appka má pro téma nebo počet
  // sloupců mřížky.
  const [collapsed, setCollapsed] = useState(false);
  const [autoHide, setAutoHide] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [openWidth, setOpenWidth] = useState(320);
  const [isDragging, setIsDragging] = useState(false);
  const [handlePressed, setHandlePressed] = useState(false);
  const dragRef = useRef({ startX: 0, startWidth: 320 });

  useEffect(() => {
    if (!db) return;
    db.get('settings', 'todayPanel').then(result => {
      if (result) {
        setCollapsed(!!result.collapsed);
        setAutoHide(!!result.autoHide);
        if (result.openWidth) setOpenWidth(result.openWidth);
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [db]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    if (db) db.put('settings', { id: 'todayPanel', collapsed: next, autoHide, openWidth });
  }

  function toggleAutoHide() {
    const next = !autoHide;
    setAutoHide(next);
    if (db) db.put('settings', { id: 'todayPanel', collapsed, autoHide: next, openWidth });
  }

  // Tažení za úchyt mění openWidth živě (appka reaguje okamžitě, žádná
  // animace při tažení — ta je jen pro klikací zasouvání/rozbalování).
  // Šířka je omezená mezi 260 a 560px, ať panel nezmizí ani nezabere
  // nesmyslně moc místa. Appka poslouchá mousemove/mouseup na celém oknu,
  // ne jen na úchytu — tažení jinak přestane fungovat, jakmile kurzor
  // sjede mimo malý úchyt během rychlého pohybu myši.
  useEffect(() => {
    if (!isDragging) return;
    function handleMouseMove(e) {
      const delta = dragRef.current.startX - e.clientX;
      if (Math.abs(delta) > 3) dragRef.current.moved = true;
      const next = Math.max(260, Math.min(560, dragRef.current.startWidth + delta));
      setOpenWidth(next);
    }
    function handleMouseUp() {
      setIsDragging(false);
      setOpenWidth(current => {
        if (db) db.put('settings', { id: 'todayPanel', collapsed, autoHide, openWidth: current });
        return current;
      });
    }
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, db, collapsed, autoHide]);

  function startDrag(e) {
    if (!isOpen) return; // v zasunutém stavu nemá tažení smysl, panel se otevírá jen klikem na šipku
    dragRef.current = { startX: e.clientX, startWidth: openWidth, moved: false };
    setIsDragging(true);
  }

  useEffect(() => {
    if (!db) return;
    const todayKey = fmtDateKey(Date.now());
    db.getAll('records').then(all => {
      const todays = all.filter(r => r.date === todayKey);
      todays.sort((a, b) => b.startTime - a.startTime);
      setTodayRecords(todays);
    });
  }, [db, refreshTick, activeSession]);

  // Šířka panelu podle stavu: auto-hide zasunutý = úzký pruh, dokud nenajedeš
  // myší; ručně zasunutý = stejný úzký pruh, ale bez reakce na myš; jinak
  // otevřená šířka (výchozí 320px, nebo ta, na kterou si appku natáhl
  // tažením). Appka mění jen šířku (ne display:none), ať jde plynule
  // animovat přes CSS transition — kromě samotného tažení, to musí být
  // okamžité, jinak by odezva na pohyb myši opožďovala za kurzorem.
  const isOpen = autoHide ? hovering : !collapsed;
  const width = isOpen ? openWidth : 44;

  if (!loaded) return <div style={{ width: 320, flexShrink: 0, borderLeft: `1px solid ${theme.border}` }} />;

  const liveCount = activeSession ? 1 : 0;
  const totalCount = todayRecords.length + liveCount;

  return (
    <div
      onMouseEnter={() => autoHide && setHovering(true)}
      onMouseLeave={() => autoHide && setHovering(false)}
      style={{
        width, flexShrink: 0, borderLeft: `1px solid ${theme.border}`,
        transition: isDragging ? 'none' : 'width 0.22s ease', display: 'flex', flexDirection: 'column', position: 'relative',
      }}
    >
      {/* Tažitelný pruh přes celou výšku levého okraje panelu — jde za něj
          chytit kdekoliv (kromě šipky, ta zůstává jen pro klik) a roztáhnout
          panel do libovolné šířky. Šipka dole má vlastní menší tažitelnou
          plochu jen kvůli zpětné kompatibilitě jejího vzhledu, ale hlavní
          úchyt pro tažení je teď tenhle pruh. */}
      <div
        onMouseDown={startDrag}
        style={{
          position: 'absolute', top: 0, bottom: 0, left: -4, width: 8, zIndex: 1,
          cursor: isOpen ? 'ew-resize' : 'default',
        }}
      />
      {/* Úchyt (šipka) na levém okraji panelu — vždy vertikálně vycentrovaný
          na hranici mezi panelem a hlavním obsahem, ať je panel v jakémkoliv
          stavu (otevřený, zasunutý, auto-hide). Klik zasune/rozbalí panel;
          pokud je zapnuté auto-hide, klik ho zároveň vypne, ať panel po
          otevření zůstane trvale otevřený místo aby se hned zase sám
          zavřel při odjezdu myši. Šipka se otáčí podle aktuálního stavu a
          při kliknutí lehce "pruží" (scale), ať má akce hmatatelnou odezvu.
          Tažení řeší samostatný pruh nad touto šipkou, ne ona sama — jinak
          by šipka reagovala na tažení i mimo svou malou plochu nekonzistentně. */}
      <button
        onClick={() => {
          setHandlePressed(true);
          setTimeout(() => setHandlePressed(false), 160);
          if (autoHide) {
            setAutoHide(false);
            setCollapsed(false);
            if (db) db.put('settings', { id: 'todayPanel', collapsed: false, autoHide: false, openWidth });
          } else {
            toggleCollapsed();
          }
        }}
        title={isOpen ? 'Zasunout panel' : 'Otevřít panel'}
        style={{
          position: 'absolute', top: '50%', left: -12, transform: `translateY(-50%) scale(${handlePressed ? 0.85 : 1})`, transition: 'transform 0.16s ease',
          width: 22, height: 40, borderRadius: 8, zIndex: 2, cursor: 'pointer',
          background: theme.surfaceElevated, border: `1px solid ${theme.borderStrong}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint,
          boxShadow: theme.shadow,
        }}
      >
        <Icon.ChevronRight size={13} style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
      </button>
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {!isOpen && (
        // Sbalený stav ukazuje jen malý odznak s počtem a tečku (probíhá
        // oprava) — samotné otevírání/zavírání teď řeší úchyt na levém
        // okraji panelu (níž), ne tlačítko uvnitř sbaleného pruhu.
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 24, gap: 10 }}>
          {totalCount > 0 && (
            <span style={{ fontSize: 10.5, fontWeight: 800, color: theme.primary, background: theme.primarySoft, borderRadius: 8, padding: '2px 6px', fontVariantNumeric: 'tabular-nums' }}>
              {totalCount}
            </span>
          )}
          {activeSession && <span style={{ width: 7, height: 7, borderRadius: '50%', background: theme.em, animation: 'livePulse 1.4s ease-in-out infinite' }} />}
        </div>
      )}
      <div style={{ width: openWidth, padding: '24px 22px', overflowY: isOpen ? 'auto' : 'hidden', flex: 1, opacity: isOpen ? 1 : 0, pointerEvents: isOpen ? 'auto' : 'none', transition: isDragging ? 'none' : 'opacity 0.15s ease' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <button
            onClick={onOpenToday}
            style={{ fontSize: 13, fontWeight: 700, color: theme.textFaint, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap', background: 'none', border: 'none', padding: 0 }}
          >
            Dnešní opravy
          </button>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button
              onClick={() => onAddRecord(fmtDateKey(Date.now()))}
              title="Přidat opravu do dnešního dne"
              style={{ width: 24, height: 24, borderRadius: 7, background: 'none', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint }}
            >
              <Icon.Plus size={15} />
            </button>
            <button
              onClick={toggleAutoHide}
              title={autoHide ? 'Panel se skrývá — klikni, ať zůstává vidět' : 'Panel zůstává vidět'}
              style={{ width: 24, height: 24, borderRadius: 7, background: autoHide ? 'none' : theme.primarySoft, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: autoHide ? theme.textFaint : theme.primary }}
            >
              <Icon.Eye size={14} weight={autoHide ? 'regular' : 'fill'} />
            </button>
          </div>
        </div>
        {!activeSession && todayRecords.length === 0 ? (
          <button
            onClick={() => onAddRecord(fmtDateKey(Date.now()))}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', background: theme.primarySoft, border: `1.5px dashed ${theme.primary}66`, borderRadius: 14, padding: '14px 12px', color: theme.primary, fontSize: 13, fontWeight: 600 }}
          >
            <Icon.Plus size={15} />
            <span>Přidat opravu do tohoto dne</span>
          </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {activeSession && (
            <div style={{
              display: 'flex', width: '100%',
              background: theme.emSoft, border: `1.5px solid ${theme.em}66`, borderRadius: 14,
              overflow: 'hidden', backdropFilter: theme.blur,
            }}>
              <button onClick={() => onOpenLivePreview()} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                    {activeSession.machineName || 'Bez stroje'}
                  </span>
                  <span style={{ fontSize: 9.5, fontWeight: 800, padding: '2px 7px', borderRadius: 6, letterSpacing: 0.3, color: theme.em, background: theme.emSoft, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: theme.em }} />
                    PROBÍHÁ
                  </span>
                </div>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11.5, color: theme.textDim }}>
                  od {fmtTime(activeSession.startTime)} · {fmtDuration(liveElapsed)}
                </span>
                {activeSession.issue && <div style={{ fontSize: 12, fontWeight: 600, color: theme.em, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeSession.issue}</div>}
              </button>
              <button onClick={() => onOpenLiveEdit()} style={{ width: 38, flexShrink: 0, background: 'none', border: 'none', borderLeft: `1px solid ${theme.em}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.em }}>
                <Icon.Edit size={15} />
              </button>
            </div>
          )}
          {todayRecords.map(r => {
            const color = r.type === 'EM' ? (r.emSubtype === 'bezProstoje' ? theme.emAlt : theme.em) : (r.cmSubtype === 'oprava' ? theme.cmAlt : theme.cm);
            const soft = r.type === 'EM' ? (r.emSubtype === 'bezProstoje' ? theme.emAltSoft : theme.emSoft) : (r.cmSubtype === 'oprava' ? theme.cmAltSoft : theme.cmSoft);
            const displayDuration = r.type === 'EM' ? (r.downtimeMs ?? (r.endTime - r.startTime)) : (r.endTime - r.startTime);
            return (
              <button
                key={r.id}
                onClick={() => onOpenRecord(r)}
                style={{
                  display: 'flex', width: '100%', textAlign: 'left',
                  background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14,
                  overflow: 'hidden', backdropFilter: theme.blur,
                }}
              >
                <div style={{ width: 4, background: color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{r.machineName}</span>
                    <span style={{ fontSize: 9.5, fontWeight: 800, padding: '2px 7px', borderRadius: 6, letterSpacing: 0.3, color, background: soft, flexShrink: 0 }}>{r.type}</span>
                  </div>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11.5, color: theme.textDim }}>
                    {fmtTime(r.startTime)}–{fmtTime(r.endTime)} · {fmtDurationMin(displayDuration)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
      </div>
      </div>
    </div>
  );
}

function TabBar({ theme, activeTab, onSwitch }) {
  const tabs = [
    { key: 'timer', label: 'Timer', icon: Icon.Clock },
    { key: 'history', label: 'Historie', icon: Icon.Calendar },
    { key: 'gallery', label: 'Galerie', icon: Icon.Image },
    { key: 'machines', label: 'Stroje', icon: Icon.Wrench },
  ];
  return (
    <div style={{
      display: 'flex', borderTop: `1px solid ${theme.border}`, background: theme.surfaceSolid,
      paddingBottom: 'env(safe-area-inset-bottom)', flexShrink: 0,
    }}>
      {tabs.map(tab => {
        const active = activeTab === tab.key;
        const IconComp = tab.icon;
        return (
          <button
            key={tab.key}
            onClick={() => onSwitch(tab.key)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              padding: '10px 0 8px', color: active ? theme.primary : theme.textFaint,
              background: 'none', border: 'none',
            }}
          >
            <IconComp size={21} weight={active ? 'fill' : 'regular'} />
            <span style={{ fontSize: 10.5, fontWeight: active ? 700 : 500 }}>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// Ořízne název stroje na 8 znaků pro zobrazení v bloku mřížky — dlouhé
// vlastní názvy jinak roztahují buňky mřížky do nekonzistentních rozměrů.
// Plný název zůstává vidět v detailu stroje a v pickeru při zápisu opravy.
function truncateMachineName(name) {
  if (!name) return '';
  return name.length > 8 ? name.slice(0, 8) + '…' : name;
}

function MachinesScreen({ theme, db, refreshTick, machineColumns, onMachineColumnsChange, onOpenMachine, onOpenCategory, onCreateMachine, onCreateCategory, onDataChanged }) {
  const isDesktop = useViewportWidth();
  const [machines, setMachines] = useState([]);
  const [categories, setCategories] = useState([]);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [showColumnsMenu, setShowColumnsMenu] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showTip, setShowTip] = useState(false);
  // Vlastní touch-friendly drag-and-drop postavený na Pointer Events, protože
  // nativní HTML5 Drag and Drop API (draggable/onDragStart/onDrop) nefunguje
  // na dotykových zařízeních — Chrome/Firefox/Samsung Internet pro Android
  // nevystřelují DragEvent z prstu, jen z myši/trackpadu. Pointer Events
  // fungují shodně na myši i dotyku.
  const [dragState, setDragState] = useState(null); // { type, id, x, y, overKey }
  const dragStateRef = useRef(null);
  const itemRectsRef = useRef(new Map()); // key ("machine:id" | "category:id") -> DOMRect

  // Jednorázová nápověda: stroje založené rychle v pickeru po STOP dostanou
  // jen jméno a jdou do Nezařazené — nikde jinde se člověk nedozví, že si tu
  // může doladit ikonu, barvu, kategorii, poznámky a fotky. Ukáže se jen
  // jednou při prvním vstupu do téhle záložky, pak se zapamatuje v settings.
  useEffect(() => {
    db.get('settings', 'machinesTipSeen').then(result => {
      if (!result) setShowTip(true);
    }).catch(() => setShowTip(true));
  }, [db]);

  function dismissTip() {
    setShowTip(false);
    db.put('settings', { id: 'machinesTipSeen', seen: true });
  }

  const load = useCallback(async () => {
    const [allMachines, allCategories] = await Promise.all([db.getAll('machines'), db.getAll('categories')]);
    setMachines(allMachines);
    setCategories(allCategories);
  }, [db]);

  useEffect(() => { load(); }, [load, refreshTick]);

  // Skupiny: každá skutečná kategorie + jedna pevná "Nezařazené" na konci.
  // V abecedním režimu se kategorie i stroje uvnitř řadí podle jména; ve
  // vlastním režimu se řadí podle uloženého pole "order" (nastaveného drag-and-drop).
  const groups = useMemo(() => {
    const byCategory = new Map();
    categories.forEach(c => byCategory.set(c.id, { category: c, items: [] }));
    const uncategorized = { category: null, items: [] };
    machines.forEach(m => {
      const bucket = m.categoryId && byCategory.has(m.categoryId) ? byCategory.get(m.categoryId) : uncategorized;
      bucket.items.push(m);
    });
    const sortFn = (a, b) => a.name.localeCompare(b.name, 'cs');
    const list = Array.from(byCategory.values());
    list.forEach(g => g.items.sort(sortFn));
    list.sort((a, b) => sortFn(a.category, b.category));
    uncategorized.items.sort(sortFn);
    list.push(uncategorized);
    return list;
  }, [machines, categories]);

  function toggleCollapse(id) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Přesune stroj na pozici cílového stroje uvnitř dané skupiny (kategorie
  // nebo Nezařazené), případně stroj přeřadí do jiné skupiny, pokud tam byl přetažen.
  async function moveMachine(draggedId, targetGroupCategoryId, targetMachineId) {
    const draggedMachine = machines.find(m => m.id === draggedId);
    if (!draggedMachine) return;
    const groupItems = machines
      .filter(m => (m.categoryId || null) === targetGroupCategoryId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const withoutDragged = groupItems.filter(m => m.id !== draggedId);
    const targetIdx = targetMachineId ? withoutDragged.findIndex(m => m.id === targetMachineId) : withoutDragged.length;
    const insertAt = targetIdx === -1 ? withoutDragged.length : targetIdx;
    withoutDragged.splice(insertAt, 0, { ...draggedMachine, categoryId: targetGroupCategoryId });
    for (let i = 0; i < withoutDragged.length; i++) {
      const m = withoutDragged[i];
      await db.put('machines', { ...m, categoryId: targetGroupCategoryId, order: i });
    }
    load();
    onDataChanged?.();
  }

  // Long-press (250ms) na blok stroje zahájí jeho tažení mezi kategoriemi.
  // Během tažení sledujeme pointer a přes elementFromPoint zjišťujeme, nad
  // kterým prvkem (označeným data-drop-key) se prst/kurzor právě nachází.
  // Kategorie samotné se nepřetahují — jejich pořadí je vždy abecední.
  const longPressRef = useRef(null);
  const dragJustFinishedRef = useRef(false);

  const dragStartPointRef = useRef(null);

  function startDragTracking(type, id, e) {
    if (type === 'category') return;
    const point = e.touches ? e.touches[0] : e;
    const startX = point.clientX, startY = point.clientY;
    dragStartPointRef.current = { x: startX, y: startY };
    longPressRef.current = setTimeout(() => {
      const state = { type, id, x: startX, y: startY, overKey: null };
      dragStateRef.current = state;
      setDragState(state);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 250);
  }

  // Pokud se prst při čekání na long-press posune o víc než pár pixelů,
  // je to scroll gesto, ne úmysl přetáhnout blok — zrušíme čekající timer,
  // ať prohlížeč může scrollovat normálně místo zablokování gesta.
  function handleDragCandidateMove(e) {
    if (!longPressRef.current || !dragStartPointRef.current) return;
    const point = e.touches ? e.touches[0] : e;
    const dx = Math.abs(point.clientX - dragStartPointRef.current.x);
    const dy = Math.abs(point.clientY - dragStartPointRef.current.y);
    if (dx > 8 || dy > 8) cancelDragStart();
  }

  function cancelDragStart() {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
    dragStartPointRef.current = null;
  }

  function handlePointerMoveGlobal(e) {
    if (!dragStateRef.current) return;
    e.preventDefault?.();
    const point = e.touches ? e.touches[0] : e;
    const el = document.elementFromPoint(point.clientX, point.clientY);
    const dropTarget = el?.closest('[data-drop-key]');
    const overKey = dropTarget?.getAttribute('data-drop-key') || null;
    const next = { ...dragStateRef.current, x: point.clientX, y: point.clientY, overKey };
    dragStateRef.current = next;
    setDragState(next);
  }

  async function handlePointerUpGlobal() {
    cancelDragStart();
    const state = dragStateRef.current;
    dragStateRef.current = null;
    setDragState(null);
    if (!state) return;
    // Drag skutečně proběhl (state existoval), takže click event, co po něm
    // prohlížeč pošle, nemá otevřít detail stroje — jen zavřít krátké okno.
    dragJustFinishedRef.current = true;
    setTimeout(() => { dragJustFinishedRef.current = false; }, 50);
    if (!state.overKey) return;
    const [dropType, dropId] = state.overKey.split(':');
    if (state.type === 'machine') {
      if (dropType === 'group' || dropType === 'category') {
        const targetCategoryId = dropId === UNCATEGORIZED_ID ? null : dropId;
        await moveMachine(state.id, targetCategoryId, null);
      } else if (dropType === 'machine' && dropId !== state.id) {
        const targetMachine = machines.find(m => m.id === dropId);
        if (targetMachine) await moveMachine(state.id, targetMachine.categoryId || null, dropId);
      }
    }
  }

  useEffect(() => {
    if (!dragState) return;
    window.addEventListener('pointermove', handlePointerMoveGlobal, { passive: false });
    window.addEventListener('pointerup', handlePointerUpGlobal);
    window.addEventListener('pointercancel', handlePointerUpGlobal);
    return () => {
      window.removeEventListener('pointermove', handlePointerMoveGlobal);
      window.removeEventListener('pointerup', handlePointerUpGlobal);
      window.removeEventListener('pointercancel', handlePointerUpGlobal);
    };
  }, [dragState, machines, categories]);

  const columnOptions = [2, 3, 4, 5, 6];

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <div style={{ padding: '22px 20px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: theme.text }}>Stroje</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <IconButton theme={theme} onClick={() => setShowAddMenu(v => !v)}><Icon.Plus size={18} /></IconButton>
            {showAddMenu && (
              <>
                <div onClick={() => setShowAddMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
                <div style={{
                  position: 'absolute', top: 46, right: 0, zIndex: 40, background: theme.surfaceSolid,
                  border: `1px solid ${theme.borderStrong}`, borderRadius: 14, padding: 6, boxShadow: theme.shadow,
                  display: 'flex', flexDirection: 'column', minWidth: 180,
                }}>
                  <button onClick={() => { setShowAddMenu(false); onCreateMachine(); }} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 10px', borderRadius: 9, background: 'none', border: 'none', color: theme.text, fontSize: 14, fontWeight: 600 }}>
                    <Icon.Wrench size={16} /><span>Nový stroj</span>
                  </button>
                  <button onClick={() => { setShowAddMenu(false); onCreateCategory(); }} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 10px', borderRadius: 9, background: 'none', border: 'none', color: theme.text, fontSize: 14, fontWeight: 600 }}>
                    <Icon.CatFolder size={16} /><span>Nová kategorie</span>
                  </button>
                </div>
              </>
            )}
          </div>
          <div style={{ position: 'relative' }}>
            <IconButton theme={theme} onClick={() => setShowColumnsMenu(v => !v)}><Icon.Bar size={18} /></IconButton>
            {showColumnsMenu && (
              <>
                <div onClick={() => setShowColumnsMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
                <div style={{
                  position: 'absolute', top: 46, right: 0, zIndex: 40, background: theme.surfaceSolid,
                  border: `1px solid ${theme.borderStrong}`, borderRadius: 14, padding: 6, boxShadow: theme.shadow,
                  display: 'flex', flexDirection: 'column', minWidth: 140,
                }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: theme.textFaint, padding: '8px 10px 4px' }}>
                    Sloupců v mřížce
                  </div>
                  {columnOptions.map(n => (
                    <button
                      key={n}
                      onClick={() => { onMachineColumnsChange(n); setShowColumnsMenu(false); }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 10px', borderRadius: 9,
                        background: machineColumns === n ? theme.primarySoft : 'none', border: 'none',
                        color: machineColumns === n ? theme.primary : theme.text, fontSize: 14, fontWeight: machineColumns === n ? 700 : 500,
                      }}
                    >
                      <span>{n} {n === 1 ? 'sloupec' : n < 5 ? 'sloupce' : 'sloupců'}</span>
                      {machineColumns === n && <Icon.Check size={14} weight="bold" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {showTip && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, margin: '0 16px 14px',
          background: theme.primarySoft, border: `1px solid ${theme.primary}44`, borderRadius: 14, padding: '12px 14px',
        }}>
          <div style={{ color: theme.primary, flexShrink: 0, marginTop: 1 }}><Icon.MachSparkle size={16} /></div>
          <div style={{ flex: 1, fontSize: 12.5, color: theme.text, lineHeight: 1.5 }}>
            Klepnutím na stroj mu můžeš nastavit <strong>ikonu, barvu, kategorii, poznámky i fotky</strong>.
          </div>
          <button onClick={dismissTip} style={{ background: 'none', border: 'none', color: theme.textFaint, flexShrink: 0 }}>
            <Icon.X size={15} />
          </button>
        </div>
      )}

      {machines.length === 0 && categories.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 30px', gap: 10 }}>
          <div style={{ color: theme.textFaint }}><Icon.Wrench size={32} /></div>
          <div style={{ fontSize: 14, color: theme.textFaint, textAlign: 'center' }}>Zatím žádné stroje. Přidej první přes tlačítko +.</div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 20px' }}>
          {groups.map(group => {
            const groupId = group.category ? group.category.id : UNCATEGORIZED_ID;
            const isCollapsed = collapsed.has(groupId);
            const cat = group.category;
            const catColor = cat ? (cat.color || theme.textDim) : theme.textFaint;
            const CatIconComp = cat && cat.icon && Icon[cat.icon] ? Icon[cat.icon] : null;
            // Prázdné "Nezařazené" nezobrazujeme (nemá smysl, není to skutečná
            // kategorie k editaci), ale prázdné skutečné kategorie ZŮSTÁVAJÍ
            // vidět — jinak by do nich nikdy nešlo nic přidat.
            if (group.items.length === 0 && !cat) return null;
            const groupDropKey = `group:${groupId}`;
            const isGroupDropTarget = dragState?.overKey === groupDropKey;
            return (
              <div
                key={groupId}
                data-drop-key={groupDropKey}
                style={{ marginBottom: 20, borderRadius: 14, outline: isGroupDropTarget ? `2px dashed ${theme.primary}` : 'none', outlineOffset: 4, transition: 'outline 0.1s ease' }}
              >
                <div
                  data-drop-key={cat ? `category:${cat.id}` : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '9px 12px', borderRadius: 12,
                    background: dragState?.overKey === `category:${cat?.id}` ? theme.primarySoft : theme.surface,
                    border: `1px solid ${dragState?.overKey === `category:${cat?.id}` ? theme.primary : theme.border}`,
                    borderLeft: cat ? `3px solid ${catColor}` : `1px solid ${theme.border}`,
                    backdropFilter: theme.blur,
                  }}
                >
                  <button onClick={() => toggleCollapse(groupId)} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', color: theme.textFaint, transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)', transition: 'transform 0.15s ease' }}>
                      <Icon.ChevronRight size={13} />
                    </div>
                    {CatIconComp && (
                      <div style={{ color: catColor, display: 'flex' }}>
                        <CatIconComp size={15} weight="fill" />
                      </div>
                    )}
                    <span style={{ fontSize: 14, fontWeight: 700, color: cat ? catColor : theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cat ? cat.name : 'Nezařazené'}
                    </span>
                    <span style={{ fontSize: 11.5, color: theme.textFaint, fontWeight: 500 }}>({group.items.length})</span>
                  </button>
                  {cat && (
                    <button onClick={() => onOpenCategory(cat)} style={{ background: 'none', border: 'none', color: theme.textFaint }}>
                      <Icon.Edit size={14} />
                    </button>
                  )}
                </div>
                {!isCollapsed && (
                  <div style={{ display: 'grid', gridTemplateColumns: isDesktop ? `repeat(${machineColumns}, minmax(0, 220px))` : `repeat(${machineColumns}, 1fr)`, gap: 7 }}>
                    {group.items.map(m => {
                      const machineDropKey = `machine:${m.id}`;
                      const isMachineDropTarget = dragState?.overKey === machineDropKey && dragState?.id !== m.id;
                      const isBeingDragged = dragState?.type === 'machine' && dragState?.id === m.id;
                      const MIconComp = m.icon && Icon[m.icon] ? Icon[m.icon] : null;
                      const mColor = m.color || null;
                      return (
                        <button
                          key={m.id}
                          data-drop-key={machineDropKey}
                          onClick={() => { if (!dragJustFinishedRef.current) onOpenMachine(m); }}
                          onPointerDown={(e) => startDragTracking('machine', m.id, e)}
                          onPointerMove={handleDragCandidateMove}
                          onPointerUp={cancelDragStart}
                          onPointerLeave={cancelDragStart}
                          style={{
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
                            width: '100%', minWidth: 0, aspectRatio: '2.3', padding: '7px 5px', borderRadius: 12,
                            background: isMachineDropTarget ? theme.primarySoft : (mColor ? `${mColor}14` : theme.surface),
                            border: `1px solid ${isMachineDropTarget ? theme.primary : (mColor ? `${mColor}4A` : theme.border)}`,
                            backdropFilter: theme.blur, textAlign: 'center', boxSizing: 'border-box',
                            opacity: isBeingDragged ? 0.4 : 1,
                            touchAction: isBeingDragged ? 'none' : 'pan-y',
                          }}
                        >
                          {MIconComp && (
                            <div style={{ color: mColor || theme.textDim, display: 'flex' }}>
                              <MIconComp size={isDesktop ? 16 : (machineColumns <= 3 ? 15 : 12)} weight="fill" />
                            </div>
                          )}
                          <div style={{ fontSize: isDesktop ? 13 : (machineColumns <= 3 ? 11.5 : 10), fontWeight: 600, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', minWidth: 0 }}>
                            {isDesktop ? m.name : truncateMachineName(m.name)}
                          </div>
                          {m.photos?.length > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: isDesktop ? 10.5 : 9, color: theme.textFaint }}>
                              <Icon.Image size={isDesktop ? 10 : 9} /><span>{m.photos.length}</span>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {dragState && (() => {
        const draggedMachine = dragState.type === 'machine' ? machines.find(m => m.id === dragState.id) : null;
        const draggedCategory = dragState.type === 'category' ? categories.find(c => c.id === dragState.id) : null;
        const label = draggedMachine?.name || draggedCategory?.name || '';
        return (
          <div style={{
            position: 'fixed', left: dragState.x, top: dragState.y, transform: 'translate(-50%, -50%)',
            pointerEvents: 'none', zIndex: 90, background: theme.primary, color: '#fff', fontSize: 12.5, fontWeight: 700,
            padding: '8px 14px', borderRadius: 10, boxShadow: theme.shadow, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {label}
          </div>
        );
      })()}
    </div>
  );
}

// Formulář pro vytvoření/editaci kategorie strojů: název, barva a ikona.
function CategoryFormScreen({ theme, db, category, onBack, onSaved, onDeleted }) {
  const isNew = !category;
  const [name, setName] = useState(category?.name || '');
  const [color, setColor] = useState(category?.color ?? null);
  const [icon, setIcon] = useState(category?.icon ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const IconPreview = icon ? Icon[icon] : null;

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const record = {
      id: category?.id || uid(),
      name: trimmed, color, icon,
      order: category?.order ?? Date.now(),
      createdAt: category?.createdAt || Date.now(),
    };
    await db.put('categories', record);
    onSaved(record);
  }

  async function performDelete() {
    if (!category) return;
    // Stroje v této kategorii se přesunou zpět do Nezařazené, ne se nesmažou.
    const machines = await db.getAll('machines');
    const affected = machines.filter(m => m.categoryId === category.id);
    for (const m of affected) await db.put('machines', { ...m, categoryId: null });
    await db.delete('categories', category.id);
    onDeleted();
  }

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader
        theme={theme}
        title={isNew ? 'Nová kategorie' : 'Upravit kategorii'}
        onBack={onBack}
        onAction={!isNew ? () => setConfirmDelete(true) : undefined}
        actionIcon={!isNew ? Icon.Trash : undefined}
        actionVariant="danger"
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Název kategorie</div>
        <input
          style={{ ...S.textInput, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.text, backdropFilter: theme.blur }}
          placeholder="např. Jeřáby" value={name} onChange={e => setName(e.target.value)}
        />

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Náhled</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 22, padding: '13px 16px', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14 }}>
          {IconPreview ? <IconPreview size={18} weight="fill" /> : <div style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px dashed ${theme.textFaint}` }} />}
          <span style={{ fontSize: 15, fontWeight: 700, color: color || theme.text }}>{name.trim() || 'Název kategorie'}</span>
        </div>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Barva</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 22 }}>
          <button
            onClick={() => setColor(null)}
            title="Žádná barva"
            style={{
              width: 38, height: 38, borderRadius: '50%', background: theme.surface, border: !color ? `3px solid ${theme.text}` : `1.5px dashed ${theme.textFaint}`,
              boxShadow: !color ? `0 0 0 2px ${theme.bg}` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint,
            }}
          >
            <Icon.X size={14} weight="bold" />
          </button>
          {CATEGORY_COLORS.map(c => (
            <button
              key={c}
              onClick={() => setColor(c)}
              style={{
                width: 38, height: 38, borderRadius: '50%', background: c, border: color === c ? `3px solid ${theme.text}` : '3px solid transparent',
                boxShadow: color === c ? `0 0 0 2px ${theme.bg}` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {color === c && <Icon.Check size={15} weight="bold" />}
            </button>
          ))}
        </div>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Ikona</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 24 }}>
          <button
            onClick={() => setIcon(null)}
            title="Žádná ikona"
            style={{
              aspectRatio: '1', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: !icon ? theme.primarySoft : theme.surface, border: `1.5px solid ${!icon ? theme.primary : theme.border}`,
              color: !icon ? theme.primary : theme.textDim,
            }}
          >
            <Icon.X size={17} weight="bold" />
          </button>
          {SHARED_ICONS.map(iconKey => {
            const IconComp = Icon[iconKey];
            const active = icon === iconKey;
            return (
              <button
                key={iconKey}
                onClick={() => setIcon(iconKey)}
                style={{
                  aspectRatio: '1', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: active ? `${color}26` : theme.surface, border: `1.5px solid ${active ? color : theme.border}`,
                  color: active ? color : theme.textDim,
                }}
              >
                <IconComp size={19} />
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: '14px 20px', borderTop: `1px solid ${theme.border}`, background: theme.bg }}>
        <button onClick={save} disabled={!name.trim()} style={{ width: '100%', background: name.trim() ? `linear-gradient(155deg, ${theme.primary} 0%, #4338CA 100%)` : theme.surfaceElevated, border: 'none', borderRadius: 14, padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: name.trim() ? '#fff' : theme.textFaint, fontSize: 16, fontWeight: 700 }}>
          <Icon.Check size={18} />
          <span>{isNew ? 'Vytvořit kategorii' : 'Uložit změny'}</span>
        </button>
      </div>

      {confirmDelete && (
        <div onClick={() => setConfirmDelete(false)} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: theme.surfaceSolid, border: `1px solid ${theme.borderStrong}`, borderRadius: 20, padding: 22, width: '100%', maxWidth: 320, boxShadow: theme.shadow }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, marginBottom: 4 }}>Smazat kategorii?</div>
            <div style={{ fontSize: 13, color: theme.textDim, marginBottom: 18, lineHeight: 1.5 }}>Stroje v této kategorii se přesunou do Nezařazené. Tato akce se nedá vrátit.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px', color: theme.text, fontWeight: 600 }}>Zrušit</button>
              <button onClick={performDelete} style={{ flex: 1, background: theme.em, border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontWeight: 700 }}>Smazat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Formulář pro vytvoření/editaci stroje: název, zařazení do kategorie,
// poznámky a fotky (stejné ikony jako u zápisu opravy).
function MachineFormScreen({ theme, db, machine, onBack, onSaved, onDeleted }) {
  const isNew = !machine;
  const [name, setName] = useState(machine?.name || '');
  const [categoryId, setCategoryId] = useState(machine?.categoryId || null);
  const [icon, setIcon] = useState(machine?.icon || null);
  const [color, setColor] = useState(machine?.color || null);
  const [notes, setNotes] = useState(machine?.notes || '');
  const [photos, setPhotos] = useState(machine?.photos || []);
  const [categories, setCategories] = useState([]);
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const fileInputRef = useRef(null);
  const galleryInputRef = useRef(null);

  useEffect(() => { db.getAll('categories').then(setCategories); }, [db]);

  const selectedCategory = categories.find(c => c.id === categoryId) || null;
  const IconPreview = icon ? Icon[icon] : null;

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }))).then(dataUrls => setPhotos(prev => [...prev, ...dataUrls]));
    e.target.value = '';
  }

  function removePhoto(idx) {
    setPhotos(prev => prev.filter((_, i) => i !== idx));
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const record = {
      id: machine?.id || uid(),
      name: trimmed, categoryId, icon, color, notes: notes.trim(), photos,
      order: machine?.order ?? Date.now(),
      createdAt: machine?.createdAt || Date.now(),
      lastUsed: machine?.lastUsed || Date.now(),
    };
    await db.put('machines', record);
    onSaved(record);
  }

  async function performDelete() {
    if (!machine) return;
    await db.delete('machines', machine.id);
    onDeleted();
  }

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader
        theme={theme}
        title={isNew ? 'Nový stroj' : 'Upravit stroj'}
        onBack={onBack}
        onAction={!isNew ? () => setConfirmDelete(true) : undefined}
        actionIcon={!isNew ? Icon.Trash : undefined}
        actionVariant="danger"
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Název stroje</div>
        <input
          style={{ ...S.textInput, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.text, backdropFilter: theme.blur }}
          placeholder="např. Jeřáb SLUSH02" value={name} onChange={e => setName(e.target.value.toUpperCase())}
        />

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Kategorie</div>
        <div style={{ position: 'relative', marginBottom: 22 }}>
          <button
            onClick={() => setShowCategoryMenu(v => !v)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14, padding: '13px 16px', backdropFilter: theme.blur }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {selectedCategory ? (
                <>
                  {selectedCategory.icon && Icon[selectedCategory.icon] && React.createElement(Icon[selectedCategory.icon], { size: 16 })}
                  <span style={{ fontSize: 15, fontWeight: 600, color: selectedCategory.color || theme.text }}>{selectedCategory.name}</span>
                </>
              ) : (
                <span style={{ fontSize: 15, fontWeight: 600, color: theme.textFaint }}>Nezařazené</span>
              )}
            </div>
            <Icon.ChevronRight size={16} />
          </button>
          {showCategoryMenu && (
            <>
              <div onClick={() => setShowCategoryMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6, zIndex: 40, background: theme.surfaceSolid,
                border: `1px solid ${theme.borderStrong}`, borderRadius: 14, padding: 6, boxShadow: theme.shadow, maxHeight: 260, overflowY: 'auto',
              }}>
                <button
                  onClick={() => { setCategoryId(null); setShowCategoryMenu(false); }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 10px', borderRadius: 9, background: !categoryId ? theme.primarySoft : 'none', border: 'none', color: !categoryId ? theme.primary : theme.text, fontSize: 14, fontWeight: 600 }}
                >
                  <span>Nezařazené</span>
                  {!categoryId && <Icon.Check size={14} weight="bold" />}
                </button>
                {categories.map(c => {
                  const CIcon = c.icon && Icon[c.icon];
                  const active = categoryId === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => { setCategoryId(c.id); setShowCategoryMenu(false); }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 10px', borderRadius: 9, background: active ? `${c.color}1F` : 'none', border: 'none', color: active ? c.color : theme.text, fontSize: 14, fontWeight: 600 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {CIcon && <CIcon size={15} />}
                        <span>{c.name}</span>
                      </div>
                      {active && <Icon.Check size={14} weight="bold" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Náhled</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 22, padding: '13px 16px', background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 14 }}>
          {IconPreview ? (
            <div style={{ color: color || theme.textDim, display: 'flex' }}>
              <IconPreview size={18} weight="fill" />
            </div>
          ) : (
            <div style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px dashed ${theme.textFaint}` }} />
          )}
          <span style={{ fontSize: 15, fontWeight: 700, color: theme.text }}>{name.trim() || 'Název stroje'}</span>
        </div>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Barva</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 22 }}>
          <button
            onClick={() => setColor(null)}
            title="Žádná barva"
            style={{
              width: 38, height: 38, borderRadius: '50%', background: theme.surface, border: !color ? `3px solid ${theme.text}` : `1.5px dashed ${theme.textFaint}`,
              boxShadow: !color ? `0 0 0 2px ${theme.bg}` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint,
            }}
          >
            <Icon.X size={14} weight="bold" />
          </button>
          {MACHINE_COLORS.map(c => (
            <button
              key={c}
              onClick={() => setColor(c)}
              style={{
                width: 38, height: 38, borderRadius: '50%', background: c, border: color === c ? `3px solid ${theme.text}` : '3px solid transparent',
                boxShadow: color === c ? `0 0 0 2px ${theme.bg}` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {color === c && <Icon.Check size={15} weight="bold" style={{ color: '#fff' }} />}
            </button>
          ))}
        </div>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Ikona</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, marginBottom: 24 }}>
          <button
            onClick={() => setIcon(null)}
            title="Žádná ikona"
            style={{
              aspectRatio: '1', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: !icon ? theme.primarySoft : theme.surface, border: `1.5px solid ${!icon ? theme.primary : theme.border}`,
              color: !icon ? theme.primary : theme.textDim,
            }}
          >
            <Icon.X size={17} weight="bold" />
          </button>
          {SHARED_ICONS.map(iconKey => {
            const IconComp = Icon[iconKey];
            const active = icon === iconKey;
            return (
              <button
                key={iconKey}
                onClick={() => setIcon(iconKey)}
                style={{
                  aspectRatio: '1', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: active ? `${(color || theme.primary)}26` : theme.surface, border: `1.5px solid ${active ? (color || theme.primary) : theme.border}`,
                  color: active ? (color || theme.primary) : theme.textDim,
                }}
              >
                <IconComp size={19} />
              </button>
            );
          })}
        </div>

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Poznámky</div>
        <textarea
          style={{ ...S.textArea, background: theme.surface, border: `1px solid ${theme.border}`, color: theme.text, backdropFilter: theme.blur }}
          placeholder="Např. sériové číslo, umístění, servisní poznámky..." value={notes} onChange={e => setNotes(e.target.value)} rows={4}
        />

        <div style={{ ...S.fieldLabel, color: theme.textFaint }}>Fotky</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: 'relative', width: 72, height: 72 }}>
              <img src={p} onClick={() => setLightboxIndex(i)} style={{ width: 72, height: 72, borderRadius: 12, objectFit: 'cover', border: `1px solid ${theme.border}`, cursor: 'pointer' }} />
              <button onClick={() => removePhoto(i)} style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: '50%', background: theme.em, border: `2px solid ${theme.bg}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><Icon.X size={12} /></button>
            </div>
          ))}
          <button onClick={() => fileInputRef.current?.click()} style={{ width: 72, height: 72, borderRadius: 12, background: theme.surface, border: `1.5px dashed ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint, backdropFilter: theme.blur }}>
            <Icon.Camera size={20} />
          </button>
          <button onClick={() => galleryInputRef.current?.click()} style={{ width: 72, height: 72, borderRadius: 12, background: theme.surface, border: `1.5px dashed ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textFaint, backdropFilter: theme.blur }}>
            <Icon.Image size={20} />
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFiles} />
        <input ref={galleryInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFiles} />
        <div style={{ height: 12 }} />
      </div>

      <div style={{ padding: '14px 20px', borderTop: `1px solid ${theme.border}`, background: theme.bg }}>
        <button onClick={save} disabled={!name.trim()} style={{ width: '100%', background: name.trim() ? `linear-gradient(155deg, ${theme.primary} 0%, #4338CA 100%)` : theme.surfaceElevated, border: 'none', borderRadius: 14, padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: name.trim() ? '#fff' : theme.textFaint, fontSize: 16, fontWeight: 700 }}>
          <Icon.Check size={18} />
          <span>{isNew ? 'Vytvořit stroj' : 'Uložit změny'}</span>
        </button>
      </div>

      {lightboxIndex !== null && photos[lightboxIndex] && (
        <div onClick={() => setLightboxIndex(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
          <button onClick={() => setLightboxIndex(null)} style={{ position: 'absolute', top: 16, right: 16, width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
            <Icon.X size={20} weight="bold" />
          </button>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ZoomableImage src={photos[lightboxIndex]} />
          </div>
        </div>
      )}

      {confirmDelete && (
        <div onClick={() => setConfirmDelete(false)} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: theme.surfaceSolid, border: `1px solid ${theme.borderStrong}`, borderRadius: 20, padding: 22, width: '100%', maxWidth: 320, boxShadow: theme.shadow }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, marginBottom: 4 }}>Smazat stroj?</div>
            <div style={{ fontSize: 13, color: theme.textDim, marginBottom: 18, lineHeight: 1.5 }}>Existující záznamy oprav zůstanou zachovány, jen si tento stroj nebude možné vybrat pro nové opravy. Tato akce se nedá vrátit.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px', color: theme.text, fontWeight: 600 }}>Zrušit</button>
              <button onClick={performDelete} style={{ flex: 1, background: theme.em, border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontWeight: 700 }}>Smazat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Krátký nadpis dne pro galerii, ve stylu Google Photos: "Dnes", "Včera",
// nebo "12. srpna 2026" — bez uvedení dne v týdnu, na rozdíl od fmtDateLabel.
function fmtGalleryDateHeading(dateKey) {
  const today = fmtDateKey(Date.now());
  const yesterday = fmtDateKey(Date.now() - 86400000);
  if (dateKey === today) return 'Dnes';
  if (dateKey === yesterday) return 'Včera';
  const [y, m, d] = dateKey.split('-').map(Number);
  return `${d}. ${MONTH_NAMES[m - 1]} ${y}`;
}

// Fotka v lightboxu s podporou přiblížení/oddálení — pinch gesto na dotykových
// zařízeních (dva prsty), kolečko myši s Ctrl/pinch trackpad na desktopu, a
// tažení pro posun, když je fotka přiblížená. Dvojklik/dvojťuk mezi 1x a 2.5x
// přepíná rychlé přiblížení. Používá se ve všech lightboxech appky, ať je
// prohlížení fotek konzistentní všude.
function ZoomableImage({ src }) {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);
  const stateRef = useRef({ startDist: 0, startScale: 1, startTranslate: { x: 0, y: 0 }, startMid: { x: 0, y: 0 }, panStart: null });

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function dist(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function midpoint(touches) {
    const [a, b] = touches;
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  function handleTouchStart(e) {
    if (e.touches.length === 2) {
      stateRef.current.startDist = dist(e.touches);
      stateRef.current.startScale = scale;
      stateRef.current.startMid = midpoint(e.touches);
      stateRef.current.startTranslate = translate;
    } else if (e.touches.length === 1 && scale > 1) {
      stateRef.current.panStart = { x: e.touches[0].clientX - translate.x, y: e.touches[0].clientY - translate.y };
    }
  }

  function handleTouchMove(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      const newDist = dist(e.touches);
      const ratio = newDist / (stateRef.current.startDist || newDist);
      const newScale = clamp(stateRef.current.startScale * ratio, 1, 4);
      setScale(newScale);
      setTranslate(clampTranslate(stateRef.current.startTranslate, newScale));
    } else if (e.touches.length === 1 && stateRef.current.panStart) {
      e.preventDefault();
      const next = { x: e.touches[0].clientX - stateRef.current.panStart.x, y: e.touches[0].clientY - stateRef.current.panStart.y };
      setTranslate(clampTranslate(next, scale));
    }
  }

  function handleTouchEnd(e) {
    if (e.touches.length === 0) stateRef.current.panStart = null;
  }

  function clampTranslate(t, s) {
    // Nedovolí odtáhnout fotku úplně mimo viditelnou oblast — čím větší zoom,
    // tím větší povolený posun, ať jde prohlédnout celou přiblíženou fotku.
    const maxOffset = (s - 1) * 160;
    return { x: clamp(t.x, -maxOffset, maxOffset), y: clamp(t.y, -maxOffset, maxOffset) };
  }

  function handleWheel(e) {
    e.preventDefault();
    const next = clamp(scale - e.deltaY * 0.0025, 1, 4);
    setScale(next);
    if (next === 1) setTranslate({ x: 0, y: 0 });
  }

  function handleDoubleClick() {
    if (scale > 1) { setScale(1); setTranslate({ x: 0, y: 0 }); }
    else setScale(2.5);
  }

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}
      onWheel={handleWheel} onDoubleClick={handleDoubleClick}
      style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', touchAction: 'none' }}
    >
      <img
        src={src} draggable={false}
        style={{
          maxWidth: '92vw', maxHeight: '86vh', objectFit: 'contain', borderRadius: 8,
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          transition: stateRef.current.panStart ? 'none' : 'transform 0.15s ease',
        }}
      />
    </div>
  );
}

function GalleryScreen({ theme, db, refreshTick, onOpenRecord, columns, onColumnsChange }) {
  const isDesktop = useViewportWidth();
  const [records, setRecords] = useState([]);
  const [lightbox, setLightbox] = useState(null); // { photos: [{url, record}], index }
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [selected, setSelected] = useState(() => new Set()); // Set of "recordId|photoIndex" keys
  const [showColumnsMenu, setShowColumnsMenu] = useState(false);
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const [confirmDeleteCurrent, setConfirmDeleteCurrent] = useState(false);
  const [selectionFeedback, setSelectionFeedback] = useState(null); // { type, text }
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);

  // Dlouhé podržení fotky (500ms) aktivuje výběrový režim a označí tu fotku.
  // longPressFired brání tomu, aby se po dokončení long-pressu ještě navíc
  // spustil normální onClick handler (browser posílá click i po pointerup).
  function startLongPress(key) {
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setSelected(prev => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    }, 500);
  }

  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  const load = useCallback(async () => {
    const all = await db.getAll('records');
    setRecords(all);
  }, [db]);

  useEffect(() => { load(); }, [load, refreshTick]);

  // Sestaví plochý seznam { url, record, photoIndex, key } pro každou fotku
  // napříč všemi záznamy, pak je seskupí podle dne (nejnovější den nahoře,
  // fotky uvnitř dne v pořadí od nejnovějšího záznamu). photoIndex je pozice
  // fotky uvnitř record.photos, potřebná pro mazání konkrétní fotky.
  const sections = useMemo(() => {
    const byDate = {};
    const sorted = [...records].sort((a, b) => b.startTime - a.startTime);
    sorted.forEach(r => {
      (r.photos || []).forEach((url, photoIndex) => {
        if (!byDate[r.date]) byDate[r.date] = [];
        byDate[r.date].push({ url, record: r, photoIndex, key: `${r.id}|${photoIndex}` });
      });
    });
    return Object.keys(byDate)
      .sort((a, b) => b.localeCompare(a))
      .map(date => ({ date, items: byDate[date] }));
  }, [records]);

  const isEmpty = sections.length === 0;
  const selectionMode = selected.size > 0;
  const allItems = useMemo(() => sections.flatMap(s => s.items), [sections]);
  const selectedItems = useMemo(() => allItems.filter(it => selected.has(it.key)), [allItems, selected]);

  function openLightbox(sectionIdx, itemIdx) {
    if (selectionMode) return; // v režimu výběru klik na fotku přepíná výběr, ne lightbox
    const flatItems = sections.flatMap(s => s.items);
    const globalIndex = sections.slice(0, sectionIdx).reduce((n, s) => n + s.items.length, 0) + itemIdx;
    setLightbox({ items: flatItems, index: globalIndex });
  }

  function toggleSelect(key) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleSelectAllInSection(section) {
    const keys = section.items.map(it => it.key);
    const allSelected = keys.every(k => selected.has(k));
    setSelected(prev => {
      const next = new Set(prev);
      keys.forEach(k => allSelected ? next.delete(k) : next.add(k));
      return next;
    });
  }

  function clearSelection() { setSelected(new Set()); }

  async function shareSelected() {
    for (const item of selectedItems) await sharePhoto(item.url, item.record, item.photoIndex);
  }

  async function copySelected() {
    // Schránka podporuje jen jeden obrázek najednou — zkopíruje se první z výběru.
    if (selectedItems.length === 0) return;
    const ok = await copyPhotoToClipboard(selectedItems[0].url);
    setSelectionFeedback({ type: ok ? 'success' : 'error', text: ok ? 'Zkopírováno do schránky' : 'Kopírování se nezdařilo' });
    setTimeout(() => setSelectionFeedback(null), 1800);
  }

  async function downloadSelected() {
    for (const item of selectedItems) await downloadPhoto(item.url, item.record, item.photoIndex);
  }

  async function deleteSelected() {
    setConfirmDeleteSelected(false);
    // Vybrané fotky seskupíme podle záznamu, ať každý záznam upravíme jen jednou.
    const byRecord = new Map();
    selectedItems.forEach(item => {
      if (!byRecord.has(item.record.id)) byRecord.set(item.record.id, { record: item.record, indices: new Set() });
      byRecord.get(item.record.id).indices.add(item.photoIndex);
    });
    for (const { record, indices } of byRecord.values()) {
      const updatedPhotos = (record.photos || []).filter((_, i) => !indices.has(i));
      await db.put('records', { ...record, photos: updatedPhotos });
    }
    clearSelection();
    load();
  }

  // Smaže jen fotku aktuálně otevřenou v lightboxu (ne celý výběr). Po smazání
  // se lightbox buď posune na další zbývající fotku, nebo se zavře, pokud
  // to byla poslední fotka.
  async function deleteCurrentLightboxPhoto() {
    setConfirmDeleteCurrent(false);
    if (!current) return;
    const { record, photoIndex } = current;
    const updatedPhotos = (record.photos || []).filter((_, i) => i !== photoIndex);
    await db.put('records', { ...record, photos: updatedPhotos });
    setLightbox(l => {
      if (!l) return null;
      const remaining = l.items.filter((_, i) => i !== l.index);
      if (remaining.length === 0) return null;
      const nextIndex = Math.min(l.index, remaining.length - 1);
      return { items: remaining, index: nextIndex };
    });
    load();
  }

  const current = lightbox ? lightbox.items[lightbox.index] : null;
  const columnOptions = [2, 3, 4, 5, 6];

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <div style={{ padding: '22px 20px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {selectionMode ? (
          <>
            <button onClick={clearSelection} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', color: theme.text }}>
              <Icon.X size={18} weight="bold" />
              <span style={{ fontSize: 15, fontWeight: 700 }}>{selected.size} vybráno</span>
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={shareSelected} style={{ width: 40, height: 40, borderRadius: 11, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text, flexShrink: 0 }}>
                <Icon.ShareIcon size={17} />
              </button>
              <button onClick={copySelected} style={{ width: 40, height: 40, borderRadius: 11, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text, flexShrink: 0 }}>
                <Icon.Copy size={17} />
              </button>
              <button onClick={downloadSelected} style={{ width: 40, height: 40, borderRadius: 11, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text, flexShrink: 0 }}>
                <Icon.Download size={17} />
              </button>
              <button onClick={() => setConfirmDeleteSelected(true)} style={{ width: 40, height: 40, borderRadius: 11, background: theme.emSoft, border: `1px solid ${theme.em}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.em, flexShrink: 0 }}>
                <Icon.Trash size={17} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 20, fontWeight: 800, color: theme.text }}>Galerie</div>
            <div style={{ position: 'relative' }}>
              <IconButton theme={theme} onClick={() => setShowColumnsMenu(v => !v)}><Icon.Bar size={18} /></IconButton>
              {showColumnsMenu && (
                <>
                  <div onClick={() => setShowColumnsMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
                  <div style={{
                    position: 'absolute', top: 46, right: 0, zIndex: 40, background: theme.surfaceSolid,
                    border: `1px solid ${theme.borderStrong}`, borderRadius: 14, padding: 6, boxShadow: theme.shadow,
                    display: 'flex', flexDirection: 'column', minWidth: 140,
                  }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: theme.textFaint, padding: '8px 10px 4px' }}>
                      Sloupců v mřížce
                    </div>
                    {columnOptions.map(n => (
                      <button
                        key={n}
                        onClick={() => { onColumnsChange(n); setShowColumnsMenu(false); }}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 10px', borderRadius: 9,
                          background: columns === n ? theme.primarySoft : 'none', border: 'none',
                          color: columns === n ? theme.primary : theme.text, fontSize: 14, fontWeight: columns === n ? 700 : 500,
                        }}
                      >
                        <span>{n} {n === 1 ? 'sloupec' : n < 5 ? 'sloupce' : 'sloupců'}</span>
                        {columns === n && <Icon.Check size={14} weight="bold" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {selectionFeedback && (
        <div style={{ margin: '0 16px 12px', fontSize: 12.5, color: selectionFeedback.type === 'error' ? theme.em : theme.cm, background: selectionFeedback.type === 'error' ? theme.emSoft : theme.cmSoft, border: `1px solid ${selectionFeedback.type === 'error' ? theme.em : theme.cm}33`, borderRadius: 10, padding: '9px 13px' }}>
          {selectionFeedback.text}
        </div>
      )}

      {isEmpty ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 30px', gap: 10 }}>
          <div style={{ color: theme.textFaint }}><Icon.Image size={32} /></div>
          <div style={{ fontSize: 14, color: theme.textFaint, textAlign: 'center' }}>Zatím žádné fotky. Přidej je při zápisu opravy.</div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 20px' }}>
          {sections.map((section, sIdx) => {
            const sectionKeys = section.items.map(it => it.key);
            const allSelected = sectionKeys.every(k => selected.has(k));
            return (
              <div key={section.date} style={{ marginBottom: 22 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, padding: '0 4px' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: theme.textDim }}>
                    {fmtGalleryDateHeading(section.date)}
                  </div>
                  {selectionMode && (
                    <button onClick={() => toggleSelectAllInSection(section)} style={{ fontSize: 12, fontWeight: 600, color: theme.primary, background: 'none', border: 'none' }}>
                      {allSelected ? 'Zrušit výběr' : 'Vybrat vše'}
                    </button>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: isDesktop ? `repeat(${columns}, minmax(0, 220px))` : `repeat(${columns}, 1fr)`, gap: 6 }}>
                  {section.items.map((item, iIdx) => {
                    const isSelected = selected.has(item.key);
                    return (
                      <div key={iIdx} style={{ position: 'relative', aspectRatio: '1' }}>
                        <button
                          onClick={() => {
                            if (longPressFired.current) { longPressFired.current = false; return; }
                            if (selectionMode) toggleSelect(item.key); else openLightbox(sIdx, iIdx);
                          }}
                          onPointerDown={() => startLongPress(item.key)}
                          onPointerUp={cancelLongPress}
                          onPointerLeave={cancelLongPress}
                          onContextMenu={(e) => e.preventDefault()}
                          style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 10, overflow: 'hidden', background: theme.surface, border: 'none', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation' }}
                        >
                          <img src={item.url} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />
                          <div style={{
                            position: 'absolute', left: 0, right: 0, bottom: 0,
                            background: 'linear-gradient(to top, rgba(0,0,0,0.75), transparent)',
                            padding: columns <= 3 ? '14px 6px 5px' : '10px 4px 4px',
                          }}>
                            <div style={{ fontSize: columns <= 3 ? 10 : 8.5, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {item.record.machineName}
                            </div>
                          </div>
                        </button>
                        {selectionMode && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleSelect(item.key); }}
                            style={{
                              position: 'absolute', right: 5, bottom: 5, width: 22, height: 22, borderRadius: '50%',
                              background: isSelected ? theme.primary : 'rgba(0,0,0,0.4)',
                              border: `1.5px solid ${isSelected ? theme.primary : 'rgba(255,255,255,0.8)'}`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1,
                            }}
                          >
                            {isSelected && <Icon.Check size={12} weight="bold" />}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {lightbox && current && (
        <div
          onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.94)', display: 'flex', flexDirection: 'column' }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px' }}>
            <button
              onClick={() => { onOpenRecord(current.record); setLightbox(null); }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, padding: '8px 12px', color: '#fff' }}
            >
              <Icon.Back size={15} />
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{current.record.machineName}</span>
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={async () => { await sharePhoto(current.url, current.record, current.photoIndex); }}
                style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
              >
                <Icon.ShareIcon size={17} />
              </button>
              <button
                onClick={async () => {
                  const ok = await copyPhotoToClipboard(current.url);
                  if (ok) { setCopyFeedback(true); setTimeout(() => setCopyFeedback(false), 1800); }
                }}
                style={{ width: 40, height: 40, borderRadius: 11, background: copyFeedback ? theme.cmSoft : 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: copyFeedback ? theme.cm : '#fff' }}
              >
                {copyFeedback ? <Icon.Check size={16} weight="bold" /> : <Icon.Copy size={17} />}
              </button>
              <button
                onClick={async () => { await downloadPhoto(current.url, current.record, current.photoIndex); }}
                style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
              >
                <Icon.Download size={17} />
              </button>
              <button
                onClick={() => setConfirmDeleteCurrent(true)}
                style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(244,63,94,0.18)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6976' }}
              >
                <Icon.Trash size={17} />
              </button>
              <button
                onClick={() => setLightbox(null)}
                style={{ width: 40, height: 40, borderRadius: 11, background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}
              >
                <Icon.X size={18} weight="bold" />
              </button>
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            {lightbox.index > 0 && (
              <button
                onClick={() => setLightbox(l => ({ ...l, index: l.index - 1 }))}
                style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 2 }}
              >
                <Icon.Back size={20} />
              </button>
            )}
            <ZoomableImage src={current.url} />
            {lightbox.index < lightbox.items.length - 1 && (
              <button
                onClick={() => setLightbox(l => ({ ...l, index: l.index + 1 }))}
                style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 2 }}
              >
                <Icon.ChevronRight size={20} />
              </button>
            )}
          </div>

          <div style={{ textAlign: 'center', padding: '10px 16px 20px', fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
            {fmtGalleryDateHeading(current.record.date)} · {lightbox.index + 1} / {lightbox.items.length}
          </div>
        </div>
      )}

      {confirmDeleteSelected && (
        <div onClick={() => setConfirmDeleteSelected(false)} style={{ position: 'fixed', inset: 0, background: theme.overlay, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 70 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: theme.surfaceSolid, border: `1px solid ${theme.borderStrong}`, borderRadius: 20, padding: 22, width: '100%', maxWidth: 320, boxShadow: theme.shadow }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, marginBottom: 4 }}>Smazat {selected.size} {selected.size === 1 ? 'fotku' : selected.size < 5 ? 'fotky' : 'fotek'}?</div>
            <div style={{ fontSize: 13, color: theme.textDim, marginBottom: 18 }}>Tato akce se nedá vrátit.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmDeleteSelected(false)} style={{ flex: 1, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px', color: theme.text, fontWeight: 600 }}>Zrušit</button>
              <button onClick={deleteSelected} style={{ flex: 1, background: theme.em, border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontWeight: 700 }}>Smazat</button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteCurrent && (
        <div onClick={() => setConfirmDeleteCurrent(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 80 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: theme.surfaceSolid, border: `1px solid ${theme.borderStrong}`, borderRadius: 20, padding: 22, width: '100%', maxWidth: 320, boxShadow: theme.shadow }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: theme.text, marginBottom: 4 }}>Smazat fotku?</div>
            <div style={{ fontSize: 13, color: theme.textDim, marginBottom: 18 }}>Tato akce se nedá vrátit.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setConfirmDeleteCurrent(false)} style={{ flex: 1, background: theme.surfaceElevated, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '12px', color: theme.text, fontWeight: 600 }}>Zrušit</button>
              <button onClick={deleteCurrentLightboxPhoto} style={{ flex: 1, background: theme.em, border: 'none', borderRadius: 12, padding: '12px', color: '#fff', fontWeight: 700 }}>Smazat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  loadingScreen: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  screen: { height: '100%', display: 'flex', flexDirection: 'column' },
  homeHeader: { padding: '22px 20px 0' },
  homeHeaderTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  liveDate: { fontSize: 14, marginTop: 6, textTransform: 'capitalize' },
  timerWrap: { flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', padding: '0 20px', paddingTop: '10vh' },
  timerLabel: { fontSize: 11.5, letterSpacing: 1.5, fontWeight: 600 },
  timerDisplay: { fontSize: 30, fontWeight: 600, letterSpacing: 0.5, fontVariantNumeric: 'tabular-nums', marginTop: 6 },
  timerIdleLabel: { fontSize: 15, marginBottom: 34, fontWeight: 500 },
  mainButton: { width: 196, height: 196, borderRadius: '50%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer', transition: 'transform 0.12s ease, box-shadow 0.2s ease' },
  mainButtonLabel: { fontSize: 16, fontWeight: 600, letterSpacing: 3 },
  startTriangle: { width: 0, height: 0, borderTop: '18px solid transparent', borderBottom: '18px solid transparent', borderLeft: '30px solid currentColor', marginLeft: 8 },
  stopSquare: { width: 36, height: 36, borderRadius: 8, background: 'currentColor' },
  pulseHint: { fontSize: 13, marginTop: 22, textAlign: 'center' },
  historyLink: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'none', border: 'none', fontSize: 14, fontWeight: 500, padding: '22px' },
  modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px' },
  modalTitle: { fontSize: 16, fontWeight: 700 },
  emptyState: { textAlign: 'center', fontSize: 14, padding: '48px 20px' },
  fieldLabel: { fontSize: 11.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 9, marginTop: 4 },
  textInput: { width: '100%', borderRadius: 12, padding: '13px 16px', fontSize: 15, marginBottom: 20, outline: 'none', fontFamily: 'inherit' },
  textArea: { width: '100%', borderRadius: 12, padding: '13px 16px', fontSize: 15, marginBottom: 20, outline: 'none', fontFamily: 'inherit', resize: 'vertical' },
  detailText: { fontSize: 15, lineHeight: 1.6, marginBottom: 18, whiteSpace: 'pre-wrap' },
};

if (typeof document !== 'undefined' && !document.getElementById('udrzba-vars')) {
  const styleTag = document.createElement('style');
  styleTag.id = 'udrzba-vars';
  styleTag.textContent = `
:root { --mono: 'JetBrains Mono', 'SF Mono', Consolas, monospace; }
input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { opacity: 1; }
input[type=date], input[type=time] { font-variant-numeric: tabular-nums; }
input[type=date]::-webkit-calendar-picker-indicator, input[type=time]::-webkit-calendar-picker-indicator { filter: invert(0.55); cursor: pointer; }
`;
  document.head.appendChild(styleTag);
}

// Phosphor icon font — injected here as a fallback for environments (like an
// artifact preview) that don't load it via index.html's own <link> tags.
// Guarded against the real PWA's own static <link> tags by checking for any
// existing phosphor-icons stylesheet, not just one we injected ourselves.
if (typeof document !== 'undefined' && !document.querySelector('link[href*="phosphor-icons"]')) {
  ['regular', 'bold', 'fill'].forEach((weight) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://unpkg.com/@phosphor-icons/web@2.1.2/src/${weight}/style.css`;
    document.head.appendChild(link);
  });
}

if (typeof document !== 'undefined' && document.getElementById('root') && typeof ReactDOM !== 'undefined') {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(<App />);
}
