// 設定画面：配色・フォント・カーソルと通知。配色は Git Bash（mintty）のテーマファイルから選べる
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { MinttyConfig, Palette, ThemeOption, TOWER, parseMintty, themeOptions, uiTokens, xtermTheme } from "./theme";

type CursorStyle = "block" | "underline" | "bar";
interface Appearance {
  theme: string;
  font: string;
  fontSize: number;
  cursor: CursorStyle;
  blink: boolean;
}
interface Notify {
  waiting: boolean;
  done: boolean;
}

const DEFAULT: Appearance = { theme: "tower", font: "Cascadia Mono", fontSize: 14, cursor: "block", blink: true };
const FONTS = ["Cascadia Mono", "Cascadia Code", "Consolas", "BIZ UDGothic", "MS Gothic", "Lucida Console", "Courier New"];
// 選んだフォントに無い文字（日本語など）を補う
const FALLBACK = '"Cascadia Code", "BIZ UDGothic", Consolas, "MS Gothic", monospace';
const MIN_SIZE = 8;
const MAX_SIZE = 32;
const NOTIFY_DEFAULT: Notify = { waiting: true, done: true };
// ~/.minttyrc に書かれていないときの mintty の既定値（mintty のマニュアルの Font・FontHeight・CursorType・CursorBlinks）
const MINTTY_DEFAULT = { font: "Lucida Console", fontheight: "9", cursortype: "line", cursorblinks: "yes" };
const CURSOR_BY_MINTTY: Record<string, CursorStyle> = { line: "bar", block: "block", underscore: "underline" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fontStack(font: string) {
  const name = font.replace(/["']/g, "").trim();
  return name ? `"${name}", ${FALLBACK}` : FALLBACK;
}

const probe = document.createElement("canvas").getContext("2d")!;

/** 汎用フォントで代わりに描いたときと幅が変わらなければ、その名前のフォントは無い */
function fontInstalled(name: string) {
  const text = "mmmmmmmmmmlli1WW@#日本語";
  return ["monospace", "serif", "sans-serif"].some((base) => {
    probe.font = `40px ${base}`;
    const fallback = probe.measureText(text).width;
    probe.font = `40px "${name}", ${base}`;
    return probe.measureText(text).width !== fallback;
  });
}

function clampSize(n: number) {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));
}

function loadJson<T>(key: string): Partial<T> | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

function loadNotify(): Notify {
  const v = { ...NOTIFY_DEFAULT, ...loadJson<Notify>("notify") };
  return { waiting: v.waiting !== false, done: v.done !== false };
}

function loadSettings(): Appearance {
  const v = { ...DEFAULT, ...loadJson<Appearance>("appearance") };
  return {
    theme: String(v.theme),
    font: String(v.font),
    fontSize: Number.isFinite(v.fontSize) ? clampSize(v.fontSize) : DEFAULT.fontSize,
    cursor: v.cursor in { block: 1, underline: 1, bar: 1 } ? v.cursor : DEFAULT.cursor,
    blink: v.blink !== false,
  };
}

export function createSettings(term: Terminal, refit: () => void, showError: (e: unknown) => void) {
  const dialog = $<HTMLDialogElement>("look-dialog");
  const list = $("look-themes");
  const fFont = $<HTMLInputElement>("look-font");
  const fSize = $<HTMLInputElement>("look-size");
  const fCursor = $<HTMLSelectElement>("look-cursor");
  const fBlink = $<HTMLInputElement>("look-blink");
  const fFontHint = $("look-font-hint");
  const fNotifyWaiting = $<HTMLInputElement>("look-notify-waiting");
  const fNotifyDone = $<HTMLInputElement>("look-notify-done");

  let settings = loadSettings();
  let options: ThemeOption[] = [{ id: "tower", label: "Tower", palette: TOWER }];
  let gitBash = new Map<string, string>();
  let notify = loadNotify();
  let before = settings;
  // テーマファイルを読み終わるまでは、前回の配色で表示しておく（起動時に Tower の色が一瞬出ないように）
  let cached = loadJson<Palette>("appearancePalette") as Palette | null;

  function palette(): Palette {
    const found = options.find((o) => o.id === settings.theme)?.palette;
    if (found) return found;
    return cached?.ansi?.length === 16 ? cached : TOWER;
  }

  function apply() {
    const p = palette();
    const root = document.documentElement.style;
    for (const k of Object.keys(uiTokens(TOWER))) root.removeProperty(k);
    if (p !== TOWER) for (const [k, v] of Object.entries(uiTokens(p))) root.setProperty(k, v);
    const font = fontStack(settings.font);
    root.setProperty("--mono", font);
    term.options.theme = xtermTheme(p);
    term.options.fontFamily = font;
    term.options.fontSize = settings.fontSize;
    term.options.cursorStyle = settings.cursor;
    term.options.cursorBlink = settings.blink;
    refit();
  }

  function checkFont() {
    const name = settings.font.replace(/["']/g, "").trim();
    const missing = name !== "" && !fontInstalled(name);
    fFontHint.textContent = missing ? `「${name}」はこの PC に見つかりません。代わりに Cascadia Code などで表示しています。` : "";
    fFontHint.hidden = !missing;
  }

  function commit() {
    save("appearance", settings);
    save("notify", notify);
    cached = palette();
    save("appearancePalette", cached);
  }

  function update(patch: Partial<Appearance>) {
    settings = { ...settings, ...patch };
    apply();
  }

  function renderThemes() {
    list.replaceChildren(
      ...options.map((o) => {
        const b = el("button", "theme-opt");
        b.type = "button";
        b.dataset.id = o.id;
        b.setAttribute("role", "option");
        const on = o.id === settings.theme;
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
        const sw = el("span", "theme-swatch");
        sw.style.background = o.palette.bg;
        sw.style.color = o.palette.fg;
        sw.append(el("span", "", "Aa"));
        for (const c of o.palette.ansi.slice(1, 7)) {
          const dot = el("i");
          dot.style.background = c;
          sw.append(dot);
        }
        b.append(sw, el("span", "theme-name", o.label));
        b.onclick = () => pickTheme(o.id);
        return b;
      }),
    );
    if (!options.some((o) => o.id === settings.theme)) list.querySelector<HTMLElement>(".theme-opt")!.tabIndex = 0;
  }

  function pickTheme(id: string) {
    update({ theme: id });
    renderThemes();
    list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  }

  function fill() {
    fFont.value = settings.font;
    fSize.value = String(settings.fontSize);
    fCursor.value = settings.cursor;
    fBlink.checked = settings.blink;
    fNotifyWaiting.checked = notify.waiting;
    fNotifyDone.checked = notify.done;
    checkFont();
    const own = gitBash.get("font");
    $("look-fonts").replaceChildren(
      ...[...new Set([...(own ? [own] : []), ...FONTS])].map((f) => {
        const o = el("option");
        o.value = f;
        return o;
      }),
    );
    renderThemes();
  }

  function matchGitBash() {
    const rc = (k: keyof typeof MINTTY_DEFAULT) => gitBash.get(k) || MINTTY_DEFAULT[k];
    const patch: Partial<Appearance> = { theme: "gitbash", font: rc("font") };
    // mintty の FontHeight はポイント、xterm.js の fontSize はピクセル（96dpi で 1pt = 4/3px）
    const pt = Number(rc("fontheight"));
    if (pt > 0) patch.fontSize = clampSize((pt * 4) / 3);
    const cursor = CURSOR_BY_MINTTY[rc("cursortype").toLowerCase()];
    if (cursor) patch.cursor = cursor;
    patch.blink = !["no", "false", "off", "0"].includes(rc("cursorblinks").toLowerCase());
    update(patch);
    fill();
  }

  let notifyBefore = notify;
  function cancel() {
    settings = before;
    notify = notifyBefore;
    apply();
    dialog.close();
  }

  list.onkeydown = (ev) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 }[ev.key];
    if (!step) return;
    ev.preventDefault();
    const cur = Math.max(0, options.findIndex((o) => o.id === settings.theme));
    const next = Math.min(options.length - 1, Math.max(0, cur + step));
    pickTheme(options[next].id);
  };
  fFont.oninput = () => {
    update({ font: fFont.value });
    checkFont();
  };
  fSize.oninput = () => {
    const n = Number(fSize.value);
    if (fSize.value && Number.isFinite(n)) update({ fontSize: clampSize(n) });
  };
  fSize.onchange = () => (fSize.value = String(settings.fontSize));
  fCursor.onchange = () => update({ cursor: fCursor.value as CursorStyle });
  fBlink.onchange = () => update({ blink: fBlink.checked });
  fNotifyWaiting.onchange = () => (notify = { ...notify, waiting: fNotifyWaiting.checked });
  fNotifyDone.onchange = () => (notify = { ...notify, done: fNotifyDone.checked });
  $("look-gitbash").onclick = matchGitBash;
  $("look-reset").onclick = () => {
    update({ ...DEFAULT });
    notify = { ...NOTIFY_DEFAULT };
    fill();
  };
  $("look-cancel").onclick = cancel;
  dialog.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    cancel();
  });
  $<HTMLFormElement>("look-form").onsubmit = (ev) => {
    ev.preventDefault();
    commit();
    dialog.close();
  };

  apply();
  invoke<MinttyConfig>("mintty_config")
    .then((m) => {
      options = themeOptions(m);
      gitBash = parseMintty(m.config);
      apply();
      // 開いている設定画面の試し中の値は保存しない
      if (dialog.open) fill();
      else if (options.some((o) => o.id === settings.theme)) commit();
    })
    .catch(showError);

  return {
    isOpen: () => dialog.open,
    notify: () => notify,
    open() {
      if (dialog.open) return;
      before = settings;
      notifyBefore = notify;
      fill();
      dialog.showModal();
      list.querySelector<HTMLElement>('.theme-opt[tabindex="0"]')?.focus();
    },
  };
}
