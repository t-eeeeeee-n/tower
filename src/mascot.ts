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
  svg.setAttribute("role", "img");
  setMascot(svg, state);
  return svg;
}

// 横向きの小さな飛行機。P 機体 / T 尾翼 / L 機首の灯
const PLANE = ["T.......", "TT.PP...", "PPPPPPPL", "...PP..."];
const PLANE_PART: Record<string, string> = { P: "p-body", T: "p-tail", L: "p-light" };
const TAKEOFF_MS = 3200;

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

  /** 止まっている飛行機を 1 機離陸させ、しばらくしたら元の場所に戻す */
  function takeoff() {
    const p = planes.find((x) => !x.classList.contains("fly"));
    if (!p || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    p.classList.add("fly");
    setTimeout(() => {
      p.classList.remove("fly");
      p.classList.add("land");
      setTimeout(() => p.classList.remove("land"), 900);
    }, TAKEOFF_MS + 2500);
  }
  return { takeoff };
}

export function setMascot(svg: SVGSVGElement, state: MascotState) {
  if (svg.dataset.state === state) return;
  svg.dataset.state = state;
  svg.setAttribute("aria-label", `Tower（${LABEL[state]}）`);
}
