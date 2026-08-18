const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ============================================================
// APP VERSION — zvednout při každé úpravě
// ============================================================
const APP_VERSION = '6.14';

// ============================================================
// DB LAYER — tenký vlastní wrapper nad nativním IndexedDB
// ============================================================
const DB_NAME = 'udrzba-db';
const DB_VERSION = 2;

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
        put(storeName, value) {
          return new Promise((res, rej) => {
            const tx = idb.transaction(storeName, 'readwrite');
            const r = tx.objectStore(storeName).put(value);
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
        },
        delete(storeName, key) {
          return new Promise((res, rej) => {
            const tx = idb.transaction(storeName, 'readwrite');
            const r = tx.objectStore(storeName).delete(key);
            r.onsuccess = () => res(r.result);
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
  Copy: phosphorIcon('copy'),
  ShareIcon: phosphorIcon('share-network'),
  House: phosphorIcon('house'),
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
  MachFlame: phosphorIcon('flame'),
  MachSparkle: phosphorIcon('sparkle'),
  MachStamp: phosphorIcon('stamp'),
  MachCarousel: phosphorIcon('gear-six'),
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
    shadow: '0 1px 2px rgba(41,43,49,0.07), 0 1px 1px rgba(41,43,49,0.04)', shadowSm: '0 1px 2px rgba(41,43,49,0.07)',
    blur: 'blur(20px)', overlay: 'rgba(41,43,49,0.4)',
  },
};

const TYPES = {
  CM: { label: 'CM', full: 'Normální práce', desc: 'bez prostoje' },
  EM: { label: 'EM', full: 'Porucha', desc: 's prostojem' },
};

const CM_SUBTYPES = {
  normal: { label: 'Normální práce', short: 'Normál' },
  oprava: { label: 'Oprava', short: 'Oprava' },
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

function HomeScreen({ theme, activeSession, onStart, onStop, onOpenSettings, onOpenToday, onAddPhoto }) {
  const elapsed = useElapsed(activeSession?.startTime, !!activeSession);
  const now = useNow();
  const [pressed, setPressed] = useState(false);
  const accentColor = activeSession ? theme.em : theme.primary;
  const accentSoft = activeSession ? theme.emSoft : theme.primarySoft;
  const nowDate = new Date(now);
  const cameraInputRef = useRef(null);
  const galleryInputRef = useRef(null);
  const photoCount = activeSession?.photos?.length || 0;

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

  return (
    <div style={{ ...S.screen, background: theme.bg, overflowY: 'auto' }}>
      <div style={S.homeHeader}>
        <div style={S.homeHeaderTop}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: theme.primarySoft, border: `1px solid ${theme.primary}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.primary, flexShrink: 0 }}>
              <Icon.Wrench size={16} weight="fill" />
            </div>
            <span style={{ fontSize: 15, fontWeight: 600, color: theme.text, whiteSpace: 'nowrap' }}>Deník údržbáře</span>
          </div>
          <IconButton theme={theme} onClick={onOpenSettings}><Icon.Settings size={19} /></IconButton>
        </div>
        <div style={{ fontSize: 12, color: theme.textFaint, textAlign: 'center', marginTop: 14, minHeight: 16, visibility: activeSession ? 'visible' : 'hidden' }}>
          Klidně appku zavři, čas běží dál na pozadí
        </div>
      </div>

      <div style={S.timerWrap}>
        <div style={{ ...S.liveDate, color: theme.textDim, textAlign: 'center', marginBottom: 4 }}>
          {nowDate.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' })}
        </div>
        <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 38, fontWeight: 600, color: theme.text, letterSpacing: 0.5, marginBottom: 32 }}>
          {nowDate.getHours()}:{pad(nowDate.getMinutes())}
        </div>

        <button
          onMouseDown={() => setPressed(true)} onMouseUp={() => setPressed(false)} onMouseLeave={() => setPressed(false)}
          onTouchStart={() => setPressed(true)} onTouchEnd={() => setPressed(false)}
          style={{
            ...S.mainButton,
            background: accentSoft,
            border: `2.5px solid ${accentColor}`,
            color: accentColor,
            boxShadow: pressed ? `0 4px 20px ${accentColor}40` : `0 8px 30px ${accentColor}55`,
            transform: pressed ? 'scale(0.97)' : 'scale(1)',
          }}
          onClick={activeSession ? onStop : onStart}
        >
          <div style={activeSession ? S.stopSquare : S.startTriangle} />
          <span style={S.mainButtonLabel}>{activeSession ? 'STOP' : 'START'}</span>
        </button>

        <div style={{ marginTop: 22, minHeight: 96, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '10px 22px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: 196 }}>
            <button
              onClick={() => cameraInputRef.current?.click()}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none' }}
            >
              <div style={{ width: 50, height: 50, borderRadius: 14, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textDim, backdropFilter: theme.blur }}>
                <Icon.Camera size={20} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: theme.textFaint }}>Foto</span>
            </button>
            {photoCount > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div style={{ position: 'relative', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 18, lineHeight: 1 }}>📷</span>
                  <span style={{
                    position: 'absolute', top: -6, right: -8, minWidth: 15, height: 15, borderRadius: 8, padding: '0 3px',
                    background: theme.primary, color: '#fff', fontSize: 9.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                  }}>{photoCount}</span>
                </div>
              </div>
            )}
            <button
              onClick={() => galleryInputRef.current?.click()}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none' }}
            >
              <div style={{ width: 50, height: 50, borderRadius: 14, background: theme.surface, border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textDim, backdropFilter: theme.blur }}>
                <Icon.Image size={20} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: theme.textFaint }}>Galerie</span>
            </button>
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleSessionFiles} />
            <input ref={galleryInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleSessionFiles} />
          </div>
          <button style={{ ...S.historyLink, color: theme.textDim, padding: '0' }} onClick={onOpenToday}>
            <span>Dnešní opravy</span>
            <Icon.ChevronRight size={17} />
          </button>
        </div>
      ) : (
        <button style={{ ...S.historyLink, color: theme.textDim }} onClick={onOpenToday}>
          <span>Dnešní opravy</span>
          <Icon.ChevronRight size={17} />
        </button>
      )}
    </div>
  );
}

function SettingsScreen({ theme, mode, setMode, onBack, db, onDataRestored }) {
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
          <div style={{ fontSize: 12.5, color: theme.textFaint, marginTop: 8, lineHeight: 1.5 }}>Data se ukládají pouze v tomto zařízení.</div>
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

function ModalHeader({ theme, title, onBack, onHome, onAction, actionIcon: ActionIcon, actionVariant }) {
  return (
    <div style={{ ...S.modalHeader, borderBottom: `1px solid ${theme.border}` }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {onBack ? <IconButton theme={theme} onClick={onBack}><Icon.Back size={19} /></IconButton> : <div style={{ width: 42 }} />}
        {onHome && <IconButton theme={theme} onClick={onHome}><Icon.House size={18} /></IconButton>}
      </div>
      <span style={{ ...S.modalTitle, color: theme.text }}>{title}</span>
      {ActionIcon ? <IconButton theme={theme} onClick={onAction} variant={actionVariant}><ActionIcon size={18} /></IconButton> : <div style={{ width: 42 }} />}
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
          <input ref={inputRef} style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: theme.text, fontSize: 16, fontFamily: 'inherit' }} placeholder="Hledat nebo zadat nový název..." value={query} onChange={e => setQuery(e.target.value)} enterKeyHint="done" />
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

function RecordForm({ theme, db, session, initialDate, machine, onSave, onCancel, resolvedThemeName }) {
  const [type, setType] = useState('CM');
  const [cmSubtype, setCmSubtype] = useState('normal');
  const [wo, setWo] = useState('');
  const [issue, setIssue] = useState('');
  const [solution, setSolution] = useState('');
  const [photos, setPhotos] = useState(() => session?.photos || []);
  const fileInputRef = useRef(null);
  const galleryInputRef = useRef(null);

  // session (ze STOP) má reálný start/end. Ruční přidání do minulého dne
  // startuje s rozumným výchozím oknem (8:00–8:30 toho dne), oboje plně editovatelné.
  const initialStart = session ? session.startTime : (() => {
    const d = new Date(initialDate);
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  })();
  const initialEnd = session ? session.endTime : initialStart + 30 * 60000;

  const [startTime, setStartTime] = useState(initialStart);
  const [endTime, setEndTime] = useState(initialEnd);

  // Délka prostoje u EM má vlastní od-do okno, nezávislé na skutečné době na
  // místě (startTime/endTime) — výchozí je stejné okno, ale editovatelné zvlášť.
  const [downtimeStart, setDowntimeStart] = useState(initialStart);
  const [downtimeEnd, setDowntimeEnd] = useState(initialEnd);
  const [downtimeTouched, setDowntimeTouched] = useState(false);
  const [editingDowntime, setEditingDowntime] = useState(false);

  const actualDuration = Math.max(0, endTime - startTime);
  const effectiveDowntime = downtimeTouched ? Math.max(0, downtimeEnd - downtimeStart) : actualDuration;
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
    const record = {
      id: uid(), machineId: machine.id, machineName: machine.name, type,
      cmSubtype: type === 'CM' ? cmSubtype : null,
      wo: wo.trim(), issue: issue.trim(), solution: solution.trim(), photos,
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
      <ModalHeader theme={theme} title={isBackfill ? 'Přidat opravu' : 'Zápis opravy'} onBack={onCancel} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        <Card theme={theme} style={{ padding: 18, marginBottom: 22 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: theme.text, marginBottom: 12 }}>{machine.name}</div>
          <DateEditor theme={theme} label="Datum" value={startTime} onChange={updateStartDate} isDark={resolvedThemeName === 'dark'} />
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <TimeEditor theme={theme} label="Od" value={startTime} onChange={setStartTime} isDark={resolvedThemeName === 'dark'} />
            <TimeEditor theme={theme} label="Do" value={endTime} onChange={setEndTime} isDark={resolvedThemeName === 'dark'} />
          </div>
          <div style={{ fontSize: 12, color: theme.textFaint, marginTop: 10 }}>doba na místě {fmtDurationShort(actualDuration)}</div>
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
        <div style={{ height: 12 }} />
      </div>

      <div style={{ padding: '14px 20px', borderTop: `1px solid ${theme.border}`, background: theme.bg }}>
        <button onClick={save} style={{ width: '100%', background: `linear-gradient(155deg, ${theme.primary} 0%, #4338CA 100%)`, border: 'none', borderRadius: 14, padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#fff', fontSize: 16, fontWeight: 700, boxShadow: `0 6px 20px ${theme.primary}40` }}>
          <Icon.Check size={18} />
          <span>Uložit záznam</span>
        </button>
      </div>
    </div>
  );
}

// ============================================================
// YEAR SCREEN — dlaždice měsíců s počty a časem prostojů
// ============================================================
function YearScreen({ theme, db, onBack, onHome, onOpenMonth, onAddRecord, refreshTick, initialYear }) {
  const [records, setRecords] = useState([]);
  const [year, setYear] = useState(initialYear || new Date().getFullYear());

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
      if (!map[m]) map[m] = { cm: 0, cmOprava: 0, em: 0, emTime: 0 };
      if (r.type === 'EM') {
        map[m].em++;
        map[m].emTime += r.downtimeMs ?? (r.endTime - r.startTime);
      } else if (r.cmSubtype === 'oprava') {
        map[m].cmOprava++;
      } else {
        map[m].cm++;
      }
    });
    return map;
  }, [records, year]);

  const yearStats = useMemo(() => {
    let cm = 0, cmOprava = 0, em = 0, emTime = 0;
    Object.values(monthsInYear).forEach(m => { cm += m.cm; cmOprava += m.cmOprava; em += m.em; emTime += m.emTime; });
    return { cm, cmOprava, em, emTime };
  }, [monthsInYear]);

  const availableYears = useMemo(() => {
    const ys = new Set(records.map(r => Number(r.date.split('-')[0])));
    ys.add(new Date().getFullYear());
    return Array.from(ys).sort((a, b) => b - a);
  }, [records]);

  return (
    <div style={{ ...S.screen, background: theme.bg }}>
      <ModalHeader theme={theme} title="Přehled" onBack={onBack} onHome={onHome} onAction={() => onAddRecord(fmtDateKey(Date.now()))} actionIcon={Icon.Plus} />

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

      <div style={{ display: 'flex', gap: 8, padding: '10px 20px 16px' }}>
        <Card theme={theme} style={{ flex: 1, padding: '10px 6px', textAlign: 'center' }}>
          <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 17, fontWeight: 800, color: theme.cm }}>{yearStats.cm}</div>
          <div style={{ fontSize: 9.5, color: theme.textFaint, marginTop: 2 }}>CM</div>
        </Card>
        <Card theme={theme} style={{ flex: 1, padding: '10px 6px', textAlign: 'center' }}>
          <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 17, fontWeight: 800, color: theme.cmAlt }}>{yearStats.cmOprava}</div>
          <div style={{ fontSize: 9.5, color: theme.textFaint, marginTop: 2 }}>CM Oprava</div>
        </Card>
        <Card theme={theme} style={{ flex: 1, padding: '10px 6px', textAlign: 'center' }}>
          <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 17, fontWeight: 800, color: theme.em }}>{yearStats.em}</div>
          <div style={{ fontSize: 9.5, color: theme.textFaint, marginTop: 2 }}>EM</div>
        </Card>
        <Card theme={theme} style={{ flex: 1, padding: '10px 6px', textAlign: 'center' }}>
          <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 17, fontWeight: 800, color: theme.text }}>{fmtDurationMin(yearStats.emTime)}</div>
          <div style={{ fontSize: 9.5, color: theme.textFaint, marginTop: 2 }}>prostoje</div>
        </Card>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {MONTH_NAMES.map((name, idx) => {
            const monthNum = idx + 1;
            const data = monthsInYear[monthNum];
            const hasData = !!data;
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
                  opacity: isFuture && !hasData ? 0.5 : 1,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: isCurrentMonth ? theme.text : theme.textDim, textTransform: 'capitalize', marginBottom: hasData ? 8 : 0 }}>{name}</div>
                {hasData ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {data.cm > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: theme.cm }}>{data.cm} CM</span>}
                    {data.em > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: theme.em }}>{data.em} EM</span>}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: theme.textFaint }}>bez záznamů</div>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

