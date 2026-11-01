// WebGL file-stack scene: upright cards in depth, hover-part physics,
// click-to-extract flights, virtualized texture pool, idle render stop.
import * as THREE from 'three';
import { P, P_RANGES, P_DEFAULTS, TOOLBAR_H, toolbarH, clamp, damp, easeInOutCubic, saveParams, kindOf, shortHash, theme, themeGen } from './util.js';
import { t } from './i18n.js';
import { placeholderCanvas, sharedPlaceholderCanvas, requestThumb, pumpThumbs, thumbQueueSize } from './thumbs.js';

const CARD_W = 4.0, CARD_H = 2.5;       // 寬卡 1.6:1，與縮圖畫布 1280×800 同比例（卡面不會被拉歪）
const POOL_N = 30;                      // pool slots (virtual window + margin)
const SEG = 32;                         // 卡片垂直分段：上半部翻平用 CPU 彎（raycast 才打得到彎過的形狀）

// ---- 歐哥在擺位實驗室親手擺的五張卡（2026-10-29），主程式照抄，不再自動解算 ----
// u = 卡的序號 − 焦點位置（scrollCur）。u=0：正中央被抽起來看的那張；u>0 在後面；u<0 在前面。
// 各欄是卡片「底邊中點」的世界座標與姿態，u 介於整數之間用平滑曲線內插 →
// 滾動時每張卡沿著這條弧線往前走（鏡頭不動），不會直線飛、也不會越走越小。
const KEY_U0 = -3;                                    // 下列陣列第 0 格對應的 u
const KEY_Z = [1.55, 1.1, 0.65, 0, -0.973, -1.38, -1.5];
const KEY_Y = [-0.46, -0.36, -0.256, 0, -0.033, -0.033, -0.033];
const KEY_S = [1, 1, 1, 1, 1, 1, 1];                  // 各格縮放（目前全 1；2026-10-30 試過前排縮小的拋物線，歐哥說變差已退回）
const KEY_R = [30, 25, 20, 3, -10.2, -10.2, -10.2];   // 繞底邊傾斜（度）：+ 往鏡頭倒，− 往後仰
const KEY_B = [0, 0, 0, 20, 0, 0, 0];                 // 上半部往後翻平的角度（度）
const BACK_STEP = 0.12;                               // u>2 更後面的卡每張只再往後這麼多：疊緊，只露檔名列，整疊不衝出畫面頂
const FRONT_STEP = 0.45;
const BASE = [0, 0.8, -0.45];                         // u=0 那張的底邊中點
const FOCUS_HINGE = 0.41;                             // 翻平折點（卡高比例，從底邊算）
const POSE_PITCH = 41.03;                             // 鏡頭俯角（度，歐哥擺的）
const FIT_PAD = 0.95;                                 // 取景：整疊佔畫面 95%（四邊各留一點點）
// 使用者自己轉視角的範圍（像 2.5D 遊戲：只能左右晃、上下點頭一點，不會翻到底下往上看）
const ORBIT_YAW = 30;                                 // 左右各最多 30°
const ORBIT_PITCH = [22, 65];                         // 俯角範圍（度）
const ORBIT_ZOOM = [0.7, 1.8];                        // 拉近拉遠倍率
// 「視角偏離我的視角」的容差（度／倍率）
const VIEW_ANGLE_EPS = 1.5, VIEW_ZOOM_EPS = 0.03;
const VIS_BACK = 4;                                   // 焦點後面最多顯示幾張（最後一張淡出）
const SCROLL_VMAX = 6;                                // 近距離（差 ≤ SCROLL_NEAR 張）的最高速度（張/秒）：字一路看得清
const SCROLL_NEAR = 2;                                // 差幾張以內維持慢速
const SCROLL_VMAX_FAR = 60;                           // 差很多張時的最高速度：滾三圈 ≈ 30 張要在 1 秒左右追到
const SCROLL_ACCEL = 3.5;                             // 每多差一張，速度上限多幾張/秒（越接近目標越慢＝自然煞車）
const SCROLL_JUMP = 40;                               // 差超過這麼多張就先瞬移到目標前 3 張，不一路刷過去
const WHEEL_LEAD = 200;                               // 滾輪最多領先目前位置幾張：夠大＝滾了幾格就走幾張，不丟格
const WHEEL_SNAP_MS = 160;                            // 停手多久後吸到最近一張
const TEX_LRU_LIMIT = 60;
const OUT_MS = 250;                     // old stack sinks
const IN_STAGGER = 24;                  // ms per display-depth step when rising
const NEAR_PH = VIS_BACK + 1;           // |u| 在這範圍內才同步畫專屬 placeholder（更遠的反正看不見）

// u 位置的姿態：Catmull-Rom 平滑內插（過每個關鍵點、一階連續 → 卡片走弧線、速度不跳）
function keyAt(arr, u) {
  const n = arr.length, x = u - KEY_U0;
  if (x <= 0) return arr[0] + (arr[0] - arr[1]) * -x;          // 更前面：照最後一段外推
  if (x >= n - 1) return arr[n - 1] + (arr[n - 1] - arr[n - 2]) * (x - n + 1);
  const i = Math.floor(x), t = x - i;
  const p0 = arr[Math.max(0, i - 1)], p1 = arr[i], p2 = arr[i + 1], p3 = arr[Math.min(n - 1, i + 2)];
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
}
function poseAt(u) {
  const last = KEY_U0 + KEY_Z.length - 1;
  let z;
  if (u > last) z = KEY_Z[KEY_Z.length - 1] - BACK_STEP * (u - last);
  else if (u < KEY_U0) z = KEY_Z[0] + FRONT_STEP * (KEY_U0 - u);
  else z = keyAt(KEY_Z, u);
  // 最前面那張（u<−2）不再半透明淡出（淡出中的半透明卡疊在別張上＝殘影）：
  // 改成實心往前下方倒出畫面，出了畫面才消失
  const ex = Math.max(0, -2 - u);
  const uc = clamp(u, -2, last);
  const op = u < -2 ? (ex < 0.9 ? 1 : clamp((1.2 - ex) / 0.3, 0, 1)) : clamp(VIS_BACK + 0.5 - u, 0, 1);
  return {
    y: BASE[1] + keyAt(KEY_Y, uc) - 2.2 * ex, z: BASE[2] + (u < -2 ? keyAt(KEY_Z, -2) + 0.6 * ex : z),
    rot: (keyAt(KEY_R, uc) + 25 * ex) * Math.PI / 180,
    scale: keyAt(KEY_S, uc),
    bend: Math.max(0, Math.abs(u) < 1 ? keyAt(KEY_B, u) : 0) * Math.PI / 180,
    op
  };
}

