// 擺位實驗室：讓歐哥親手擺三張卡＋鏡頭，存到 localStorage('poseLab')，主程式照這組姿態取景
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildThumbCanvas } from './thumbs.js';

const CARD_W = 4.0, CARD_H = 2.5, SEG = 32;    // 與 stack.js 相同比例（1.6:1 寬卡）
const KEY = 'poseLab';
const ROLES = ['後面第二張', '後面的卡', '撥開中的卡', '前面被推開的卡', '最前面的卡'];
const HOV = 2;   // 撥開中的卡在陣列裡的位置
const D2R = Math.PI / 180;
const r3 = v => Math.round(v * 1000) / 1000;
const r1 = v => Math.round(v * 10) / 10;

const DEFAULT = {
  fov: 24,
  camera: { pos: [1.098, 6.492, 6.115], target: [0.303, 1.994, -1.161] },
  cards: [
    { pos: [0, 0.767, -1.83], rotX: -10.2, bend: 0, hinge: 0.45 },
    { pos: [0, 0.767, -1.423], rotX: -10.2, bend: 0, hinge: 0.45 },
    { pos: [0, 0.8, -0.45], rotX: 3, bend: 20, hinge: 0.41 },
    { pos: [0, 0.544, 0.2], rotX: 20, bend: 0, hinge: 0.45 },
    { pos: [0, 0.44, 0.65], rotX: 25, bend: 0, hinge: 0.45 },
  ],
};
let state;
try { state = JSON.parse(localStorage.getItem(KEY)) || structuredClone(DEFAULT); }
catch (_) { state = structuredClone(DEFAULT); }
// 舊版只有 3 張：保留歐哥擺好的三張放中間，前後各補一張（照相鄰那張外推）
if (state.cards && state.cards.length === 3) {
  const [b, h, f] = state.cards;
  state.cards = [
    { ...structuredClone(b), pos: [b.pos[0], b.pos[1], r3(b.pos[2] - 0.4)] },
    b, h, f,
    { ...structuredClone(f), pos: [f.pos[0], r3(f.pos[1] - 0.1), r3(f.pos[2] + 0.45)], rotX: f.rotX + 5 },
  ];
}
if (!state.cards || state.cards.length !== 5) state.cards = structuredClone(DEFAULT.cards);

// ---------------------------------------------------------------- scene
const host = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101418');
const camera = new THREE.PerspectiveCamera(state.fov, 1, 0.05, 200);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.8);
gizmo.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; if (!e.value) save(); });
gizmo.addEventListener('objectChange', () => { syncFromObjects(); });
scene.add(gizmo);

// 地板格線：看得出深度
const grid = new THREE.GridHelper(12, 24, 0x2a3442, 0x1c2430);
grid.position.y = -0.001;
scene.add(grid);

// 卡片：group 原點在卡片底邊中點（像立在抽屜裡），mesh 往上偏移半張高
const cards = state.cards.map((c, i) => {
  const geo = new THREE.PlaneGeometry(CARD_W, CARD_H, 1, SEG);
  geo.translate(0, CARD_H / 2, 0);
  const base = geo.attributes.position.array.slice();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  const group = new THREE.Group();
  group.add(mesh);
  group.userData = { i, base };
  scene.add(group);
  return { group, mesh, geo, base };
});

function applyBend(k) {
  const c = state.cards[k], { geo, base } = cards[k];
  const pos = geo.attributes.position;
  const hy = c.hinge * CARD_H, ang = c.bend * D2R;
  for (let v = 0; v < pos.count; v++) {
    const x = base[v * 3], y = base[v * 3 + 1];
    let ny = y, nz = 0;
    if (ang > 0 && y > hy) {
      // 折點以上沿圓弧往後（−z）彎，正面轉向上方的鏡頭：弧長保持不變
      const s = y - hy, L = CARD_H - hy, R = L / ang;
      const th = s / R;
      ny = hy + R * Math.sin(th);
      nz = -R * (1 - Math.cos(th));
    }
    pos.setXYZ(v, x, ny, nz);
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
}

function applyAll() {
  state.cards.forEach((c, k) => {
    const g = cards[k].group;
    g.position.fromArray(c.pos);
    g.rotation.set(c.rotX * D2R, 0, 0);
    applyBend(k);
  });
  camera.fov = state.fov;
  camera.position.fromArray(state.camera.pos);
  orbit.target.fromArray(state.camera.target);
  camera.updateProjectionMatrix();
  orbit.update();
}

function syncFromObjects() {
  state.cards.forEach((c, k) => {
    const g = cards[k].group;
    c.pos = g.position.toArray().map(r3);
    c.rotX = r1(g.rotation.x / D2R);
  });
  refreshPanel();
}

// 真實檔案當卡面：拿設定裡的第一個根目錄（沒有就退回磁碟根），挑幾個 .md 畫縮圖
async function pickSampleFiles() {
  const drv = await (await fetch('/api/drives')).json();
  const dirs = [...(drv.roots || []), ...(drv.drives || []).map(d => d.path)].slice(0, 4);
  for (const dir of dirs) {
    try {
      const d = await (await fetch('/api/list?path=' + encodeURIComponent(dir) + '&exts=.md')).json();
      const files = (d.files || []).filter(f => f.kind);
      if (files.length) return files.slice(0, 5);
    } catch (_) {}
  }
  return [];
}
(async () => {
  try {
    const files = await pickSampleFiles();
    if (!files.length) return;
    for (let k = 0; k < 5 && k < files.length; k++) {
      const cv = await buildThumbCanvas(files[k]);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      cards[k].mesh.material.map = tex;
      cards[k].mesh.material.needsUpdate = true;
    }
  } catch (e) { console.warn('卡面載入失敗，改用白卡', e); }
})();

// ---------------------------------------------------------------- selection
let sel = HOV;
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || gizmo.dragging) return;
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = raycaster.intersectObjects(cards.map(c => c.mesh), false)[0];
  if (hit) select(cards.findIndex(c => c.mesh === hit.object));
});
function select(k) {
  sel = k;
  gizmo.attach(cards[k].group);
  refreshPanel();
}

