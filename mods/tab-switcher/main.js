// Ctrl+Tab tab switcher, like Arc's: tabs from every space in recently used order
// (shared "tab-switcher.mru", kept by my-tabs). Hold Ctrl and press Tab / Shift+Tab to
// move, release Ctrl to switch, Esc to cancel. A quick tap flips to the previous tab
// before the cards show (they fade in after DELAY ms).
// Opened by my-tabs with props { dir: 1 | -1 }; further presses while it's open arrive
// as on_key_down here, or as shared "tab-switcher.step" if the global binding wins.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, settings, spaces, panes, shared, setShared, run, hc } from "herdr";

const MAX = 5, CARD = 224, GAP = 10, PAD = 12, DELAY = 140, LINES = 6;
export const size = (n) => ({ width: Math.min(n, MAX) * (CARD + GAP) - GAP + PAD * 2, height: 226 + PAD * 2 });

// Tabs most recent first: the MRU list, then any tab it hasn't seen, in space order.
export function recentTabs() {
  const all = [];
  for (const s of spaces()) for (const tab of s.tabs ?? []) all.push({ tab, space: s });
  const byId = new Map(all.map(x => [x.tab.id, x]));
  const active = spaces().find(s => s.active)?.tabs?.find(t => t.active)?.id;
  const mru = [active, ...(shared("tab-switcher.mru") ?? [])].filter(id => id && byId.has(id));
  const order = [...new Set([...mru, ...all.map(x => x.tab.id)])];
  return order.slice(0, MAX).map(id => byId.get(id));
}

// The useful part of a screen: drop the trailing blank lines and, for agents that draw an
// input box (Claude Code, Codex), everything from the box's top rule down.
function previewLines(text) {
  let lines = text.replace(/\s+$/, "").split("\n").map(l => l.replace(/\s+$/, ""));
  const tail = Math.max(0, lines.length - 15);
  const rule = lines.findIndex((l, i) => i >= tail && /^\s*[─━]{12,}/.test(l));
  if (rule > 0) lines = lines.slice(0, rule);
  return lines.filter(l => l.trim()).slice(-LINES);
}

const ago = (ms) => { if (!ms) return ""; const s = (Date.now() - ms) / 1000; return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };

export default class TabSwitcher extends View {
  init(p, cx) {
    this.items = recentTabs();
    const dir = p?.dir === -1 ? -1 : 1;
    if (this.items.length < 2) { if (p?.overlay) closeOverlay(p.overlay); return; }
    this.sel = dir > 0 ? 1 : this.items.length - 1;
    this.visible = false; this.preview = {}; this.done = false;
    this.step0 = shared("tab-switcher.step")?.n ?? 0; this.lastKeyStep = 0;
    this.handle = cx.focus_handle(); this.handle.focus();
    setShared("tab-switcher.open", p?.overlay ?? true);
    cx.timer.after(DELAY, (cx) => { this.visible = true; cx.notify(); });
    for (const { tab } of this.items) {
      const pane = this.pane(tab.id);
      if (!pane?.terminal) continue;
      cx.spawn(async (cx) => {
        const r = await hc(["read", pane.terminal]).catch(() => null);
        if (r?.code === 0) { this.preview[tab.id] = previewLines(r.stdout); cx.notify(); }
      });
    }
  }

  async close() { setShared("tab-switcher.open", null); }

  // The pane a card describes: the tab's agent if it has one, else its focused pane.
  pane(tabId) {
    const ps = panes().filter(p => p.tab === tabId);
    return ps.find(p => p.program?.agent) ?? ps.find(p => p.focused) ?? ps[0];
  }

  move(by) { const n = this.items.length; this.sel = (this.sel + by + n) % n; }

  commit() {
    if (this.done) return;
    this.done = true;
    { const o = props()?.overlay; if (o) closeOverlay(o); }
    const it = this.items[this.sel];
    if (!it) return;
    if (!it.space.active) run("space.select", { id: it.space.id });
    run("tab.select", { id: it.tab.id });
  }

