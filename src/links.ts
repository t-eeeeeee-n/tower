// 画面の中のリンクを、既定のブラウザで開く
import { invoke } from "@tauri-apps/api/core";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
// 文の終わりの句読点や閉じ括弧は URL に含めない（対になる開き括弧が URL の中にあるときは残す）
const TRAILING = /[.,;:!?。、）」』】]+$/;

function trimUrl(url: string) {
  let u = url.replace(TRAILING, "");
  while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1).replace(TRAILING, "");
  return u;
}

export function openLink(url: string, onError: (e: unknown) => void) {
  invoke("open_link", { url }).catch(onError);
}

/** 文字だけの画面（一覧のカード・入力欄の下の行）の中の URL を、押せるリンクにする */
export function linkify(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue?.includes("http")) texts.push(n as Text);
  for (const t of texts) {
    const value = t.nodeValue!;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of value.matchAll(URL_RE)) {
      const url = trimUrl(m[0]);
      frag.append(value.slice(last, m.index));
      const a = document.createElement("a");
      a.href = url;
      a.className = "t-link";
      a.title = `${url}\nクリックでブラウザで開く`;
      a.textContent = url;
      frag.append(a);
      last = m.index! + url.length;
    }
    if (!last) continue;
    frag.append(value.slice(last));
    t.replaceWith(frag);
  }
}

/** ターミナルの各行の URL を、押せるリンクにする（折り返した行にまたがる URL は、行ごとに別のリンクになる） */
export function terminalLinks(term: Terminal, open: (url: string) => void): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      // 全角の文字は 2 マス使うので、文字の位置とマスの位置の対応を作る
      let text = "";
      const col: number[] = [];
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        for (let i = 0; i < chars.length; i++) col.push(x);
        text += chars;
      }
      const links: ILink[] = [];
      for (const m of text.matchAll(URL_RE)) {
        const url = trimUrl(m[0]);
        const start = m.index!;
        const end = start + url.length - 1;
        links.push({
          text: url,
          range: { start: { x: col[start] + 1, y }, end: { x: col[end] + 1, y } },
          activate: () => open(url),
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}

/**
 * Tower の画面の中のリンクは、押しても Tower のページを移さない。Web のページなら既定のブラウザで開き、
 * ほか（Markdown の相対リンクなど）は何もしない
 */
export function handleLinks(onError: (e: unknown) => void) {
  for (const type of ["click", "auxclick"] as const) {
    document.addEventListener(type, (ev) => {
      const a = (ev.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      ev.preventDefault();
      if (type === "auxclick" && ev.button !== 1) return;
      // カードのクリックでセッションを開いたり入力欄に移ったりさせない
      ev.stopPropagation();
      const href = a.getAttribute("href")!;
      if (/^https?:\/\//i.test(href)) openLink(href, onError);
    }, true);
  }
}
