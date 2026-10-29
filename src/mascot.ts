// Tower のキャラ（ヘッドセットを付けた管制塔）。窓が顔で、てっぺんのアンテナの光で全体の状態を表す。
// ターミナルのブロックの記号でも描けるよう、2×2 の点を 1 文字にできる粗さのドット絵にしている

export type MascotState = "run" | "wait" | "ok" | "off";

// . 空き / W 塔 / O 窓 / E 目 / A アンテナの光 / S アンテナの軸 / K ヘッドセット
const GRID = [
  "......A......",
  "......S......",
  "..KKKKKKKKK..",
  ".KWWWWWWWWWK.",
  "KKOOOOOOOOOKK",
  "KKOEEOOOEEOKK",
  "KKOEEOOOEEOKK",
  ".WOOOOOOOOOW.",
  "..WWWWWWWWKK.",
  "....WWWWW....",
  "....WWWWW....",
  "...WW...WW...",
];

const PART: Record<string, string> = { W: "m-body", O: "m-window", E: "m-eye", A: "m-light", S: "m-stem", K: "m-gear" };
const LABEL: Record<MascotState, string> = { run: "作業中", wait: "入力待ち", ok: "待機中", off: "セッションなし" };
const NS = "http://www.w3.org/2000/svg";

function pixels(grid: string[], px: number, cls: string, classOf: (c: string, x: number, y: number) => string | undefined) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${grid[0].length} ${grid.length}`);
  svg.setAttribute("width", String(grid[0].length * px));
  svg.setAttribute("height", String(grid.length * px));
  svg.setAttribute("class", cls);
  svg.setAttribute("shape-rendering", "crispEdges");
  grid.forEach((row, y) =>
    [...row].forEach((c, x) => {
      const part = classOf(c, x, y);
      if (!part) return;
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(x));
      r.setAttribute("y", String(y));
      r.setAttribute("width", "1");
      r.setAttribute("height", "1");
      r.setAttribute("class", part);
      svg.append(r);
    }),
  );
  return svg;
}

/** px は 1 点の大きさ */
export function createMascot(px: number, state: MascotState = "ok") {
  // 目の上の段は、まばたきと終了のときに窓の色にして、閉じた目（横線）に見せる
  const svg = pixels(GRID, px, "mascot", (c, x, y) =>
    PART[c] && (c === "E" && GRID[y + 1]?.[x] === "E" ? `${PART[c]} m-eye-top` : PART[c]),
  );
  // 目を動かしても元の場所に穴が開かず、隣の窓の点に隠れないよう、窓の色を下に敷いて目を最後に描く
  const under = document.createElementNS(NS, "rect");
  for (const [k, v] of Object.entries({ x: 2, y: 4, width: 9, height: 4, class: "m-window" })) under.setAttribute(k, String(v));
  svg.prepend(under);
  svg.append(...svg.querySelectorAll(".m-eye"));
  svg.setAttribute("role", "img");
  setMascot(svg, state);
  return svg;
}

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// style.css の .mascot.hop / .happy / .signal の長さ
const MOVE_MS = { hop: 500, happy: 900, signal: 700 };
export type MascotMove = keyof typeof MOVE_MS;

/** 跳ねる・目を細める・アンテナで合図する。続けて呼ぶと、動きを最初から流し直す */
export function moveMascot(svg: SVGSVGElement, ...moves: MascotMove[]) {
  if (still()) return;
  for (const m of moves) {
    svg.classList.remove(m);
    void svg.getBoundingClientRect();
    svg.classList.add(m);
    clearTimeout(Number(svg.dataset[m]));
    svg.dataset[m] = String(setTimeout(() => svg.classList.remove(m), MOVE_MS[m]));
  }
}

// 横向きの小さな飛行機。P 機体 / T 尾翼 / L 機首の灯
const PLANE = ["T.......", "TT.PP...", "PPPPPPPL", "...PP..."];
const PLANE_PART: Record<string, string> = { P: "p-body", T: "p-tail", L: "p-light" };
const TAKEOFF_MS = 3200;
const LAND_MS = 900;
/** 離陸の動き（style.css の ws-takeoff）で、滑走路を離れて上りはじめるところ */
const LIFTOFF_MS = TAKEOFF_MS * 0.45;
const GLANCE_MS = 1200;
// style.css の fx-takeoff / fx-land の長さ
const FX_MS = 1400;

/**
 * target の右寄りから小さな飛行機を飛び立たせる（takeoff）か、そこへ降ろす（land）。
 * 画面全体の上に重ねて飛ばすので、target が描き直されても途切れない
 */
export function planeEffect(target: Element, kind: "takeoff" | "land") {
  const box = target.getBoundingClientRect();
  if (still() || !box.width) return;
  const p = document.createElement("div");
  p.className = `fx-plane fx-${kind}`;
  p.setAttribute("aria-hidden", "true");
  p.append(pixels(PLANE, 2, "plane", (c) => PLANE_PART[c]));
  p.style.left = `${box.right - 34}px`;
  p.style.top = `${box.top + box.height / 2 - 4}px`;
  document.body.append(p);
  setTimeout(() => p.remove(), FX_MS + 100);
}

/**
 * セッションが無いときの画面の下に置く、管制塔と滑走路の小さな場面。
 * 飛行機は、まだ離陸していない（始めていない）セッションの見立て
 */
export function createWelcomeScene(root: HTMLElement) {
  const ground = document.createElement("div");
  ground.className = "ws-ground";
  const runway = document.createElement("div");
  runway.className = "ws-runway";
  const tower = document.createElement("div");
  tower.className = "ws-tower";
  const mascot = createMascot(6, "ok");
  mascot.classList.add("alive");
  tower.append(mascot);
  let watching = false;
  const look = (dir: string) => {
    if (dir) mascot.dataset.look = dir;
    else delete mascot.dataset.look;
  };
  // 飛行機を見送る。アンテナで合図して跳ね、目で追う
  const seeOff = () => {
    watching = true;
    moveMascot(mascot, "signal", "hop");
    look("right");
    setTimeout(() => look("up"), LIFTOFF_MS);
    setTimeout(() => {
      look("");
      watching = false;
    }, TAKEOFF_MS);
  };
  // 何も飛んでいないときは、ときどき左右を見る
  setInterval(() => {
    if (watching || still() || !root.offsetParent || Math.random() > 0.12) return;
    look(Math.random() < 0.5 ? "left" : "right");
    setTimeout(() => !watching && look(""), GLANCE_MS);
  }, 1000);
  tower.onclick = () => moveMascot(mascot, "hop", "happy");
  const planes = [0, 1, 2].map((i) => {
    const p = document.createElement("div");
    p.className = `ws-plane ws-plane-${i}`;
    p.append(pixels(PLANE, 5, "plane", (c) => PLANE_PART[c]));
    return p;
  });
  const stars = Array.from({ length: 14 }, (_, i) => {
    const s = document.createElement("span");
    s.className = "ws-star";
    s.style.left = `${(i * 37 + 11) % 100}%`;
    s.style.bottom = `${58 + ((i * 53) % 70)}px`;
    return s;
  });
  root.replaceChildren(...stars, ground, runway, tower, ...planes);
  // 滑走路の先頭（右）から順に離陸し、飛んでいった機体は戻さない。3 機とも飛び去ったら、そろって現れ直す
  const queue = [...planes].reverse();

  /** 次の飛行機を 1 機離陸させる。最後の 1 機なら、飛び去ったあとに 3 機を元の場所に戻す */
  function takeoff() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const p = queue.find((x) => !x.classList.contains("fly") && !x.classList.contains("land"));
    if (!p) return;
    p.classList.add("fly");
    seeOff();
    if (queue.some((x) => !x.classList.contains("fly"))) return;
    setTimeout(() => {
      for (const x of queue) {
        x.classList.remove("fly");
        x.classList.add("land");
      }
      setTimeout(() => queue.forEach((x) => x.classList.remove("land")), LAND_MS);
    }, TAKEOFF_MS + 600);
  }
  return { takeoff };
}

/** しばらく dir の向きを見る（right / left / up / down） */
export function lookMascot(svg: SVGSVGElement, dir: string, ms: number) {
  if (still()) return;
  svg.dataset.look = dir;
  clearTimeout(Number(svg.dataset.lookTimer));
  svg.dataset.lookTimer = String(setTimeout(() => delete svg.dataset.look, ms));
}

/** 待っている間、ときどき左右を見る。svg が画面から外されたら止める */
export function glanceAround(svg: SVGSVGElement) {
  const timer = setInterval(() => {
    if (!svg.isConnected) return clearInterval(timer);
    if (svg.dataset.look || !svg.getClientRects().length || Math.random() > 0.12) return;
    lookMascot(svg, Math.random() < 0.5 ? "left" : "right", GLANCE_MS);
  }, 1000);
}

export function setMascot(svg: SVGSVGElement, state: MascotState) {
  if (svg.dataset.state === state) return;
  svg.dataset.state = state;
  svg.setAttribute("aria-label", `Tower（${LABEL[state]}）`);
}