// ============================================================
// MONTH SCREEN — dny v měsíci s opravami
// ============================================================
function MonthScreen({ theme, db, monthKey, onBack, onHome, onOpenDay, onAddRecord, refreshTick, onNavigateMonth }) {
  const [records, setRecords] = useState([]);

  const load = useCallback(async () => {
    const all = await db.getAll('records');
    setRecords(all);
  }, [db]);

  useEffect(() => { load(); }, [load, refreshTick]);

  const daysInMonth = useMemo(() => {
    const map = {};
    records.forEach(r => {
      if (fmtMonthKey(r.startTime) !== monthKey) return;
      if (!map[r.date]) map[r.date] = { cm: 0, cmOprava: 0, em: 0, items: [] };
      if (r.type === 'EM') map[r.date].em++;
      else if (r.cmSubtype === 'oprava') map[r.date].cmOprava++;
      else map[r.date].cm++;
      map[r.date].items.push(r);
    });
    return map;
  }, [records, monthKey]);

  const monthStats = useMemo(() => {
    let cm = 0, em = 0, emTime = 0;
    Object.values(daysInMonth).forEach(d => {
      cm += d.cm + d.cmOprava; em += d.em;
      d.items.forEach(r => { if (r.type === 'EM') emTime += r.downtimeMs ?? (r.endTime - r.startTime); });
    });
    return { cm, em, emTime };
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
      <ModalHeader theme={theme} title="Měsíc" onBack={onBack} onHome={onHome} onAction={() => onAddRecord(defaultDateForMonth())} actionIcon={Icon.Plus} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, padding: '14px 20px 4px' }}>
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

      <div style={{ display: 'flex', gap: 10, padding: '10px 20px 12px' }}>
        <Card theme={theme} style={{ flex: 1, padding: '12px 8px', textAlign: 'center' }}>
          <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 19, fontWeight: 800, color: theme.cm }}>{monthStats.cm}</div>
          <div style={{ fontSize: 10.5, color: theme.textFaint, marginTop: 2 }}>CM</div>
        </Card>
        <Card theme={theme} style={{ flex: 1, padding: '12px 8px', textAlign: 'center' }}>
          <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 19, fontWeight: 800, color: theme.em }}>{monthStats.em}</div>
          <div style={{ fontSize: 10.5, color: theme.textFaint, marginTop: 2 }}>EM</div>
        </Card>
        <Card theme={theme} style={{ flex: 1, padding: '12px 8px', textAlign: 'center' }}>
          <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 19, fontWeight: 800, color: theme.text }}>{fmtDurationMin(monthStats.emTime)}</div>
          <div style={{ fontSize: 10.5, color: theme.textFaint, marginTop: 2 }}>prostoje</div>
        </Card>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 20px' }}>
        <div style={{
          border: isCurrentMonth ? `1.5px solid ${theme.primary}44` : '1.5px solid transparent',
          borderRadius: 16, padding: isCurrentMonth ? 8 : 0,
        }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginBottom: 6 }}>
          {weekdayLabels.map((label, i) => (
            <div key={label} style={{
              textAlign: 'center', fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
              color: i >= 5 ? theme.textDim : theme.textFaint, padding: '4px 0',
            }}>{label}</div>
          ))}
        </div>
        {grid.map((week, wi) => (
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
                if (info.em > 0) dots.push(theme.em);
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
                  <div style={{ display: 'flex', gap: 3, height: 5 }}>
                    {dots.map((c, i) => <div key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: c }} />)}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// DAY SCREEN — jednotlivé záznamy daného dne
// ============================================================
function DayScreen({ theme, db, dateKey, onBack, onHome, onOpenRecord, onAddRecord, refreshTick }) {
  const [records, setRecords] = useState([]);

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
        {records.length === 0 && (
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
          const color = r.type === 'EM' ? theme.em : (r.cmSubtype === 'oprava' ? theme.cmAlt : theme.cm);
          const soft = r.type === 'EM' ? theme.emSoft : (r.cmSubtype === 'oprava' ? theme.cmAltSoft : theme.cmSoft);
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

function TimeEditor({ theme, label, value, onChange, isDark }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 11, color: theme.textFaint, marginBottom: 6, fontWeight: 600 }}>{label}</div>
      <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '10px 12px', backdropFilter: theme.blur }}>
        <input
          type="time"
          value={fmtInputTime(value)}
          onChange={e => {
            if (!e.target.value) return;
            const [h, m] = e.target.value.split(':').map(Number);
            const nd = new Date(value);
            nd.setHours(h, m, 0, 0);
            onChange(nd.getTime());
          }}
          style={{ width: '100%', background: 'none', border: 'none', outline: 'none', color: theme.text, fontSize: 15, fontWeight: 700, fontFamily: 'inherit', colorScheme: isDark ? 'dark' : 'light' }}
        />
      </div>
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
  const color = view.type === 'EM' ? theme.em : (view.cmSubtype === 'oprava' ? theme.cmAlt : theme.cm);
  const soft = view.type === 'EM' ? theme.emSoft : (view.cmSubtype === 'oprava' ? theme.cmAltSoft : theme.cmSoft);
  const actualDuration = view.endTime - view.startTime;
  const draftDowntime = editing ? Math.max(0, downtimeEnd - downtimeStart) : null;
  const displayDuration = view.type === 'EM' ? (editing ? draftDowntime : (view.downtimeMs ?? actualDuration)) : actualDuration;

  function updateDraft(patch) {
    setDraft(d => ({ ...d, ...patch }));
  }

  async function saveEdits() {
    const finalDowntime = draft.type === 'EM' ? (downtimeTouched ? Math.max(0, downtimeEnd - downtimeStart) : (draft.downtimeMs ?? (draft.endTime - draft.startTime))) : null;
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
                <TimeEditor theme={theme} label="Od" value={draft.startTime} onChange={v => updateDraft({ startTime: v })} isDark={resolvedThemeName === 'dark'} />
                <TimeEditor theme={theme} label="Do" value={draft.endTime} onChange={v => updateDraft({ endTime: v })} isDark={resolvedThemeName === 'dark'} />
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
              {view.type === 'EM' && (view.downtimeStart != null && view.downtimeEnd != null) && (
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {view.photos.map((p, i) => (
                    <img
                      key={i} src={p} onClick={() => setLightboxIndex(i)}
                      style={{ width: 100, height: 100, borderRadius: 14, objectFit: 'cover', border: `1px solid ${theme.border}`, cursor: 'pointer' }}
                    />
                  ))}
                </div>
              </>
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
          <img
            src={view.photos[lightboxIndex]}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '92vw', maxHeight: '86vh', objectFit: 'contain', borderRadius: 8 }}
          />
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

function App() {
  const [db, setDb] = useState(null);
  const [activeTab, setActiveTab] = useState('timer'); // 'timer' | 'history' | 'machines'
  const [stack, setStack] = useState([{ screen: 'home' }]);
  const [activeSession, setActiveSession] = useState(null);
  const [pendingSession, setPendingSession] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [galleryColumns, setGalleryColumns] = useState(3);
  const [machineColumns, setMachineColumns] = useState(3);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const { mode, setMode, theme, resolvedName: resolvedThemeName } = useTheme();

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
      if (gallerySettings?.columns) setGalleryColumns(gallerySettings.columns);
      const machineSettings = await database.get('settings', 'machines').catch(() => null);
      if (machineSettings?.columns) setMachineColumns(machineSettings.columns);
    });
  }, []);

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
  }

  // Přidá jednu nebo více fotek pořízených/vybraných během běžícího timeru rovnou
  // do activeSession v IndexedDB, takže přežijí zavření appky stejně spolehlivě
  // jako čas. Vždy dostane pole (i pro jednu fotku), ať se víc fotek vybraných
  // najednou nepřepisovalo kvůli zastaralé closure hodnotě activeSession.
  async function addSessionPhoto(dataUrls) {
    if (!activeSession) return;
    const newPhotos = Array.isArray(dataUrls) ? dataUrls : [dataUrls];
    const updated = { ...activeSession, photos: [...(activeSession.photos || []), ...newPhotos] };
    await db.put('activeSession', updated);
    setActiveSession(updated);
  }

  async function stopTimer() {
    const endTime = Date.now();
    setPendingSession({ startTime: activeSession.startTime, endTime, photos: activeSession.photos || [] });
    await db.delete('activeSession', 'active');
    setActiveSession(null);
    push('pickMachine');
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
    <div style={{ height: '100vh', background: theme.bg, transition: 'background 0.2s ease', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {route.screen === 'home' && (
          <HomeScreen
            theme={theme}
            activeSession={activeSession}
            onStart={startTimer}
            onStop={stopTimer}
            onOpenSettings={() => push('settings')}
            onOpenToday={goToTodayInHistory}
            onAddPhoto={addSessionPhoto}
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
          <MachineFormScreen
            theme={theme} db={db} machine={route.machine}
            onBack={() => pop(1)}
            onSaved={() => { setRefreshTick(t => t + 1); pop(1); }}
            onDeleted={() => { setRefreshTick(t => t + 1); pop(1); }}
          />
        )}
        {route.screen === 'categoryForm' && (
          <CategoryFormScreen
            theme={theme} db={db} category={route.category}
            onBack={() => pop(1)}
            onSaved={() => { setRefreshTick(t => t + 1); pop(1); }}
            onDeleted={() => { setRefreshTick(t => t + 1); pop(1); }}
          />
        )}
        {route.screen === 'gallery' && (
          <GalleryScreen
            theme={theme} db={db} refreshTick={refreshTick}
            onOpenRecord={(r) => push('recordDetail', { record: r, fromGallery: true })}
            columns={galleryColumns} onColumnsChange={handleGalleryColumnsChange}
          />
        )}
        {route.screen === 'settings' && <SettingsScreen theme={theme} mode={mode} setMode={handleSetMode} onBack={() => pop(1)} db={db} onDataRestored={handleDataRestored} />}
        {route.screen === 'datePicker' && (
          <DatePickerScreen
            theme={theme}
            initialDate={route.defaultDateKey}
            onConfirm={(dateKey) => push('pickMachine', { backfillDate: dateKey })}
            onBack={() => onBackfillCancel(true)}
            resolvedThemeName={resolvedThemeName}
          />
        )}
        {route.screen === 'pickMachine' && (
          <MachinePicker
            theme={theme} db={db}
            onPick={(machine) => onMachinePicked(machine, route.backfillDate)}
            onCancel={() => (route.backfillDate ? onBackfillCancel(true) : onRecordFormCancel())}
          />
        )}
        {route.screen === 'recordForm' && (
          <RecordForm
            theme={theme} db={db}
            session={route.initialDate ? null : pendingSession}
            initialDate={route.initialDate}
            machine={route.machine}
            onSave={route.initialDate ? () => onRecordSavedToDay(route.initialDate) : onRecordSaved}
            onCancel={route.initialDate ? () => onBackfillCancel(true) : onRecordFormCancel}
            resolvedThemeName={resolvedThemeName}
          />
        )}
        {route.screen === 'year' && (
          <YearScreen theme={theme} db={db} onBack={atRoot ? undefined : () => pop(1)} onHome={() => switchTab('timer')} onOpenMonth={(monthKey) => push('month', { monthKey })} onAddRecord={startBackfillWithPicker} refreshTick={refreshTick} />
        )}
        {route.screen === 'month' && (
          <MonthScreen theme={theme} db={db} monthKey={route.monthKey} onBack={() => pop(1)} onHome={() => switchTab('timer')} onOpenDay={(dateKey) => push('day', { dateKey })} onAddRecord={startBackfillWithPicker} refreshTick={refreshTick} onNavigateMonth={(mk) => replaceTop({ monthKey: mk })} />
        )}
        {route.screen === 'day' && (
          <DayScreen theme={theme} db={db} dateKey={route.dateKey} onBack={() => pop(1)} onHome={() => switchTab('timer')} onOpenRecord={(r) => push('recordDetail', { record: r })} onAddRecord={startBackfill} refreshTick={refreshTick} />
        )}
        {route.screen === 'recordDetail' && (
          <RecordDetail theme={theme} db={db} record={route.record} onBack={() => pop(1)} onHome={() => switchTab('timer')} onDelete={deleteRecord} onUpdated={onRecordUpdated} resolvedThemeName={resolvedThemeName} />
        )}
      </div>
      {atRoot && (
        <TabBar theme={theme} activeTab={activeTab} onSwitch={switchTab} />
      )}
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
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${machineColumns}, 1fr)`, gap: 7 }}>
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
                              <MIconComp size={machineColumns <= 3 ? 15 : 12} weight="fill" />
                            </div>
                          )}
                          <div style={{ fontSize: machineColumns <= 3 ? 11.5 : 10, fontWeight: 600, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', minWidth: 0 }}>
                            {truncateMachineName(m.name)}
                          </div>
                          {m.photos?.length > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: theme.textFaint }}>
                              <Icon.Image size={9} /><span>{m.photos.length}</span>
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
          placeholder="např. Jeřáb SLUSH02" value={name} onChange={e => setName(e.target.value)}
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
          <img src={photos[lightboxIndex]} onClick={(e) => e.stopPropagation()} style={{ maxWidth: '92vw', maxHeight: '86vh', objectFit: 'contain', borderRadius: 8 }} />
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

function GalleryScreen({ theme, db, refreshTick, onOpenRecord, columns, onColumnsChange }) {
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

      {selectionMode && (
        <div style={{ display: 'flex', gap: 8, padding: '0 16px 14px' }}>
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
      )}

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
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 6 }}>
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
            <img src={current.url} style={{ maxWidth: '92vw', maxHeight: '76vh', objectFit: 'contain', borderRadius: 8 }} />
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
  timerWrap: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', padding: '0 20px', paddingTop: '14vh' },
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
