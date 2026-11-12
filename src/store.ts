// 画面の設定と一覧を ~/.tower/settings.json に残す（store.rs）。localStorage と同じ使い方ができるよう、
// 起動の最初に全部を読んで手元に持ち、書くたびにファイルへ送る。
// 値は文字列で受け渡すが、ファイルには JSON として読める形で書く（手で見たり直したりできるように）
import { invoke } from "@tauri-apps/api/core";

const cache = new Map<string, string>();
// ファイルを使えないとき（読めない・壊れている）は、これまでどおり localStorage を使う
let fallback = false;
let writing: Promise<unknown> = Promise.resolve();

// JSON として読める値は読んだ形で書く。ただし文字列になるもの（"\"x\"" など）は、戻すときに引用符が消えるのでそのまま書く
const toFile = (v: string): unknown => {
  try {
    const p: unknown = JSON.parse(v);
    return typeof p === "string" ? v : p;
  } catch {
    return v;
  }
};
const fromFile = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function send(entries: Record<string, unknown>) {
  // 順番どおりに書かれるよう、前の書き込みが終わってから送る
  writing = writing.then(() => invoke("store_set", { entries }).catch((e) => console.error("設定を保存できませんでした", e)));
}

export async function initStore() {
  let data: Record<string, unknown> | null;
  try {
    data = await invoke<Record<string, unknown> | null>("store_load");
  } catch (e) {
    console.error(e);
    fallback = true;
    return;
  }
  if (data) {
    for (const [k, v] of Object.entries(data)) cache.set(k, fromFile(v));
    return;
  }
  // 初めて使うときは、これまで localStorage に入っていた分を移す
  const moved: Record<string, unknown> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = k === null ? null : localStorage.getItem(k);
      if (k === null || v === null) continue;
      cache.set(k, v);
      moved[k] = toFile(v);
    }
  } catch {
    /* 読めなければ空から始める */
  }
  send(moved);
}

export const storage = {
  getItem(key: string): string | null {
    if (fallback) return localStorage.getItem(key);
    return cache.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    if (fallback) return localStorage.setItem(key, value);
    if (cache.get(key) === value) return;
    cache.set(key, value);
    send({ [key]: toFile(value) });
  },
  removeItem(key: string) {
    if (fallback) return localStorage.removeItem(key);
    if (!cache.delete(key)) return;
    send({ [key]: null });
  },
};
