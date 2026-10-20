import type { ITheme } from "@xterm/xterm";

export interface Palette {
  fg: string;
  bg: string;
  cursor: string;
  selection?: string;
  /** Black, Red, Green, Yellow, Blue, Magenta, Cyan, White, 続けて Bold の 8 色 */
  ansi: string[];
}

export interface ThemeOption {
  id: string;
  label: string;
  palette: Palette;
}

export interface MinttyConfig {
  themes: { name: string; text: string }[];
  config: string;
}

const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

export const TOWER: Palette = {
  fg: "#e3e8f0",
  bg: "#121822",
  cursor: "#e9b04b",
  selection: "#34445e",
  ansi: [
    "#1b2331", "#e57373", "#8cc48a", "#e9b04b", "#6f9fe0", "#b69be0", "#5fb3c8", "#c9d1dd",
    "#566176", "#f08f8f", "#a6d8a3", "#f3c56f", "#8db6ee", "#cbb5ee", "#82cadb", "#f2f5f9",
  ],
};

// mintty の既定の配色（テーマファイルに書かれていない色はこれになる）
const MINTTY: Palette = {
  fg: "#bfbfbf",
  bg: "#000000",
  cursor: "#bfbfbf",
  ansi: [
    "#000000", "#bf0000", "#00bf00", "#bfbf00", "#0000bf", "#bf00bf", "#00bfbf", "#bfbfbf",
    "#404040", "#ff4040", "#40ff40", "#ffff40", "#6060ff", "#ff40ff", "#40ffff", "#ffffff",
  ],
};

/** mintty の設定・テーマファイルの key=value を読む（キーは小文字。後に書かれたものが優先） */
export function parseMintty(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out.set(line.slice(0, eq).trim().toLowerCase().replace("color", "colour"), line.slice(eq + 1).trim());
  }
  return out;
}

function parseColour(v: string | undefined): string | null {
  if (!v) return null;
  const rgb = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(v);
  if (rgb) return toHex(rgb.slice(1).map(Number));
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const short = /^#([0-9a-f]{3})$/i.exec(v);
  if (short) return `#${[...short[1]].map((c) => c + c).join("").toLowerCase()}`;
  return null;
}

export function minttyPalette(settings: Map<string, string>): Palette {
  const get = (k: string, fallback: string) => parseColour(settings.get(k)) ?? fallback;
  const fg = get("foregroundcolour", MINTTY.fg);
  return {
    fg,
    bg: get("backgroundcolour", MINTTY.bg),
    cursor: get("cursorcolour", fg),
    ansi: [
      ...ANSI_KEYS.map((k, i) => get(k, MINTTY.ansi[i])),
      ...ANSI_KEYS.map((k, i) => get(`bold${k}`, MINTTY.ansi[i + 8])),
    ],
  };
}

export function themeOptions(m: MinttyConfig): ThemeOption[] {
  const rc = parseMintty(m.config);
  const file = rc.get("themefile")?.split(/[\\/]/).pop();
  const own = file ? m.themes.find((t) => t.name === file) : undefined;
  const opts: ThemeOption[] = [
    {
      id: "gitbash",
      label: `Git Bash（${own?.name ?? "mintty"}）`,
      palette: minttyPalette(own ? parseMintty(own.text) : rc),
    },
    { id: "tower", label: "Tower", palette: TOWER },
  ];
  for (const t of m.themes) opts.push({ id: `mintty:${t.name}`, label: t.name, palette: minttyPalette(parseMintty(t.text)) });
  return opts;
}

export function xtermTheme(p: Palette): ITheme {
  const [black, red, green, yellow, blue, magenta, cyan, white] = p.ansi;
  const [brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = p.ansi.slice(8);
  return {
    background: p.bg,
    foreground: p.fg,
    cursor: p.cursor,
    cursorAccent: p.bg,
    selectionBackground: p.selection ?? mix(p.bg, p.fg, 0.28),
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}

/** 端末の配色から画面全体の色（style.css の変数）を作る。Tower のときは style.css の値をそのまま使う */
export function uiTokens(p: Palette): Record<string, string> {
  const at = (t: number) => mix(p.bg, p.fg, t);
  const panel = at(0.07);
  // 通常色と Bold 色のうち、背景との差が大きいほうを状態の色に使う
  const pick = (i: number) => (contrast(p.ansi[i], panel) >= contrast(p.ansi[i + 8], panel) ? p.ansi[i] : p.ansi[i + 8]);
  const [red, green, yellow, blue, magenta, cyan] = [1, 2, 3, 4, 5, 6].map(pick);
  return {
    "--ink": p.bg,
    "--bg": at(0.05),
    "--panel": panel,
    "--raise": at(0.12),
    "--raise-2": at(0.17),
    "--line": at(0.15),
    "--text": p.fg,
    "--muted": at(0.62),
    "--faint": at(0.42),
    "--term-dim": at(0.85),
    "--st-running": cyan,
    "--st-waiting": yellow,
    "--st-idle": green,
    "--st-starting": magenta,
    "--st-shell": at(0.55),
    "--st-exited": at(0.35),
    "--danger": red,
    "--on-running": onColour(cyan),
    "--on-waiting": onColour(yellow),
    "--hl-text": p.fg,
    "--hl-comment": at(0.45),
    "--hl-keyword": cyan,
    "--hl-string": green,
    "--hl-number": yellow,
    "--hl-title": blue,
    "--hl-type": magenta,
    "--hl-attr": p.ansi[14],
    "--hl-deletion": red,
    "color-scheme": luminance(p.bg) > 0.4 ? "light" : "dark",
  };
}

function onColour(c: string) {
  return luminance(c) > 0.3 ? mix(c, "#000000", 0.82) : "#ffffff";
}

function toHex(rgb: number[]) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

function rgbOf(hex: string) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

export function mix(a: string, b: string, t: number) {
  const [x, y] = [rgbOf(a), rgbOf(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

// WCAG 2.x の相対輝度とコントラスト比
function luminance(hex: string) {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