// ---------------------------------------------------------------- panel
const $ = id => document.getElementById(id);
const pickEl = $('pick');
ROLES.forEach((name, k) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = () => select(k);
  pickEl.appendChild(b);
});
function bindSlider(id, get, set, fmt, def) {
  const s = $('s' + id), v = $('v' + id);
  s.addEventListener('input', () => { set(Number(s.value)); v.textContent = fmt(Number(s.value)); save(); });
  $('r' + id).onclick = () => { set(def()); s.value = get(); v.textContent = fmt(get()); save(); };
  return () => { s.value = get(); v.textContent = fmt(get()); };
}
const refreshers = [
  bindSlider('Tilt', () => state.cards[sel].rotX, x => { state.cards[sel].rotX = x; cards[sel].group.rotation.x = x * D2R; }, x => x + '°', () => DEFAULT.cards[sel].rotX),
  bindSlider('Bend', () => state.cards[sel].bend, x => { state.cards[sel].bend = x; applyBend(sel); }, x => x + '°', () => DEFAULT.cards[sel].bend),
  bindSlider('Hinge', () => Math.round(state.cards[sel].hinge * 100), x => { state.cards[sel].hinge = x / 100; applyBend(sel); }, x => x + '%', () => Math.round(DEFAULT.cards[sel].hinge * 100)),
  bindSlider('Fov', () => state.fov, x => { state.fov = x; camera.fov = x; camera.updateProjectionMatrix(); }, x => x + '°', () => DEFAULT.fov),
];
function refreshPanel() {
  [...pickEl.children].forEach((b, k) => b.classList.toggle('on', k === sel));
  refreshers.forEach(f => f());
  $('json').value = JSON.stringify(exportState(), null, 1);
}
function setMode(m) {
  gizmo.setMode(m);
  $('mT').classList.toggle('on', m === 'translate');
  $('mR').classList.toggle('on', m === 'rotate');
}
$('mT').onclick = () => setMode('translate');
$('mR').onclick = () => setMode('rotate');
addEventListener('keydown', e => {
  if (e.key === 'w' || e.key === 'W') setMode('translate');
  if (e.key === 'e' || e.key === 'E') setMode('rotate');
});
$('camFront').onclick = () => { camera.position.set(0, 1.4, 10.5); orbit.target.set(0, 1.3, -0.3); orbit.update(); save(); };
$('camTop').onclick = () => { camera.position.set(0, 5.2, 9.5); orbit.target.set(0, 1.3, -0.3); orbit.update(); save(); };
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('json').value); flash('已複製'); }
  catch (_) { $('json').select(); flash('請按 Ctrl+C'); }
};
$('rPos').onclick = () => { state.cards[sel].pos = [...DEFAULT.cards[sel].pos]; cards[sel].group.position.fromArray(state.cards[sel].pos); save(); };
$('rCam').onclick = () => { camera.position.fromArray(DEFAULT.camera.pos); orbit.target.fromArray(DEFAULT.camera.target); orbit.update(); save(); };
$('reset').onclick = () => { state = structuredClone(DEFAULT); applyAll(); select(HOV); save(); };

// 匯出：卡片姿態＋鏡頭（含相對於「後面的卡」的間距，方便主程式換算）
function exportState() {
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  return {
    v: 1, savedAt: new Date().toISOString(),
    viewport: { w, h, aspect: r3(w / Math.max(1, h)) },
    fov: state.fov,
    camera: { pos: camera.position.toArray().map(r3), target: orbit.target.toArray().map(r3) },
    cards: state.cards.map((c, k) => ({ role: ROLES[k], ...c })),
    // 每張相對「撥開中的卡」的前後(z)與高低(y)差
    relToHovered: state.cards.map((c, k) => ({ role: ROLES[k],
      dz: r3(c.pos[2] - state.cards[HOV].pos[2]), dy: r3(c.pos[1] - state.cards[HOV].pos[1]) })),
  };
}
let saveTimer = 0;
function save() {
  state.camera = { pos: camera.position.toArray().map(r3), target: orbit.target.toArray().map(r3) };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); localStorage.setItem(KEY + 'Export', JSON.stringify(exportState())); flash('已存'); }
    catch (_) {}
    refreshPanel();
  }, 150);
}
orbit.addEventListener('end', save);
function flash(t) { $('saved').textContent = ' ' + t; setTimeout(() => { $('saved').textContent = ''; }, 1200); }

// ---------------------------------------------------------------- loop
function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
applyAll();
select(HOV);
renderer.setAnimationLoop(() => { orbit.update(); renderer.render(scene, camera); });
