// 指示のテンプレート。選ぶと入力欄に入れるだけで、送信はしない
interface Template {
  name: string;
  text: string;
}

const KEY = "templates";
const SAMPLES: Template[] = [
  { name: "テストを実行", text: "テストを実行して、失敗したものがあれば原因を調べて直してください。" },
  { name: "変更を説明", text: "今回の変更内容を、変更したファイルごとに短く説明してください。" },
  { name: "コミット", text: "変更を確認して、内容に合ったメッセージでコミットしてください。" },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function load(): Template[] {
  try {
    const raw = localStorage.getItem(KEY);
    // 初めて使うときだけ例を入れておく（全部消したあとは空のまま）
    if (raw === null) return SAMPLES.map((t) => ({ ...t }));
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t) => typeof t?.name === "string" && typeof t?.text === "string") : [];
  } catch {
    return [];
  }
}

function save(list: Template[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

export function createTemplates() {
  let templates = load();
  const menu = el("div", "tpl-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  let onClose: (() => void) | null = null;

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    const done = onClose;
    onClose = null;
    done?.();
  }

  function focusItem(step: number) {
    const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const cur = items.indexOf(document.activeElement as HTMLElement);
    items[(cur + step + items.length) % items.length]?.focus();
  }

  /** anchor の近くにテンプレートの一覧を出す。選んだら onPick、閉じたら onClose を呼ぶ */
  function pick(anchor: HTMLElement, onPick: (text: string) => void, closed?: () => void) {
    closeMenu();
    const item = (label: string, cls: string, action: () => void) => {
      const b = el("button", cls, label);
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.onclick = (ev) => {
        ev.stopPropagation();
        onClose = null;
        menu.hidden = true;
        action();
      };
      return b;
    };
    menu.replaceChildren(
      ...(templates.length
        ? templates.map((t) => {
            const b = item(t.name || "（名前なし）", "tpl-item", () => onPick(t.text));
            b.title = t.text;
            return b;
          })
        : [el("p", "tpl-empty", "テンプレートがありません")]),
      item("テンプレートを編集…", "tpl-item tpl-edit", () => {
        closed?.();
        edit();
      }),
    );
    onClose = closed ?? null;
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    menu.style.top = `${r.bottom + h + 12 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
    menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }

  menu.onkeydown = (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      focusItem(ev.key === "ArrowDown" ? 1 : -1);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
    }
  };
  document.addEventListener("pointerdown", (ev) => {
    if (!menu.hidden && !menu.contains(ev.target as Node)) closeMenu();
  }, true);
  window.addEventListener("blur", closeMenu);

  // ---------- 編集 ----------

  const dialog = $<HTMLDialogElement>("tpl-dialog");
  const list = $("tpl-list");
  let draft: Template[] = [];

  function renderDraft() {
    list.replaceChildren(
      ...(draft.length
        ? draft.map((t, i) => {
            const row = el("div", "tpl-row");
            const name = el("input");
            name.value = t.name;
            name.placeholder = "名前";
            name.autocomplete = "off";
            name.setAttribute("aria-label", "テンプレートの名前");
            name.oninput = () => (t.name = name.value);
            const text = el("textarea");
            text.value = t.text;
            text.rows = 3;
            text.placeholder = "入力欄に入れる文章";
            text.setAttribute("aria-label", "テンプレートの文章");
            text.oninput = () => (t.text = text.value);
            const del = el("button", "text-btn tpl-del", "削除");
            del.type = "button";
            del.onclick = () => {
              draft.splice(i, 1);
              renderDraft();
            };
            row.append(name, del, text);
            return row;
          })
        : [el("p", "tpl-empty", "テンプレートがありません。「追加」で作れます。")]),
    );
  }

  function edit() {
    draft = templates.map((t) => ({ ...t }));
    renderDraft();
    dialog.showModal();
  }

  $("tpl-add").onclick = () => {
    draft.push({ name: "", text: "" });
    renderDraft();
    list.querySelector<HTMLInputElement>(".tpl-row:last-child input")?.focus();
  };
  $("tpl-cancel").onclick = () => dialog.close();
  $<HTMLFormElement>("tpl-form").onsubmit = (ev) => {
    ev.preventDefault();
    templates = draft.filter((t) => t.name.trim() || t.text.trim()).map((t) => ({ name: t.name.trim(), text: t.text }));
    save(templates);
    dialog.close();
  };

  return { pick, edit, isOpen: () => dialog.open || !menu.hidden };
}