  cancel() { if (!this.done) { this.done = true; { const o = props()?.overlay; if (o) closeOverlay(o); } } }

  card(it, i, t) {
    const { tab, space } = it, pane = this.pane(tab.id), sel = i === this.sel;
    const program = pane?.program;
    // A shell's title is its prompt (user@host:path): name it by program and folder instead.
    const folder = pane?.cwd ? pane.cwd.replace(/\/+$/, "").split("/").pop() || "/" : "";
    const paneTitle = program?.shell ? [program.name, folder].filter(Boolean).join(" · ") : pane?.title || program?.name || "Terminal";
    // A named tab leads with its name; an unnamed one ("2") with what's in it, like a page title.
    const name = tab.named ? tab.name : paneTitle;
    const title = tab.named && paneTitle !== name ? paneTitle : (!tab.named && program?.name && !program.shell ? program.name : "");
    const where = [space.name, `tab ${tab.index}`, pane?.branch].filter(Boolean).join(" · ");
    const status = tab.status;
    const lines = this.preview[tab.id];
    return v_flex().id(`card-${tab.id}`).w(CARD).h_full().flex_none().p(10).gap(6).rounded(10)
      .bg(sel ? t.selected : t.raised).border(sel ? 2 : 1).border_color(sel ? t.accent : t.border)
      .cursor_pointer().hover(s => s.border_color(sel ? t.accent : t.input))
      .on_mouse_move(() => {}).on_click(() => { this.sel = i; this.commit(); })
      .child(h_flex().gap(7).items_center()
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(15).flex_none().text_color(t.muted) : image(program.icon).size(15).flex_none()))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child(name))
        .when(status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(status === "blocked" || status === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t[status]))))
      .child(div().h(32).text_size(11.5).text_color(title ? t.foreground : t.dim).overflow_hidden().child(title || (status ? `${status} ${ago(tab.changed_at)}`.trim() : "")))
      .child(div().text_size(10.5).text_color(t.dim).truncate().child(where || " "))
      .child(v_flex().flex_1().min_h(0).p(7).rounded(6).bg(t.background).border(1).border_color(t.border).overflow_hidden()
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(9.5).text_color(t.muted)
        .children((lines ?? []).map((l, j) => div().id(`l-${tab.id}-${j}`).h(14).flex_none().truncate().child(l)))
        .when(!lines, el => el.child(div().text_color(t.dim).child(pane?.terminal ? "…" : "no terminal"))));
  }

  render(cx) {
    if (!this.items || this.items.length < 2) return div();
    // A press the global binding caught (my-tabs bumped the counter).
    const step = shared("tab-switcher.step");
    if (step && step.n > this.step0) {
      this.step0 = step.n;
      if (Date.now() - this.lastKeyStep > 40) this.move(step.dir);
    }
    const t = theme();
    return v_flex().id("tab-switcher").track_focus(this.handle).size_full().p(PAD).gap(8)
      .rounded(14).bg(t.popover).border(1).border_color(t.border).shadow_lg().text_color(t.foreground)
      .opacity(this.visible ? 1 : 0).transition("opacity", { duration: 90, easing: "ease-out" })
      .on_modifiers_changed((e, cx) => { if (!e.modifiers.control) this.commit(); cx.notify(); })
      .on_key_up((e, cx) => { if (e.modifiers && !e.modifiers.control) this.commit(); cx.notify(); })
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "tab") { this.lastKeyStep = Date.now(); this.move(e.modifiers?.shift ? -1 : 1); }
        else if (k === "right") this.move(1);
        else if (k === "left") this.move(-1);
        else if (k === "enter") this.commit();
        else if (k === "escape") this.cancel();
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(226).gap(GAP).children(this.items.map((it, i) => this.card(it, i, t))));
  }
}