export class StackScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(theme().scene);
    this.camera = new THREE.PerspectiveCamera(P.fov, 1, 0.1, 100);   // fov 可調（預設 30：弱透視、卡面接近矩形）

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x223040, 1.0));
    const dl = new THREE.DirectionalLight(0xfff2dd, 1.2);
    dl.position.set(6, 10, 8);
    this.scene.add(dl);

    this.raycaster = new THREE.Raycaster();
    this.pointerNdc = new THREE.Vector2();
    this.camQuat = new THREE.Quaternion();
    this.files = [];
    this.view = [];                   // name-filtered view of files
    this.visShown = VIS_BACK;         // 焦點後面顯示幾張

    // （地板拿掉了：被燈光照到後顏色比背景深一截，亮色主題下整片變灰褐色）

    // auto-framing camera state: fitTarget = where the fit wants us, fitCur = damped actual
    this.orbit = { yaw: 0, pitch: POSE_PITCH, zoom: 1 };   // 使用者轉的視角（右鍵拖、Ctrl+滾輪、雙擊回正）
    // 開頁／F5／重開 App：存過「我的視角」就直接用它，沒存過才用預設視角
    this.applyFavView();
    this.onViewChange = null;         // main.js 接線：視角跟「我的視角」不同時提示存／回
    this.fitTarget = { target: new THREE.Vector3(), dist: 12, pitch: POSE_PITCH, yaw: 0 };
    this.fitCur = { target: new THREE.Vector3(), dist: 12, pitch: POSE_PITCH, yaw: 0 };
    this.compactFit = false;          // 側邊欄窄欄：焦點卡幾乎填滿欄寬（main.js 依 ?mode=panel 開）
    this.frameTargets();
    this.fitCur.target.copy(this.fitTarget.target);
    this.fitCur.dist = this.fitTarget.dist;
    this.fitCur.pitch = this.fitTarget.pitch;     // 第一幀就站在（可能存過的）視角上，不用等阻尼
    this.fitCur.yaw = this.fitTarget.yaw;
    this.applyCameraPose();

    // ---- pool ----------------------------------------------------------------
    // 每張卡自己一份 32 段幾何：上半部翻平直接改頂點（CPU），raycast 打到的就是畫面上看到的形狀
    this.slots = [];
    for (let i = 0; i < POOL_N; i++) {
      const geo = new THREE.PlaneGeometry(CARD_W, CARD_H, 1, SEG);
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.slots.push({
        mesh, geo, base: geo.attributes.position.array.slice(), geoBend: 0,
        file: null, fileIdx: -1, mode: 'home',
        d: i, yOff: 0, scale: 1, opacity: 0, bend: 0,
        stage: null, thumbReqPath: null, texName: null, phShared: false
      });
    }

    // depth testing handles the rare overlaps; alpha fade still works.

    // ---- state ----------------------------------------------------------------
    this.nameFilter = '';
    this.folderLabel = '';
    this.scrollTarget = 0; this.scrollCur = 0; this.scrollVel = 0;
    this.lastUserScrollAt = 0;        // 最近一次「真人滾輪／拖曳捲動」的時間戳（分頁模式定位用它分辨使用者已接手）
    this.hoverD = null;               // display depth under cursor (float) or null
    this._hoverCand = null;           // 延遲 hover 的候選深度（dwell 中）
    this._hoverCandT = 0;             // 候選開始時間（performance.now）
    this.phase = 'idle';              // idle | out | in
    this.phaseT0 = 0;
    this.pendingFiles = null;
    this.extracted = null;            // slot being read
    this.selected = new Set();        // 多選中的檔案路徑
    this.motionLevel = 0;
    this.viewCss = { x: 0, w: 1, tx: 0, tw: 1 }; // current + target viewport (css px)
    this.lastFolderSwitchMs = 0;
    this.fpsRing = [];
    this.onCardClick = null;          // set by main.js
    this.onClickIntercept = null;     // set by main.js；回 true＝吞掉這次點擊（分頁模式：點卡＝切分頁，不開閱讀區）
    this.onStageArrived = null;
    this.rafId = null;
    this.wakeUntil = 0;
    this.lastT = performance.now();

    this.texCache = new Map();        // path -> {tex, t}
    this.phCache = new Map();         // filekey -> {tex, t}
    this.lruClock = 0;

    // 「第 a–b 張 / 共 N」指示器：跟著堆視區右下角，由 tick 更新（有動才重寫）
    this.countEl = document.createElement('div');
    this.countEl.id = 'stackCount';
    document.body.appendChild(this.countEl);
    this._countText = '';

    // tick 裡會 damp 到 fitTarget；這裡只需確保狀態存在（首次 applyCamera 已在前面做過）

    this.bindPointer();
    addEventListener('themechange', () => this.retheme());
    this.resize();
    addEventListener('resize', () => { this.resize(); this.poke(); });
  }

  // ------------------------------------------------------------- camera/layout
  // 取景：鏡頭角度＝歐哥擺的俯角（＋使用者自己轉的左右/上下），距離與位置每幀自動解：
  // 把整條弧（前一張完整、最前一張只算上緣、後面 VIS_BACK 張、焦點卡翻平後的頂）
  // 塞滿堆視區的 95%——窄欄就照寬度塞滿、寬欄就照高度塞滿，不再留大片黑邊。
  arcPoints() {
    if (this._arcPts) return this._arcPts;
    const pts = [], hw = CARD_W / 2;
    for (let u = -2; u <= VIS_BACK - 1; u++) {
      const ps = poseAt(u), cA = Math.cos(ps.rot), sA = Math.sin(ps.rot);
      const local = [];
      if (u > -2) local.push([0, 0]);                   // 底邊（最前那張底邊本來就出畫面，不算）
      if (ps.bend > 1e-4) {
        const hy = FOCUS_HINGE * CARD_H, R = (CARD_H - hy) / ps.bend;
        local.push([hy + R * Math.sin(ps.bend), -R * (1 - Math.cos(ps.bend))]);
      } else local.push([CARD_H, 0]);
      for (const [ly, lz] of local) for (const x of [-hw, hw])
        pts.push([x, ps.y + ly * cA - lz * sA, ps.z + ly * sA + lz * cA]);
    }
    return (this._arcPts = pts);
  }
  frameTargets() {
    if (Math.abs(this.camera.fov - P.fov) > 1e-4) { this.camera.fov = P.fov; this.camera.updateProjectionMatrix(); }
    const asp = Math.max(0.05, this.camera.aspect);
    const o = this.orbit;
    const th = o.pitch * Math.PI / 180, yw = o.yaw * Math.PI / 180;
    // d：看點→相機的方向；f：相機往前；r：右；v：上
    const d = new THREE.Vector3(Math.sin(yw) * Math.cos(th), Math.sin(th), Math.cos(yw) * Math.cos(th));
    const f = d.clone().negate();
    const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(r, f);
    const tV = Math.tan(this.camera.fov * Math.PI / 360) * FIT_PAD, tH = tV * asp;
    const P3 = this.arcPoints().map(p => {
      const w = new THREE.Vector3(p[0], p[1], p[2]);
      return [w.dot(r), w.dot(v), w.dot(f)];
    });
    // 相機在 (cr, cv, cf)（r/v/f 座標）。給定 cf，左右/上下可行區間交集非空就放得下；二分找最靠近的 cf
    const feasible = cf => {
      let rl = -Infinity, rh = Infinity, vl = -Infinity, vh = Infinity;
      for (const [xr, xv, xf] of P3) {
        const dep = xf - cf;
        if (dep < 0.5) return null;
        rl = Math.max(rl, xr - tH * dep); rh = Math.min(rh, xr + tH * dep);
        vl = Math.max(vl, xv - tV * dep); vh = Math.min(vh, xv + tV * dep);
      }
      return rl <= rh && vl <= vh ? { cr: (rl + rh) / 2, cv: (vl + vh) / 2 } : null;
    };
    let lo = -200, hi = Math.min(...P3.map(p => p[2])) - 0.5;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (feasible(m)) lo = m; else hi = m; }
    const sol = feasible(lo);
    if (!sol) return;
    const cam = r.clone().multiplyScalar(sol.cr).addScaledVector(v, sol.cv).addScaledVector(f, lo);
    // 看點取「相機往前、深度到焦點卡」的位置；拉近拉遠＝沿視線縮放距離
    const focusDepth = new THREE.Vector3(0, 1.6, -0.45).sub(cam).dot(f);
    const dist0 = Math.max(1, focusDepth);
    this.fitTarget.target.copy(cam).addScaledVector(f, dist0);
    let dist = dist0 / o.zoom;
    if (this.compactFit) {
      // 窄欄（側邊欄）：整條弧塞進去會讓卡變一小塊。直接量焦點卡「在畫面上最寬
      // 的部位」的投影寬（底邊＋向前捲的頂角，含相機姿態與卡面傾斜），兩三步收斂
      // 到佔欄寬 94%（400px 欄≈左右各留 12px）；後排卡露出上緣即可。
      const tanH = Math.tan(this.camera.fov * Math.PI / 360) * asp;
      const ps0 = poseAt(0), cA = Math.cos(ps0.rot), sA = Math.sin(ps0.rot), hw = CARD_W / 2;
      const local = [[0, 0]];                                     // 底邊
      if (ps0.bend > 1e-4) {
        const hy = FOCUS_HINGE * CARD_H, R = (CARD_H - hy) / ps0.bend;
        local.push([hy + R * Math.sin(ps0.bend), -R * (1 - Math.cos(ps0.bend))]);   // 捲起的頂
      } else local.push([CARD_H, 0]);
      const corners = [];
      for (const [ly, lz] of local) for (const x of [-hw, hw])
        corners.push(new THREE.Vector3(x, ps0.y + ly * cA - lz * sA, ps0.z + ly * sA + lz * cA));
      for (let i = 0; i < 3; i++) {
        const camPos = this.fitTarget.target.clone().addScaledVector(f, -dist);
        const ndc = pt => pt.clone().sub(camPos).dot(r) / (tanH * pt.clone().sub(camPos).dot(f));
        let half = 0;
        for (let k = 0; k < corners.length; k += 2)
          half = Math.max(half, Math.abs(ndc(corners[k + 1]) - ndc(corners[k])) / 2);
        if (Math.abs(half - 0.94) < 0.005) break;
        dist = Math.max(1, dist * (half / 0.94));
      }
    }
    this.fitTarget.dist = dist;
    this.fitTarget.pitch = o.pitch;
    this.fitTarget.yaw = o.yaw;
    this.visShown = VIS_BACK;
    this.gapUsed = BACK_STEP;
  }
  applyCamera() { this.frameTargets(); }
  setFitOverride(o) { this._fitOverride = o; this.poke(); }
  // 窄欄專用大卡取景：切換後立即重算並到位（不走 damp，避免欄寬拖影）
  setCompactFit(on) {
    this.compactFit = !!on;
    this.frameTargets();
    this.fitCur.target.copy(this.fitTarget.target);
    this.fitCur.dist = this.fitTarget.dist;
    this.fitCur.pitch = this.fitTarget.pitch;
    this.fitCur.yaw = this.fitTarget.yaw;
    this.applyCameraPose();
    this.poke();
  }
  applyCameraPose() {
    const th = this.fitCur.pitch * Math.PI / 180, yw = (this.fitCur.yaw || 0) * Math.PI / 180;
    this._camDir = this._camDir || new THREE.Vector3();
    this._camDir.set(Math.sin(yw) * Math.cos(th), Math.sin(th), Math.cos(yw) * Math.cos(th));
    this.camera.position.copy(this.fitCur.target).addScaledVector(this._camDir, this.fitCur.dist);
    this.camera.lookAt(this.fitCur.target);
    this.camera.getWorldQuaternion(this.camQuat);
  }

  resize() {
    const w = innerWidth, h = innerHeight - toolbarH();
    this.renderer.setSize(w, h);
    this.viewCss.w = this.viewCss.tw = w - this.viewCss.x;
    this.poke();
  }

  // animated viewport inside the full-width canvas (stack column) — css px
  setViewportTarget(x, w) {
    this.viewCss.tx = x; this.viewCss.tw = w;
    this.poke();
  }
  // immediate set (driven per-frame by the layout tween in main.js)
  setViewportNow(x, w) {
    const v = this.viewCss;
    v.x = v.tx = x; v.w = v.tw = Math.max(0, w);
    // three.js setViewport/setScissor 吃 CSS px，內部自己乘 pixelRatio；這裡再乘 dpr 會在縮放≠100% 時錯位
    const hCss = this.canvas.clientHeight || (innerHeight - toolbarH());
    const wCss = Math.max(1, w);
    this.renderer.setViewport(x, 0, wCss, hCss);
    this.renderer.setScissor(x, 0, wCss, hCss);
    const asp = Math.max(0.05, w) / Math.max(1, hCss);
    if (Math.abs(this.camera.aspect - asp) > 0.001) {
      this.camera.aspect = asp;
      this.camera.updateProjectionMatrix();
      this.camera.getWorldQuaternion(this.camQuat);
    }
    // 欄位佈局的改變（開關閱讀欄、拖分隔線、視窗縮放）一律立即到位：
    // 直接重算取景並套用，不讓相機 damp 好幾幀滑過去——使用者看到的是卡堆
    // 因為欄寬改變而整欄滑動，像卡頓。卡片自己的動畫（翻面、抽出、捲動）不受影響。
    if (!this._fitOverride) {
      this.frameTargets();
      this.fitCur.target.copy(this.fitTarget.target);
      this.fitCur.dist = this.fitTarget.dist;
      this.fitCur.pitch = this.fitTarget.pitch;
      this.fitCur.yaw = this.fitTarget.yaw;
      this.applyCameraPose();
    }
    this.poke();
  }
  viewportDelta() {
    return Math.abs(this.viewCss.x - this.viewCss.tx) + Math.abs(this.viewCss.w - this.viewCss.tw);
  }
  applyViewport(dt) {
    const v = this.viewCss;
    v.x = damp(v.x, v.tx, 11, dt);
    v.w = damp(v.w, v.tw, 11, dt);
    if (Math.abs(v.x - v.tx) < 0.5) v.x = v.tx;
    if (Math.abs(v.w - v.tw) < 0.5) v.w = v.tw;
    const hCss = this.canvas.clientHeight || (innerHeight - toolbarH());
    const wCss = Math.max(1, v.w);
    this.renderer.setViewport(v.x, 0, wCss, hCss);
    this.renderer.setScissor(v.x, 0, wCss, hCss);
    const asp = Math.max(0.05, v.w / Math.max(1, hCss));
    if (Math.abs(this.camera.aspect - asp) > 0.001) {
      this.camera.aspect = asp;
      this.camera.updateProjectionMatrix();
      this.camera.getWorldQuaternion(this.camQuat);
    }
  }

  // ------------------------------------------------------------- textures
  makeTex(canvasEl) {
    const t = new THREE.CanvasTexture(canvasEl);
    t.anisotropy = 4;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  placeholderTex(file) {
    const key = kindOf(file) + '|' + file.name + '|' + file.size + '|' + file.mtime + (file.secret ? '|⚠' : '');
    let e = this.phCache.get(key);
    if (!e) {
      e = { tex: this.makeTex(placeholderCanvas(file)), key };
      this.phCache.set(key, e);
      if (this.phCache.size > 80) {
        const k0 = this.phCache.keys().next().value;
        this.phCache.get(k0).tex.dispose();
        this.phCache.delete(k0);
      }
    }
    return e.tex;
  }
  // 遠卡共用的灰骨架（無檔名列）：綁卡時只替「焦點附近」的卡畫專屬 placeholder，
  // 更遠的卡（反正淡出到看不見）用同一張——大資料夾／21+ 分頁進場時，原本一次
  // 同步畫 30 張 placeholder（每張都是 canvas＋逐字 measureText 省略）會併成一個
  // 50–100ms+ 的長任務，開啟後第一下滑動就被它卡住。
  // 分頁模式的遠卡有自己的共用骨架（右上角畫 ×），跟檔案模式的灰骨架分開快取
  sharedPhTex(file) {
    const isTab = !!(file && file.tab && !file.tab.note);
    const KEY = isTab ? '|shared-ph-tab|' : '|shared-ph|';
    let e = this.phCache.get(KEY);
    if (!e) {
      e = { tex: this.makeTex(sharedPlaceholderCanvas(isTab)), key: KEY };
      this.phCache.set(KEY, e);
    }
    return e.tex;
  }
  texGet(path) {
    const e = this.texCache.get(path);
    if (e) { e.t = ++this.lruClock; return e.tex; }
    return null;
  }
  texSet(path, tex) {
    this.texCache.set(path, { tex, t: ++this.lruClock });
    while (this.texCache.size > TEX_LRU_LIMIT) {
      let oldestKey = null, oldestT = Infinity;
      for (const [k, v] of this.texCache) if (v.t < oldestT) { oldestT = v.t; oldestKey = k; }
      const e = this.texCache.get(oldestKey);
      this.texCache.delete(oldestKey);
      e.tex.dispose();
      for (const s of this.slots) {
        if (s.mesh.material.map === e.tex && s.file) {
          s.mesh.material.map = this.placeholderTex(s.file);
          s.mesh.material.needsUpdate = true;
          s.texName = s.file.name;      // 換回本檔 placeholder，貼圖身分跟著檔走
          s.phShared = false;
          s.thumbReqPath = null; // allow re-request when visible again
        }
      }
    }
  }

  // ------------------------------------------------------------- data binding
  gap() { return BACK_STEP; }
  winCap() { return VIS_BACK + 4; }
  // 焦點可以停在每一張（最後一張也能被抽到正中央）
  scrollMax() { return Math.max(0, this.view.length - 1); }

  setFolder(label, files, page) {
    this.folderLabel = label;
    this.t0Switch = performance.now();
    this.scrollTarget = 0; this.scrollCur = 0; this.scrollVel = 0;
    this.hoverD = null;
    if (this.extracted) this.returnExtracted(true);
    const filtered = this.applyNameFilter(files);
    // 換資料夾＝直接換上新的一疊（不再有「舊的沉下去、新的從下面升上來」的動畫：
    // 滑鼠在樹上掃過時那 0.5 秒反而像卡頓）
    this.pendingFiles = null;
    this.files = files; this.view = filtered;
    // 分頁（大資料夾首頁 ~300 張）：total 是伺服器給的總數，捲到底前 ~60 張自動續頁
    this.total = page && typeof page.total === 'number' ? page.total : files.length;
    this.hasMore = !!(page && page.hasMore && page.fetchMore);
    this.moreLoader = page ? page.fetchMore : null;
    this.loadingMore = false;
    this.clearSelection();
    this.rebindAll(true);
    for (const s of this.slots) if (s.mode === 'home') { s.yOff = 0; s.opacity = 0; }
    this.phase = 'idle';
    this.lastFolderSwitchMs = Math.round(performance.now() - this.t0Switch);
    this.applyCamera();
    this.poke();
    this.notifySelection();   // 換資料夾後全選鈕狀態歸零（放在 rebindAll 之後，viewCss 才是新的）
  }

  // 接近已載入部分的尾端時抓下一頁（抓完 append，不打斷捲動）；
  // 檔名篩選中不續頁（篩選針對已載入的視窗）。
  maybeRequestMore() {
    if (!this.hasMore || this.loadingMore || !this.moreLoader) return;
    if (this.nameFilter && this.nameFilter.trim()) return;
    if (this.files.length - this.scrollTarget > 60 && this.files.length - this.scrollCur > 60) return;
    this.loadingMore = true;
    const loader = this.moreLoader;
    loader().then(r => {
      this.loadingMore = false;
      if (!r || !r.files || !r.files.length) return;
      this.files.push(...r.files);
      this.total = typeof r.total === 'number' ? r.total : this.files.length;
      this.hasMore = !!r.hasMore;
      this.view = this.applyNameFilter(this.files);
      this.rebindAll(false);
      this.poke();
      this.notifySelection();   // 續頁多了檔案，全選鈕狀態要跟著重算
    }, () => { this.loadingMore = false; });
  }

  switchReading(idx) {
    const f = this.view[idx];
    if (!f) return;
    this.extracted = null; this.extractedFile = null;   // 舊的那張早就回到卡堆了，不用飛回
    if (this.onCardClick) this.onCardClick(f);
    this.poke();
  }

  // ---- 多選（批次處理用）：以檔案路徑記，捲動、排序都不會掉
  selectClick(idx, range) {
    const f = this.view[idx];
    if (!f) return;
    if (range && this._selAnchor != null) {
      const a = Math.min(this._selAnchor, idx), b = Math.max(this._selAnchor, idx);
      for (let i = a; i <= b; i++) this.selected.add(this.view[i].path);
    } else {
      if (this.selected.has(f.path)) this.selected.delete(f.path); else this.selected.add(f.path);
      this._selAnchor = idx;
    }
    this.selChanged();
  }
  // 整個目前視圖都已選取（空視圖不算「全選」）
  allSelected() { const v = this.view; return v.length > 0 && v.every(f => this.selected.has(f.path)); }
  selectAll() { for (const f of this.view) this.selected.add(f.path); this.selChanged(); }
  // 「全選」按鈕／Ctrl+A 是切換：已全選→清空，否則全選（部分選取也變全選）
  toggleSelectAll() { if (!this.view.length) return; if (this.allSelected()) this.clearSelection(); else this.selectAll(); }
  clearSelection() { if (!this.selected.size) return; this.selected.clear(); this._selAnchor = null; this.selChanged(); }
  selectedFiles() { return this.view.filter(f => this.selected.has(f.path)); }
  selChanged() { this.poke(); this.notifySelection(); }
  // 選取沒變、但「目前視圖」換了（篩選／續頁／換資料夾）時，也要讓外面重算全選鈕狀態
  notifySelection() { if (this.onSelection) this.onSelection(this.selectedFiles()); }

  // 排序：new/old 依修改時間、big/small 依大小、name 依檔名（自然排序：file2 < file10）
  setSort(mode) {
    this.sortMode = mode;
    this.view = this.applyNameFilter(this.files);
    this.scrollTarget = 0; this.scrollCur = 0; this.scrollVel = 0;
    this.rebindAll(true);
    this.poke();
  }
  sorted(files) {
    const m = this.sortMode || 'new', a = files.slice();
    const coll = this._coll || (this._coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }));
    if (m === 'new') a.sort((x, y) => y.mtime - x.mtime);
    else if (m === 'old') a.sort((x, y) => x.mtime - y.mtime);
    else if (m === 'big') a.sort((x, y) => y.size - x.size);
    else if (m === 'small') a.sort((x, y) => x.size - y.size);
    else if (m === 'name') a.sort((x, y) => coll.compare(x.name, y.name));
    return a;
  }
  // 檔名篩選的「過濾」半（排序交給 sorted）：keepOrder 路徑也重用這裡，免得兩份實作漂移
  nameFilterMatch(files) {
    const q = (this.nameFilter || '').trim().toLowerCase();
    return q ? files.filter(f => String(f.name || '').toLowerCase().includes(q)) : files.slice();
  }
  applyNameFilter(files) {
    return this.sorted(this.nameFilterMatch(files));
  }
  setNameFilter(q) {
    this.nameFilter = q;
    this.view = this.applyNameFilter(this.files);
    this.scrollTarget = 0; this.scrollCur = 0; this.scrollVel = 0;
    this.rebindAll(true);
    this.poke();
    this.notifySelection();   // 清單變了，全選鈕狀態要跟著重算
  }

  windowBase() { return Math.floor(this.scrollCur) - 3; }

  // 使用者正在捲／阻尼還沒停：這段時間內不換清單，免得位置被拉走
  scrollBusy() {
    return this.dragging === true
      || performance.now() < (this.wheelUntil || 0)
      || Math.abs(this.scrollTarget - this.scrollCur) > 0.02
      || Math.abs(this.scrollVel) > 0.05;
  }

  // 清單就地更新（分頁模式專用）：不重置相機、不重播進場動畫、不把位置歸零。
  // anchorPath＝更新前在最前面的那張卡，用它換算更新後的位置；它被關掉了就停在
  // 原本的索引（夾在範圍內）。內容真的變了的卡只丟它的貼圖 → 讓卡堆只重畫那幾張。
  // opts.keepOrder：呼叫端已經把順序排好（分頁模式的「一局內凍結順序」），
  // 這裡只套用檔名篩選、不再照排序模式重排——不然點分頁 → lastAccessed 更新 →
  // 那張卡跳到最前，整疊瞬間亂跳。回傳被改到的 path 陣列。
  updateFilesInPlace(files, anchorPath, opts) {
    const keepOrder = !!(opts && opts.keepOrder);
    const oldView = this.view;
    const oldFocus = clamp(Math.round(this.scrollCur), 0, Math.max(0, oldView.length - 1));
    // 卡面「畫得出來的」東西才算：標題／網址／favicon／截圖版本／頁面文字，
    // 加上檔名列上的日期與「目前分頁」標記（這兩個也只有重畫才會變）。
    // 長字串（favicon data URL、頁面文字）先收成雜湊再比。
    const sig = f => f ? [f.name, f.tab && f.tab.title, shortHash(f.tab && f.tab.url),
      shortHash(f.tab && f.tab.fav), f.tab && (f.tab.hasShot ? 1 : 0), f.tab && f.tab.shotVer,
      shortHash(f.tab && f.tab.text), f.mtime, f.tab && (f.tab.active ? 1 : 0),
      f.localPath || '', f.builtin ? 1 : 0].join('\u0000') : '';
    const oldByPath = new Map(oldView.map(f => [f.path, sig(f)]));
    const changed = [];
    for (const f of files) {
      const before = oldByPath.get(f.path);
      if (before !== undefined && before !== sig(f)) changed.push(f.path);
    }

    const filtered = keepOrder
      ? this.nameFilterMatch(files)
      : this.applyNameFilter(files);
    this.files = files.slice();
    this.view = filtered;
    this.total = files.length;
    this.hasMore = false;
    this.moreLoader = null;
    this.loadingMore = false;

    const at = anchorPath ? filtered.findIndex(f => f.path === anchorPath) : -1;
    const idx = at >= 0 ? at : clamp(oldFocus, 0, Math.max(0, filtered.length - 1));
    this.scrollCur = idx;
    this.scrollTarget = idx;
    this.scrollVel = 0;
    this.hoverD = null;

    // 內容變了的卡：丟掉舊貼圖，卡片會顯示新 placeholder 再排一次真縮圖
    for (const p of changed) {
      const e = this.texCache.get(p);
      if (e) { e.tex.dispose(); this.texCache.delete(p); }
    }
    // 已經不存在的分頁（關掉了）：它的貼圖也不會再用到，順手丟掉，別留在快取裡
    if (this.texCache.size > this.view.length) {
      const alive = new Set(this.view.map(f => f.path));
      for (const p of [...this.texCache.keys()]) {
        if (alive.has(p)) continue;
        this.texCache.get(p).tex.dispose();
        this.texCache.delete(p);
      }
    }
    const changedSet = new Set(changed);
    for (const s of this.slots) if (s.file && changedSet.has(s.file.path)) s.thumbReqPath = null;

    this.rebindAll(true);
    this.poke();
    this.notifySelection();
    return changed;
  }

  rebindAll(snap) {
    const base = this.windowBase();
    for (let k = 0; k < POOL_N; k++) {
      const s = this.slots[k];
      if (s.mode !== 'home') continue;   // extract/return/gone keep their binding
      this.bindSlot(s, base + k, snap);
    }
  }

  bindSlot(s, fileIdx, snap) {
    const nf = (fileIdx >= 0 && fileIdx < this.view.length) ? this.view[fileIdx] : null;
    if (nf === s.file && fileIdx === s.fileIdx) return;   // same file, same slot
    s.fileIdx = fileIdx;
    s.file = nf;
    // 換綁一律回到「這張卡在弧線上那一格」的縮放：弧線前面幾格是縮小的（見 KEY_S），
    // 這裡若還原成 1，slot 一換綁就會先脹一下再縮回去。
    const uNew = fileIdx - this.scrollCur;
    if (snap) { s.d = uNew; s.yOff = 0; }
    s.scale = poseAt(uNew).scale;
    s.selTint = null;   // 材質色由選取染色管，換檔後重套一次（否則會沿用前一個檔的染色判斷）
    s.bend = 0;   // 換檔案一律從平卡開始（gone 槽凍結的殘值也一併清掉）
    if (s.file) {
      // 規則：slot 換綁新檔時，新貼圖還沒好之前一律顯示「該檔」的 placeholder 卡面
      // （快取命中才是該檔的真貼圖），絕不可沿用別檔的貼圖。
      // 例外：離焦點太遠的卡（|u| > NEAR_PH，視覺上已淡出到看不見）先用共用灰骨架，
      // 別在綁卡爆發時同步畫幾十張專屬 placeholder。綁定之後卡還會滾近——
      // bindSlot 對同檔同槽早退，不會再進來，所以近窗升級在 tick 的 phShared 檢查做；
      // 真縮圖到貨（applyThumb）直接蓋掉，哪條先發生都對。
      const near = Math.abs(uNew) <= NEAR_PH;
      const real = this.texGet(s.file.path);
      const tex = real || (near ? this.placeholderTex(s.file) : this.sharedPhTex(s.file));
      s.phShared = !real && !near;
      s.mesh.material.map = tex;
      s.mesh.material.needsUpdate = true;
      s.texName = s.file.name;
      s.thumbReqPath = null;
    }
  }

  maybeRebindWindow() {
    const base = this.windowBase();
    if (base === this.lastBase) return;
    this.lastBase = base;
    this.rebindAll(false);
  }

  // ------------------------------------------------------------- extract/return
  stagePoseForReaderRect(rectCss) {
    // world pose so the card lands where the reader panel will be.
    // 根因修正：原本直接對 this.camera 做 setFromCamera —— 但佈局動畫還沒跑完時
    // camera.aspect 是「現在的」欄寬（twocol＝全寬），ndcX 只被 clamp 到舊 frustum
    // 邊緣，動畫結束後卡就飛到畫面外（使用者看到的就是飛出去的卡被切掉）。
    // 這裡改用「目標 viewport 的 aspect」手算方向，不依賴當下相機的 projection。
    const w = Math.max(1, this.viewCss.tw), hCss = Math.max(1, this.canvas.clientHeight || innerHeight - toolbarH());
    const asp = w / hCss;
    const ndcX = clamp(((rectCss.x + rectCss.w / 2) - this.viewCss.tx) / w * 2 - 1, -1, 1);
    const ndcY = clamp(1 - ((rectCss.y - toolbarH() + rectCss.h / 2) / hCss) * 2, -1, 1);
    const tanV = Math.tan(this.camera.fov * Math.PI / 360);
    const dir = new THREE.Vector3(ndcX * tanV * asp, ndcY * tanV, -1).normalize()
      .applyQuaternion(this.camQuat);
    const focalPx = (hCss / 2) / tanV;
    const scale = 2.6;
    const targetPxH = rectCss.h * 0.78;
    const dist = clamp(CARD_H * scale * focalPx / Math.max(1, targetPxH), 4, 30);
    const pos = this.camera.position.clone().add(dir.multiplyScalar(dist));
    return { pos, quat: this.camQuat.clone(), scale };
  }

  extractFile(fileIdx, rectCss) {
    const s = this.slots.find(x => x.fileIdx === fileIdx && x.file && x.mode === 'home');
    if (!s) return null;
    // 歐哥 2026-10-30：點卡片不要「抽出飛到閱讀區」的動畫（看起來頓）→ 卡留在卡堆原位、
    // 閱讀區直接顯示。stage 仍記著，給之後需要「從閱讀區位置」的邏輯用
    s.arrived = true; s.fading = false;
    s.stage = this.stagePoseForReaderRect(rectCss);
    s.stageT0 = performance.now();
    this.extracted = s;
    this.extractedFile = s.file;
    if (this.onCardClick) this.onCardClick(s.file);
    this.poke();
    return s.file;
  }

  // recompute the flight target when the layout mode changes mid-flight
  restage(rectCss) {
    if (this.extracted) this.extracted.stage = this.stagePoseForReaderRect(rectCss);
  }

  returnExtracted(instant) {
    const s = this.extracted;
    if (!s) return;
    this.extracted = null; this.extractedFile = null;
    if (s.mode === 'home') {
      // 卡一直在卡堆原位（點卡不再飛出）→ 關閱讀區也不用飛回
      this.poke();
      return;
    }
    s.mode = 'return';
    // 抽出抵達閱讀面板後卡片淡出並設成 gone（mesh.visible=false），放回時要重新顯示，否則卡片永遠隱形
    s.mesh.visible = true;
    s.fading = false;
    if (instant) {
      // snap back: used on folder switch (old stack is sinking anyway)
      s.mode = 'home';
      s.mesh.material.opacity = s.opacity = 1;
      this.rebindSlotNow(s);
    }
    this.poke();
  }

  rebindSlotNow(s) {
    s.fileIdx = this.view.indexOf(s.file);
    this.bindSlot(s, s.fileIdx, true);
  }

  // ------------------------------------------------------------- pointer
  // 點擊判定：按下到放開位移 <5px 且 <400ms 才算點擊，超過就是拖曳捲動。
  // 目標一律用「按下瞬間」raycast 到的卡（幾何已含翻平彎曲，看到哪張就是哪張）。
  // 滾輪：一格＝一張，慢滾一張一張前進；快滾最多領先 WHEEL_LEAD 張，實際移動限速
  // SCROLL_VMAX 張/秒（tick），停手後吸到最近一張 → 永遠停在某張被抽到正中央。
  setNdc(e) {
    this.pointerNdc.set(
      ((e.clientX - this.viewCss.x) / Math.max(1, this.viewCss.w)) * 2 - 1,
      -((e.clientY - toolbarH()) / Math.max(1, this.canvas.clientHeight)) * 2 + 1);
  }
  bindPointer() {
    const cv = this.canvas;
    let down = null;   // {x, y, t, fileIdx, startScroll, id, moved}

    cv.addEventListener('pointermove', e => {
      if (down && e.pointerId !== down.id) return;   // 多指標：只跟著起按的那根
      this.setNdc(e);
      if (down) {
        if (Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 5) down.moved = true;
        if (down.moved) {
          // 拖曳捲動：往上拖＝往後翻（跟滾輪同向）
          this.dragging = true;
          this.lastUserScrollAt = performance.now();
          this.scrollTarget = clamp(down.startScroll + (down.y - e.clientY) / 120, 0, this.scrollMax());
          this.poke();
        }
        return;
      }
      const hit = this.pickSlotHit();
      cv.style.cursor = hit ? 'pointer' : '';
    });
    cv.addEventListener('pointerleave', () => { if (!down) cv.style.cursor = ''; });
    // 右鍵（或中鍵）拖曳＝轉視角：左右晃 ±ORBIT_YAW°、上下在 ORBIT_PITCH 範圍內
    let orb = null;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 1 && e.button !== 2) return;
      e.preventDefault();
      orb = { x: e.clientX, y: e.clientY, yaw: this.orbit.yaw, pitch: this.orbit.pitch, id: e.pointerId };
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    });
    cv.addEventListener('pointermove', e => {
      if (!orb || e.pointerId !== orb.id) return;
      this.orbit.yaw = clamp(orb.yaw - (e.clientX - orb.x) * 0.2, -ORBIT_YAW, ORBIT_YAW);
      this.orbit.pitch = clamp(orb.pitch + (e.clientY - orb.y) * 0.2, ORBIT_PITCH[0], ORBIT_PITCH[1]);
      this.poke();
      this.notifyView();
    });
    const endOrb = e => {
      if (!orb || e.pointerId !== orb.id) return;
      const still = Math.hypot(e.clientX - orb.x, e.clientY - orb.y) < 5;
      orb = null;
      if (still && e.type === 'pointerup' && e.button === 2 && this.onCardMenu) {
        this.setNdc(e);
        const hit = this.pickSlot();
        if (hit) this.onCardMenu(hit.file, e.clientX, e.clientY);
      }
    };
    cv.addEventListener('pointerup', endOrb);
    cv.addEventListener('pointercancel', endOrb);
    cv.addEventListener('dblclick', () => this.resetView());
    cv.addEventListener('pointerdown', e => {
      if (e.button !== 0 || down) return;
      this.poke();
      this.setNdc(e);
      const hit = this.pickSlotHit();
      down = { x: e.clientX, y: e.clientY, t: performance.now(),
               fileIdx: hit ? hit.fileIdx : -1,
               uv: hit ? hit.uv : null,                    // 卡面 uv：分頁卡右上角 ×／⧉ 的命中判定用
               startScroll: this.scrollTarget, id: e.pointerId, moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    });
    cv.addEventListener('pointerup', e => {
      this.poke();
      if (!down || e.pointerId !== down.id) return;
      if (e.button !== 0) { down = null; return; }   // 右鍵放開不算點擊
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const isClick = moved < 5 && performance.now() - down.t < 400;
      if (isClick && down.fileIdx >= 0 && (e.ctrlKey || e.metaKey || e.shiftKey)) {
        // Ctrl（Mac ⌘）＋點＝加選／取消；Shift＋點＝從上次點的那張選到這張（跟檔案總管一樣）
        this.selectClick(down.fileIdx, e.shiftKey);
      } else if (isClick && down.fileIdx >= 0 && this.getReaderRect) {
        // 分頁模式（tabs.js）攔截：卡面右上 ×＝關網頁、側欄 ⧉＝複製給 AI、其餘點卡＝切分頁或
        // 開右欄預覽（onClickIntercept 回 true＝吞掉，不做抽出動畫）。uv 是點在卡面上的位置。
        const f = this.view[down.fileIdx];
        if (f && this.onClickIntercept && this.onClickIntercept(f, down.uv)) { down = null; this.dragging = false; return; }
        // 閱讀區已經開著：只換內容，不再做「抽出飛到右邊」的動畫（三欄時那一下會讓畫面抖）；
        // 正在讀的那張改用外框＋微微抬高標示
        if (this.readerOpen && this.readerOpen()) this.switchReading(down.fileIdx);
        else this.extractFile(down.fileIdx, this.getReaderRect());
      }
      down = null;
      this.dragging = false;
    });
    cv.addEventListener('pointercancel', e => {
      if (down && e.pointerId === down.id) { down = null; this.dragging = false; }
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      const dy = e.deltaY * unit;
      if (e.ctrlKey) {   // Ctrl+滾輪＝拉近拉遠（觸控板捏合也是這個事件）
        this.zoomBy(dy);
        return;
      }
      // 一次「滾動手勢」（事件間隔 < WHEEL_SNAP_MS）累加原始位移，換算成整數張：
      // 一格 ≈ 100×螢幕縮放（115% 縮放時 115）。舊做法每個 ≥50 的事件各算一張——
      // 瀏覽器把一格拆成兩個 57 送來時就變成兩張（滾一格、停下後又往下掉一格）。
      const now = performance.now();
      this.lastUserScrollAt = now;   // 就算是被 LEAD 夾住／清單還沒來的滾輪，也算「使用者想滾」
      if (!this._wheelBurst || now > (this.wheelUntil || 0)) {
        this._wheelBurst = { start: Math.round(this.scrollTarget), sum: 0 };
      }
      this._wheelBurst.sum += dy;
      const notch = 100 * (window.devicePixelRatio || 1);
      const t = this._wheelBurst.start + Math.round(this._wheelBurst.sum / notch);
      this.scrollTarget = clamp(clamp(t, Math.round(this.scrollCur) - WHEEL_LEAD, Math.round(this.scrollCur) + WHEEL_LEAD), 0, this.scrollMax());
      // 被前後領先上限夾住時重設起點：反向滾時不用先「還掉」被夾掉的那些格數才動
      this._wheelBurst.start = this.scrollTarget - Math.round(this._wheelBurst.sum / notch);
      (this._wheelLog || (this._wheelLog = [])).push([Math.round(now), +dy.toFixed(1)]);   // __dbg 查真實滾輪事件用
      if (this._wheelLog.length > 30) this._wheelLog.shift();
      this.wheelUntil = now + WHEEL_SNAP_MS;
      this.maybeRequestMore();
      this.poke();
    }, { passive: false });
  }
  // Ctrl+滾輪消費一個 delta 量＝相機拉近拉遠（目前只有本檔的滾輪處理呼叫）
  zoomBy(dy) {
    this.orbit.zoom = clamp(this.orbit.zoom * Math.exp(-dy * 0.0015), ORBIT_ZOOM[0], ORBIT_ZOOM[1]);
    this.poke();
    this.notifyView();
  }
  resetView() {
    this.orbit.yaw = 0; this.orbit.pitch = POSE_PITCH; this.orbit.zoom = 1;
    this.poke();
    this.notifyView();
  }
  // 目前的「目標視角」：存過我的視角就是它（正規化到合法範圍），沒存過就是預設視角
  targetView() {
    const v = this.favView();
    return v ? { yaw: clamp(v.yaw, -ORBIT_YAW, ORBIT_YAW),
      pitch: clamp(v.pitch, ORBIT_PITCH[0], ORBIT_PITCH[1]),
      zoom: clamp(v.zoom, ORBIT_ZOOM[0], ORBIT_ZOOM[1]) }
      : { yaw: 0, pitch: POSE_PITCH, zoom: 1 };
  }
  // 目前視角是否偏離目標視角（只看相機、有容差；不看捲到第幾張卡）
  viewDiffers() {
    const a = this.orbit, b = this.targetView();
    return Math.abs(a.yaw - b.yaw) > VIEW_ANGLE_EPS || Math.abs(a.pitch - b.pitch) > VIEW_ANGLE_EPS
      || Math.abs(a.zoom - b.zoom) > VIEW_ZOOM_EPS;
  }
  notifyView() {
    if (this.onViewChange) this.onViewChange(this.viewDiffers());
  }
  // 「我的視角」：使用者自己調好的左右/俯角/遠近，存在這台電腦的瀏覽器裡。
  // 解析結果快取起來——拖曳時每個 pointermove 都會問一次，不能每次 parse localStorage。
  favView() {
    if (this._favCache !== undefined) return this._favCache;
    let v = null;
    try {
      const raw = JSON.parse(localStorage.getItem('floderMyView') || 'null');
      // 三個值都得是有限數字：壞資料（手改、舊版格式）就當沒存過
      if (raw && Number.isFinite(raw.yaw) && Number.isFinite(raw.pitch) && Number.isFinite(raw.zoom)) v = raw;
    } catch (_) {}
    this._favCache = v;
    return v;
  }
  // 把存的視角套到 orbit 上（開頁時用）；沒存過不動 orbit
  applyFavView() {
    const v = this.favView();
    if (!v) return false;
    const t = this.targetView();
    this.orbit.yaw = t.yaw; this.orbit.pitch = t.pitch; this.orbit.zoom = t.zoom;
    return true;
  }
  // 回傳實際存下來的視角；storage 停用／爆掉時回 null（UI 據此提示）
  saveFavView() {
    const v = { yaw: this.orbit.yaw, pitch: this.orbit.pitch, zoom: this.orbit.zoom };
    let ok = true;
    try { localStorage.setItem('floderMyView', JSON.stringify(v)); } catch (_) { ok = false; }
    if (ok) { this._favCache = v; this.notifyView(); }   // 剛存的就是目前視角：提示按鈕淡出
    return ok ? v : null;
  }
  goFavView() {
    if (!this.applyFavView()) return false;
    this.poke();
    this.notifyView();
    return true;
  }
  // 測試相容：舊 hover 撥開已拿掉，「被抽起來的那張」＝正中央焦點那張
  hoverFileIdx() {
    const idx = Math.round(this.scrollCur);
    return idx >= 0 && idx < this.view.length ? idx : -1;
  }

  pickSlot(ndc) {
    const h = this.pickSlotHit(ndc);
    return h ? h.slot : null;
  }
  // 連同命中點的卡面 uv 一起回（分頁卡右上角 ×／⧉ 的命中判定用；uv 跟 CPU 彎曲後的幾何走）
  pickSlotHit(ndc) {
    const cand = this.slots.filter(s => s.file && s.mode === 'home' && s.opacity > 0.3)
      .map(s => s.mesh);
    this.raycaster.setFromCamera(ndc || this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(cand, false);
    if (!hits.length) return null;
    const slot = this.slots.find(s => s.mesh === hits[0].object) || null;
    return slot ? { slot, fileIdx: slot.fileIdx, uv: hits[0].uv || null } : null;
  }
  // 卡面上某 uv 點的本機座標：幾何頂點位置已含 CPU 彎曲，拿包夾的四個格點雙線性插值
  _uvLocalPos(s, tu, tv) {
    const pos = s.mesh.geometry.attributes.position;
    const uvA = s.mesh.geometry.attributes.uv;
    if (!pos || !uvA || !pos.count) return null;
    let lu = null, ru = null, lv = null, rv = null;
    for (let i = 0; i < pos.count; i++) {
      const u = uvA.getX(i), v = uvA.getY(i);
      if (u <= tu + 1e-9 && (lu === null || u > lu)) lu = u;
      if (u >= tu - 1e-9 && (ru === null || u < ru)) ru = u;
      if (v <= tv + 1e-9 && (lv === null || v > lv)) lv = v;
      if (v >= tv - 1e-9 && (rv === null || v < rv)) rv = v;
    }
    if (lu === null || ru === null || lv === null || rv === null) return null;
    const at = (u, v) => {
      let best = null, bd = Infinity;
      for (let i = 0; i < pos.count; i++) {
        const d = Math.abs(uvA.getX(i) - u) + Math.abs(uvA.getY(i) - v);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    const corners = [at(lu, lv), at(ru, lv), at(lu, rv), at(ru, rv)];
    const fu = ru === lu ? 0 : (tu - lu) / (ru - lu);
    const fv = rv === lv ? 0 : (tv - lv) / (rv - lv);
    const lerp = (get) => (1 - fu) * ((1 - fv) * get(corners[0]) + fv * get(corners[2]))
                        + fu * ((1 - fv) * get(corners[1]) + fv * get(corners[3]));
    return [lerp(i => pos.getX(i)), lerp(i => pos.getY(i)), lerp(i => pos.getZ(i))];
  }
  // 卡面上某塊 uv 區域（{u0,u1?,v0}，v=1＝卡頂）的「一個真的點得到」的螢幕座標（整頁 css px）。
  // 流程：插值出區域中心投影 → raycast 驗證「打在這張卡自己、且命中 uv 還在區域內」；
  // 被前排卡遮住就改試區域內的實際頂點（離中心近的先）。全失敗回 null＝這張卡的徽章點不到。
  cardZoneCss(fileIdx, zone) {
    const s = this.slots.find(x => x.fileIdx === fileIdx && x.file && x.mode !== 'away' && x.mesh && x.mesh.visible);
    if (!s || !zone || !this.viewCss || !(this.viewCss.w > 0)) return null;
    const pos = s.mesh.geometry.attributes.position;
    const uvA = s.mesh.geometry.attributes.uv;
    if (!pos || !uvA || !pos.count) return null;
    const u0 = zone.u0, u1 = zone.u1 == null ? 1 : zone.u1, v0 = zone.v0;
    if (!(u0 < u1) || !(v0 < 1)) return null;
    s.mesh.updateWorldMatrix(true, false);
    this.camera.updateMatrixWorld();
    const tu = zone.uc != null ? zone.uc : (u0 + u1) / 2;
    const tv = zone.vc != null ? zone.vc : (1 + v0) / 2;
    const cands = [];
    const c0 = this._uvLocalPos(s, tu, tv);
    if (c0) cands.push({ p: c0, d: -1 });   // 區域中心插值（距離 -1：永遠最先試）
    for (let i = 0; i < pos.count; i++) {
      const u = uvA.getX(i), vv = uvA.getY(i);
      if (u >= u0 && u <= u1 && vv >= v0)
        cands.push({ p: [pos.getX(i), pos.getY(i), pos.getZ(i)], d: Math.abs(u - tu) + Math.abs(vv - tv) });
    }
    cands.sort((a, b) => a.d - b.d);        // 離熱區中心近的先試，全失敗才回 null
    const v = this._zoneV || (this._zoneV = new THREE.Vector3());
    const ndc = this._zoneNdc || (this._zoneNdc = new THREE.Vector2());
    for (const c of cands.length > 25 ? cands.slice(0, 25) : cands) {
      const p = c.p;
      v.set(p[0], p[1], p[2]).applyMatrix4(s.mesh.matrixWorld).project(this.camera);
      const x = this.viewCss.x + (v.x * 0.5 + 0.5) * this.viewCss.w;
      const y = toolbarH() + (-v.y * 0.5 + 0.5) * this.canvas.clientHeight;
      ndc.set(((x - this.viewCss.x) / Math.max(1, this.viewCss.w)) * 2 - 1,
              -((y - toolbarH()) / Math.max(1, this.canvas.clientHeight)) * 2 + 1);
      const hit = this.pickSlotHit(ndc);
      if (hit && hit.slot === s && hit.uv &&
          hit.uv.x >= u0 - 1e-6 && hit.uv.x <= u1 + 1e-6 && hit.uv.y >= v0 - 1e-6) {
        return { x, y, name: s.file.name, mode: s.mode, fileIdx: s.fileIdx };
      }
    }
    return null;
  }
  // 每張看得見的分頁卡右上角 ×（或 ⧉）的螢幕座標——e2e 驗「不 hover 每張卡也都畫著」用
  tabBadgePositions(zone) {
    const out = [];
    for (const s of this.visibleHomeSlots()) {
      if (!s.file || !s.file.tab || s.file.tab.note) continue;
      const p = this.cardZoneCss(s.fileIdx, zone);
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.fileIdx - b.fileIdx);
  }

  // screen-px position of the card for a file index (tests)
  cardScreen(fileIdx) {
    const s = this.slots.find(x => x.fileIdx === fileIdx && x.file);
    if (!s) return null;
    const v = s.mesh.getWorldPosition(new THREE.Vector3()).project(this.camera);
    const w = this.viewCss.w, h = this.canvas.clientHeight;
    return {
      x: this.viewCss.x + (v.x * 0.5 + 0.5) * w,
      y: toolbarH() + (-v.y * 0.5 + 0.5) * h,
      name: s.file.name, mode: s.mode, d: s.d
    };
  }

  // ---- test/inspect helpers (screen css px, toolbar 44px)
  visibleHomeSlots() {
    return this.slots.filter(s => s.file && (s.mode === 'home' || s.mode === 'return')
      && s.opacity > 0.4 && s.mesh.visible);
  }
  // raycast at a page css-px point → {fileIdx, name} or null（獨立 Vector2，不汙染共用的 pointerNdc）
  pickAtCss(px, py) {
    const v = this._tmpNdc || (this._tmpNdc = new THREE.Vector2());
    v.set(
      ((px - this.viewCss.x) / Math.max(1, this.viewCss.w)) * 2 - 1,
      -((py - toolbarH()) / Math.max(1, this.canvas.clientHeight)) * 2 + 1);
    const hit = this.pickSlot(v);
    return hit ? { fileIdx: hit.fileIdx, name: hit.file.name } : null;
  }
  // pixel bounding box of all visible home cards (current poses)
  cornerBoundsCss() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const v = new THREE.Vector3();
    const pts = [[-CARD_W / 2, -CARD_H / 2], [CARD_W / 2, -CARD_H / 2],
                 [-CARD_W / 2, CARD_H / 2], [CARD_W / 2, CARD_H / 2]];
    for (const s of this.visibleHomeSlots()) {
      for (const [lx, ly] of pts) {
        v.set(lx, ly, 0).applyMatrix4(s.mesh.matrixWorld).project(this.camera);
        const px = this.viewCss.x + (v.x * 0.5 + 0.5) * this.viewCss.w;
        const py = toolbarH() + (-v.y * 0.5 + 0.5) * this.canvas.clientHeight;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
    }
    if (minX > maxX) return null;
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }
  visibleCards() {
    const out = [];
    for (const s of this.visibleHomeSlots()) {
      const c = this.cardScreen(s.fileIdx);
      if (c) out.push({ fileIdx: s.fileIdx, name: s.file.name, x: c.x, y: c.y, mode: s.mode });
    }
    out.sort((a, b) => a.fileIdx - b.fileIdx);
    return out;
  }
  // 卡面矩形（css px）。用途：e2e「卡片夠大」斷言；分頁模式的浮動「預覽」鈕座標（tabs.js）
  // aside: Project 座標是整頁絕對 css px（canvas 左偏已含 viewCss.x），可直接給 position:fixed
  cardBoundsCss(fileIdx) {
    const s = this.slots.find(x => x.fileIdx === fileIdx && x.file && x.mesh.visible);
    if (!s) return null;
    const v = new THREE.Vector3();
    const pts = [[-CARD_W / 2, -CARD_H / 2], [CARD_W / 2, -CARD_H / 2],
                 [-CARD_W / 2, CARD_H / 2], [CARD_W / 2, CARD_H / 2]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lx, ly] of pts) {
      v.set(lx, ly, 0).applyMatrix4(s.mesh.matrixWorld).project(this.camera);
      const px = this.viewCss.x + (v.x * 0.5 + 0.5) * this.viewCss.w;
      const py = toolbarH() + (-v.y * 0.5 + 0.5) * this.canvas.clientHeight;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }
  // 單卡上緣／下緣的投影寬度（css px）——驗「梯形透視強度」（上緣寬 ÷ 下緣寬）
  cardEdgeWidthsCss(fileIdx) {
    // fileIdx 對應「目前綁在該檔的 slot」；home/return 期間一檔一 slot，故 find 第一筆即正解
    const s = this.slots.find(x => x.fileIdx === fileIdx && x.file && x.mesh?.visible);
    if (!s) return null;
    this.camera.updateMatrixWorld();
    const v = this._edgeV || (this._edgeV = new THREE.Vector3());
    const px = (lx, ly) => {
      v.set(lx, ly, 0).applyMatrix4(s.mesh.matrixWorld).project(this.camera);
      return this.viewCss.x + (v.x * 0.5 + 0.5) * this.viewCss.w;
    };
    const wTop = Math.abs(px(CARD_W / 2, CARD_H / 2) - px(-CARD_W / 2, CARD_H / 2));
    const wBot = Math.abs(px(CARD_W / 2, -CARD_H / 2) - px(-CARD_W / 2, -CARD_H / 2));
    if (!Number.isFinite(wTop) || !Number.isFinite(wBot)) return null;
    return { wTop, wBot };
  }
  // WebGL renderer 實際 viewport（換算回 css px）—— e2e 斷言「左緣 = 分隔線右緣」用
  glViewportCss() {
    // getViewport 回傳的已是 CSS px（three 內部才乘 pixelRatio）
    const v = this.renderer.getViewport(this._vp4 || (this._vp4 = new THREE.Vector4()));
    return { x: v.x, y: v.y, w: v.z, h: v.w };
  }
  // 繞過 three 的包裝，直接讀 GPU 實際 viewport（device px ÷ pixelRatio = css px）。
  // e2e 斷言 DPR≠1 時視區沒有偏（不准用自己算的值反推）。
  glViewportRaw() {
    const gl = this.renderer.getContext();
    const v = gl.getParameter(gl.VIEWPORT);
    const pr = this.renderer.getPixelRatio();
    return { x: v[0] / pr, y: v[1] / pr, w: v[2] / pr, h: v[3] / pr,
             dpr: window.devicePixelRatio, pixelRatio: pr };
  }
  // 每張可見卡的綁定檔名 vs 目前貼圖來源檔名（e2e：兩者必須一致，抓重複/錯貼卡）
  slotTex() {
    return this.visibleHomeSlots().map(s => ({ fileIdx: s.fileIdx, name: s.file.name, texName: s.texName }));
  }
  // 指定卡在畫面上「實際可見」的面積比例：卡面取 res×res 網格取樣 → 投影到 css px →
  // 每點 raycast，命中最上層就是自己才算露出。e2e 斷言「hover 撥開後被指卡露出 ≥ 半張」。
  // （頂點著色器的翻平彎曲不在 matrixWorld 裡，但 raycast 也走未彎幾何，兩邊一致）
  exposedRatio(fileIdx, res = 16) {
    const s = this.slots.find(x => x.fileIdx === fileIdx && x.file &&
      (x.mode === 'home' || x.mode === 'return') && x.mesh.visible);
    if (!s) return null;
    let tot = 0, visCnt = 0;
    const v3 = this._expV || (this._expV = new THREE.Vector3());
    const w = this.viewCss.w, h = this.canvas.clientHeight;
    for (let iu = 0; iu < res; iu++) {
      for (let iv = 0; iv < res; iv++) {
        const lx = (iu + 0.5) / res * CARD_W - CARD_W / 2;
        const ly = (iv + 0.5) / res * CARD_H - CARD_H / 2;
        v3.set(lx, ly, 0).applyMatrix4(s.mesh.matrixWorld).project(this.camera);
        if (!Number.isFinite(v3.x) || v3.z < -1 || v3.z > 1) continue;
        const px = this.viewCss.x + (v3.x * 0.5 + 0.5) * w;
        const py = toolbarH() + (-v3.y * 0.5 + 0.5) * h;
        if (px < this.viewCss.x || px >= this.viewCss.x + w || py < toolbarH() || py >= toolbarH() + h) continue;
        tot++;
        const hit = this.pickAtCss(px, py);
        if (hit && hit.fileIdx === fileIdx) visCnt++;
      }
    }
    return tot ? visCnt / tot : 0;
  }

  // ------------------------------------------------------------- loop
  poke() {
    this.wakeUntil = performance.now() + 600;
    if (this.rafId == null) {
      this.lastT = performance.now();
      this.rafId = requestAnimationFrame(t => this.tick(t));
    }
  }

  // 上半部翻平：折點以上沿圓弧往後（−z）彎，弧長不變（跟擺位實驗室同一條公式）
  bendGeo(s) {
    const pos = s.geo.attributes.position, base = s.base, ang = s.bend;
    const hy = -CARD_H / 2 + FOCUS_HINGE * CARD_H, L = CARD_H / 2 - hy;
    for (let v = 0; v < pos.count; v++) {
      const x = base[v * 3], y = base[v * 3 + 1];
      let ny = y, nz = 0;
      if (ang > 1e-4 && y > hy) {
        const R = L / ang, th = (y - hy) / R;
        ny = hy + R * Math.sin(th);
        nz = -R * (1 - Math.cos(th));
      }
      pos.setXYZ(v, x, ny, nz);
    }
    pos.needsUpdate = true;
    s.geo.computeBoundingSphere();
    s.geoBend = ang;
  }

  tick(now) {
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    this.fpsRing.push(now);
    while (this.fpsRing.length && now - this.fpsRing[0] > 3000) this.fpsRing.shift();
    this.motionLevel = 0;

    // folder switch phases
    if (this.phase === 'out' && now - this.phaseT0 > OUT_MS && this.pendingFiles) {
      const f = this.pendingFiles; this.pendingFiles = null; f();
    }
    if (this.phase === 'in') {
      const lastDelay = Math.min(this.winCap(), this.view.length) * IN_STAGGER;
      if (now - this.phaseT0 > lastDelay + 420) {
        this.phase = 'idle';
        if (!this.lastFolderSwitchMs && this.t0Switch) this.lastFolderSwitchMs = Math.round(now - this.t0Switch);
      }
    }

    // 快速跳轉（捲軸拖曳）：遠距離直接瞬移到目標前 3 張，最後幾張照常飛進來，不會一路刷過幾千張
    if (this._jumpTo != null) {
      const i = clamp(Math.round(this._jumpTo), 0, this.scrollMax()); this._jumpTo = null;
      if (Math.abs(i - this.scrollCur) > 6) { this.scrollCur = i - Math.sign(i - this.scrollCur) * 3; this.scrollVel = 0; }
      this.scrollTarget = i;
    }
    // 滾動：停手（沒在滾、沒在拖）就把目標吸到最近一張；實際位置用臨界阻尼追目標，
    // 速度上限 SCROLL_VMAX → 慢滾慢慢走、快滾走得遠但字一路看得清楚，不回彈不抖。
    if (!this.dragging && now > (this.wheelUntil || 0)) {
      const r = clamp(Math.round(this.scrollTarget), 0, this.scrollMax());
      if (r !== this.scrollTarget) this.scrollTarget = r;
    }
    {
      let err = this.scrollTarget - this.scrollCur;
      if (Math.abs(err) > SCROLL_JUMP) {   // 差太多：瞬移到目標前 3 張，最後幾張照常飛進來
        this.scrollCur = this.scrollTarget - Math.sign(err) * 3;
        this.scrollVel = Math.sign(err) * SCROLL_VMAX;
        err = this.scrollTarget - this.scrollCur;
      }
      // 速度上限隨剩餘距離變：近距離維持慢速（看得清字），差越多走越快，接近時上限跟著降＝自然減速
      const vmax = Math.abs(err) <= SCROLL_NEAR ? SCROLL_VMAX
        : Math.min(SCROLL_VMAX_FAR, SCROLL_VMAX + (Math.abs(err) - SCROLL_NEAR) * SCROLL_ACCEL);
      const want = clamp(err * 9, -vmax, vmax);
      this.scrollVel = damp(this.scrollVel, want, 36, dt);   // 36 ≈ 4×9：臨界阻尼，不超過頭
      this.scrollCur += this.scrollVel * dt;
      if (Math.abs(err) < 0.002 && Math.abs(this.scrollVel) < 0.02) { this.scrollCur = this.scrollTarget; this.scrollVel = 0; }
      this.motionLevel = Math.max(this.motionLevel, Math.abs(err), Math.abs(this.scrollVel) * 0.1);
    }
    this.maybeRebindWindow();

    this.applyViewport(dt);

    if (this._fitOverride) {
      // 測試鉤子：強制指定相機（__dbg.setFit），量測真實投影用；null 解除回自動取景
      const o = this._fitOverride;
      this.fitCur.target.set(o.cx || 0, o.cy, o.cz);
      this.fitCur.dist = o.dist; this.fitCur.pitch = o.pitch;
      this.applyCameraPose();
    } else {
      // 自動取景：每幀重算 fitTarget（viewport/檔案數/參數變動都吃這條），
      // 相機距離與俯角 damp 過去 → 視窗縮放、分隔線拖拉、三欄切換都平滑重新取景
      this.frameTargets();
      const fc = this.fitCur, ft = this.fitTarget;
      const camK = 1 - Math.exp(-9 * dt);
      fc.target.lerp(ft.target, camK);
      fc.dist = damp(fc.dist, ft.dist, 9, dt);
      fc.pitch = damp(fc.pitch, ft.pitch, 9, dt);
      fc.yaw = damp(fc.yaw || 0, ft.yaw || 0, 9, dt);
      const camMotion = Math.abs(fc.dist - ft.dist) + fc.target.distanceTo(ft.target) +
        (Math.abs(fc.pitch - ft.pitch) + Math.abs((fc.yaw || 0) - (ft.yaw || 0))) * 0.01;
      this.motionLevel = Math.max(this.motionLevel, camMotion);
      this.applyCameraPose();
    }

    // 飛行中的卡：相機在動時（切欄/resize）用新相機每幀重算飛行終點，
    // 否則終點是用舊 aspect 算的，卡會偏離閱讀面板位置
    if (this.extracted && !this.extracted.arrived && this.getReaderRect) {
      this.extracted.stage = this.stagePoseForReaderRect(this.getReaderRect());
    }

    const inT = now - this.phaseT0;
    const eul = this._eul || (this._eul = new THREE.Euler());
    for (const s of this.slots) {
      const u = s.fileIdx - this.scrollCur;
      if (s.mode === 'home') {
        // 姿態直接由焦點位置決定（scrollCur 本身已經平滑）；只有切資料夾的升降/淡入淡出另外阻尼
        const ps = poseAt(u);
        let oT = ps.op, yIn = 0;
        if (!s.file) oT = 0;
        else if (this.phase === 'out') { oT = 0; yIn = -3.4; }
        else if (this.phase === 'in' && inT < Math.max(0, u + 3) * IN_STAGGER + 60) { oT = 0; yIn = -3.4; }
        const before = s.yOff + s.opacity;
        s.yOff = damp(s.yOff, yIn, 16, dt);
        // 平常不透明度直接等於姿態值（阻尼會讓卡慢半拍半透明＝捲動殘影）；只有切資料夾的升降才淡入淡出
        if (s.fadeIn && Math.abs(s.opacity - oT) < 0.02) s.fadeIn = false;
        s.opacity = (this.phase === 'idle' && yIn === 0 && Math.abs(s.yOff) < 0.01 && !s.fadeIn) ? oT : damp(s.opacity, oT, 12, dt);
        this.motionLevel = Math.max(this.motionLevel, Math.abs(s.yOff + s.opacity - before));
        s.d = u; s.scale = ps.scale;
        s.bend = ps.bend;
        // 遠卡滾進近窗：共用灰骨架升級回帶標題的專屬 placeholder（一張只升級一次；
        // 真縮圖若已排隊/到貨，applyThumb 會蓋掉它）
        if (s.phShared && s.file && Math.abs(u) <= NEAR_PH) {
          s.mesh.material.map = this.placeholderTex(s.file);
          s.mesh.material.needsUpdate = true;
          s.phShared = false;
        }
        const cosA = Math.cos(ps.rot), sinA = Math.sin(ps.rot);
        // 選取／閱讀完全不動卡片的位置（不走 readLift）：點一張卡只是開閱讀欄，
        // 卡還是在弧線上原本那一格。翻走時也就沒有「先墊高、再掉回去」那一下，
        // 不會跟迎面來的鄰卡互相彈。
        s.mesh.position.set(BASE[0], ps.y + s.yOff + cosA * CARD_H / 2, ps.z + sinA * CARD_H / 2);
        s.mesh.quaternion.setFromEuler(eul.set(ps.rot, 0, 0));
      } else if (s.mode === 'extract') {
        const st = s.stage;
        const before = s.mesh.position.length() + s.scale + s.opacity;
        s.mesh.position.x = damp(s.mesh.position.x, st.pos.x, 9, dt);
        s.mesh.position.y = damp(s.mesh.position.y, st.pos.y, 9, dt);
        s.mesh.position.z = damp(s.mesh.position.z, st.pos.z, 9, dt);
        s.mesh.quaternion.slerp(st.quat, 1 - Math.exp(-9 * dt));
        s.scale = damp(s.scale, st.scale, 9, dt);
        s.opacity = damp(s.opacity, s.fading ? 0 : 1, 10, dt);
        s.bend = damp(s.bend, 0, 11, dt);   // 飛出時把翻平攤平
        this.motionLevel = Math.max(this.motionLevel,
          Math.abs(s.mesh.position.length() + s.scale + s.opacity - before), s.bend);
        if (!s.arrived && s.mesh.position.distanceTo(st.pos) < 0.25 * st.scale) {
          s.arrived = true;
          if (this.onStageArrived) this.onStageArrived(s.file);
          s.fadeAt = now + 140;
        }
        if (s.arrived && now > s.fadeAt) s.fading = true;
        // 抵達閱讀區淡出後，卡直接回到卡堆原位（淡入）——不再留一個「消失的洞」：
        // 以前設成 gone 隱形，閱讀時捲動卡堆就少一張，看起來像檔案不見了
        if (s.fading && s.opacity < 0.02) {
          s.mode = 'home'; s.fading = false; s.fadeIn = true; s.yOff = 0;
          s.scale = poseAt(u).scale; s.bend = 0;
        }
      } else if (s.mode === 'return') {
        // 從閱讀面板飛回弧線上自己的位置
        const ps = poseAt(u);
        const cosA = Math.cos(ps.rot), sinA = Math.sin(ps.rot);
        const homePos = new THREE.Vector3(BASE[0], ps.y + cosA * CARD_H / 2, ps.z + sinA * CARD_H / 2);
        const homeQuat = new THREE.Quaternion().setFromEuler(eul.set(ps.rot, 0, 0));
        const k = 1 - Math.exp(-10 * dt);
        const before = s.mesh.position.length() + s.scale;
        s.mesh.position.lerp(homePos, k);
        s.mesh.quaternion.slerp(homeQuat, k);
        s.scale = damp(s.scale, ps.scale, 10, dt);
        s.opacity = damp(s.opacity, s.file ? ps.op : 0, 12, dt);
        s.bend = damp(s.bend, ps.bend, 11, dt);
        this.motionLevel = Math.max(this.motionLevel, Math.abs(s.mesh.position.length() + s.scale - before));
        if (s.mesh.position.distanceTo(homePos) < 0.03) {
          s.mode = 'home'; s.yOff = 0; s.scale = ps.scale; s.arrived = false; s.fading = false;
        }
      }
      // 卡片彎度要先算完（下面把材質／縮放／可見度一次套上去）
      if (s.mode !== 'gone' && Math.abs(s.bend - s.geoBend) > 1e-4) this.bendGeo(s);
      if (s.mode !== 'gone') {
        // 選取只是把整張卡染一層淡淡的選取色（材質色會乘上卡面）：
        // 卡堆上不畫任何框線（歐哥 2026-10-30：框線整個拿掉），
        // 「正在讀哪一張」由左欄游標與閱讀欄表示，卡的位置／高度／大小一律不動。
        const selNow = !!(s.file && this.selected.has(s.file.path));
        if (selNow !== s.selTint) { s.selTint = selNow; s.mesh.material.color.setHex(selNow ? 0xa9c4f5 : 0xffffff); }
        if (Math.abs(s.mesh.scale.x - s.scale) > 1e-4) s.mesh.scale.setScalar(s.scale);
        s.mesh.material.opacity = s.opacity;
        // 完全不透明的卡走不透明管線（寫深度、不參與半透明排序），只有真的在淡入淡出才半透明
        const tr = s.opacity < 0.995;
        if (s.mesh.material.transparent !== tr) { s.mesh.material.transparent = tr; s.mesh.material.needsUpdate = true; }
        s.mesh.visible = s.opacity > 0.015;
      }

      // lazy real thumbnail for visible home cards
      // 縮圖提早排：焦點後面 VIS_BACK+5 張內就先做，捲到時已經是真卡面（不會先白卡再跳）
      if (s.file && s.mode === 'home' && s.d > -3 && s.d < VIS_BACK + 5 && !s.thumbReqPath) {
        const reqPath = s.file.path;
        if (!this.texGet(reqPath)) {
          s.thumbReqPath = reqPath;
          // 根因修正：callback 必須捕捉「請求當下」的 path。滾動後 slot 可能已
          // 換綁別的檔；若到觸發時才讀 s.file.path，舊檔貼圖會被存進新檔的
          // cache key、直接貼上錯的卡（畫面出現「第二張 CLAUDE.md」）。
          requestThumb(s.file, canvasEl => this.applyThumb(reqPath, canvasEl));
        }
      }
    }

    pumpThumbs();

    // 張數指示器：貼堆視區右上角（右下有調參按鈕會擋）；沒有檔案時藏起來
    {
      const n = this.view.length;
      let txt = '';
      if (n > 0) {
        const a = clamp(Math.round(this.scrollCur) + 1, 1, n);
        txt = t('cardCount', { a, n });
      }
      if (txt !== this._countText) {
        this._countText = txt;
        this.countEl.textContent = txt;
        this.countEl.style.display = txt ? '' : 'none';
      }
      if (txt) {
        const right = Math.round(this.viewCss.x + this.viewCss.w - 14);
        this.countEl.style.left = right + 'px';
      }
      const vb = this._viewBar || (this._viewBar = document.getElementById('viewBar'));
      if (vb) {
        vb.style.left = Math.round(this.viewCss.x + 14) + 'px';
        vb.classList.toggle('narrow', !(this.viewCss.w > 360));
      }
      // 路徑列貼左上、讓出右上張數；首次提示卡置中在堆視區下方
      const pb = this.pathBarEl;
      if (pb) { pb.style.left = Math.round(this.viewCss.x + 14) + 'px'; pb.style.maxWidth = Math.max(120, Math.round(this.viewCss.w - 130)) + 'px'; }
      const tip = this._tipEl || (this._tipEl = document.getElementById('hint'));
      if (tip) tip.style.left = Math.round(this.viewCss.x + this.viewCss.w / 2) + 'px';
    }

    this.renderer.setScissorTest(false);
    this.renderer.setClearColor(theme().scene, 1);
    this.renderer.clear();
    if (this.viewCss.w > 2) {
      this.renderer.setScissorTest(true);
      this.renderer.render(this.scene, this.camera);
    }

    const busy = this.motionLevel > 0.0008 || now < this.wakeUntil ||
      thumbQueueSize() > 0 || this.viewportDelta() > 0.5 || this.phase !== 'idle';
    if (busy) this.rafId = requestAnimationFrame(t => this.tick(t));
    else this.rafId = null;
  }

  // 換主題：場景底色、地板換色；所有卡面貼圖丟掉重畫（先上新主題的 placeholder，再排真縮圖）
  retheme() {
    const T = theme();
    this.scene.background.set(T.scene);
    for (const m of [this.texCache, this.phCache]) { for (const e of m.values()) e.tex.dispose(); m.clear(); }
    for (const s of this.slots) {
      if (!s.file) continue;
      s.mesh.material.map = this.placeholderTex(s.file);
      s.mesh.material.needsUpdate = true;
      s.phShared = false;
      s.thumbReqPath = null;
    }
    this.poke();
  }

  applyThumb(path, canvasEl) {
    if (canvasEl.themeGen != null && canvasEl.themeGen !== themeGen) {   // 舊主題畫的，丟掉、讓卡重新排
      for (const s of this.slots) if (s.thumbReqPath === path) s.thumbReqPath = null;
      return;
    }
    const old = this.texCache.get(path);
    if (old) { this.texCache.delete(path); old.tex.dispose(); }
    const tex = this.makeTex(canvasEl);
    this.texSet(path, tex);
    const texName = String(path).split(/[\\/]/).pop();
    for (const s of this.slots) {
      if (s.file && s.file.path === path) {
        s.mesh.material.map = tex;
        s.mesh.material.needsUpdate = true;
        s.texName = texName;            // 貼圖身分 = 來源檔名（e2e 斷言用）
        s.phShared = false;
      }
    }
    this.poke();
  }

  // ------------------------------------------------------------- test/debug
  avgFps() {
    if (this.fpsRing.length < 2) return 0;
    const span = this.fpsRing[this.fpsRing.length - 1] - this.fpsRing[0];
    return span > 0 ? Math.round((this.fpsRing.length - 1) / (span / 1000) * 10) / 10 : 0;
  }
  // e2e：量「互動期間幀率」前先清 ring——ring 是最近 3 秒幀時間戳，
  // 含 raf 停走的靜止段會把分母灌水稀釋（dilution 假低幀）
  resetFps() { this.fpsRing.length = 0; }
  // e2e（追加 B）：點 ✕ 放回後斷言該卡真的重新可見——曾有 bug：抽出抵達閱讀面板後
  // 卡片淡出成 gone/mesh.visible=false，放回時沒還原，卡片永遠隱形。
  cardMeshVisible(fileIdx) {
    const s = this.slots.find(x => x.fileIdx === fileIdx && x.file);
    return s ? (s.mesh.visible && s.mode !== 'gone') : null;
  }
  // e2e（選取框閃爍）的 selProbe() 放在 main.js 的 __dbg 裡：它只讀這裡的欄位，
  // 放 main.js 才不會因為只回退 stack.js 就整個鉤子不見（新舊版對照要用）。
  dbg() {
    return {
      files: this.view.length, phase: this.phase, folder: this.folderLabel,
      scroll: +this.scrollCur.toFixed(2), scrollMax: +this.scrollMax().toFixed(2),
      gap: +this.gap().toFixed(3), winCap: this.winCap(), visShown: this.visShown,
      hoverD: this.hoverD == null ? null : +this.hoverD.toFixed(2),
      rafRunning: this.rafId != null,
      textures: this.renderer.info.memory.textures,
      total: this.total != null ? this.total : (this.view ? this.view.length : 0),
      hasMore: !!this.hasMore,
      sel: this.selectedFiles().length,
      allSel: this.allSelected(),
      extracted: this.extracted ? (this.extractedFile || this.extracted.file).name : null,
      lastFolderSwitchMs: this.lastFolderSwitchMs,
      maxBend: +Math.max(0, ...this.slots.filter(s => s.mode !== 'gone').map(s => s.bend)).toFixed(3),
      scrollTarget: +this.scrollTarget.toFixed(2), scrollVel: +this.scrollVel.toFixed(2), wheelLog: (this._wheelLog || []).slice(-12),
      hinge: FOCUS_HINGE,
      fitDist: +this.fitCur.dist.toFixed(2), fitDistT: +this.fitTarget.dist.toFixed(2),
      fitDbg: this._fitDbg || null,
      camPos: this.camera.position.toArray().map(v => +v.toFixed(2)),
      aspect: +this.camera.aspect.toFixed(3)
    };
  }
}

// ---------------------------------------------------------------- params panel
export function buildParamsPanel(stack) {
  const host = document.createElement('div');
  host.id = 'params';
  host.innerHTML = `<button id="paramsToggle">${t('tune')}</button><div id="paramsBody"></div>`;
  document.body.appendChild(host);
  const body = host.querySelector('#paramsBody');
  // 滑桿上下限一律由 P_RANGES 推導（單一真相）：以前這裡另外寫死一份，改範圍要改兩處、
  // 漏改就出現「滑桿拉得到但存檔被夾掉」的鬼畫面。
  const rows = [
    ['fov', t('fovLabel'), 1, '°'],
  ];
  for (const [key, label, step, unit] of rows) {
    const [min, max] = P_RANGES[key];
    const row = document.createElement('label');
    row.className = 'p-row';
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${P[key]}"><em>${P[key]}${unit}</em>`;
    const input = row.querySelector('input');
    const em = row.querySelector('em');
    input.addEventListener('input', () => {
      P[key] = parseFloat(input.value);
      em.textContent = input.value + unit;
      saveParams();
      stack.applyCamera();
      stack.poke();
    });
    body.appendChild(row);
  }
  host.querySelector('#paramsToggle').addEventListener('click', () => host.classList.toggle('open'));
}

export { P_DEFAULTS, easeInOutCubic };
