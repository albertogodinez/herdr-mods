// Ctrl+Tab tab switcher, like Arc's: tabs from every space in recently used order
// (shared "tab-switcher.mru", kept by my-tabs). Hold Ctrl and press Tab / Shift+Tab to
// move, release Ctrl to switch, Esc to cancel. A quick tap flips to the previous tab
// before the cards show (they fade in after DELAY ms).
// Opened by my-tabs with props { dir: 1 | -1 }; further presses while it's open arrive
// as on_key_down here, or as shared "tab-switcher.step" if the global binding wins.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, spaces, panes, terminals, shared, setShared, run, hc, exec, appHome, watchFolder } from "herdr";

const MAX = 5, CARD = 224, GAP = 10, PAD = 12, DELAY = 140, TRAIL = 6;
// Shells have no file to watch: their screens are re-read every SHELL_POLL ms while open.
// Agent tabs update when their transcript changes, with a slow FALLBACK poll.
const SHELL_POLL = 1000, FALLBACK = 5000;
// Which card body: "trail" (the last TRAIL tool calls / shell commands) or "activity"
// (the live status line and last tool). shared "tab-switcher.design" overrides it.
const DESIGN = "trail";
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

// A shell's last command, from its screen: the last prompt line with something typed after
// it (oh-my-zsh's "➜  folder git:(branch) ✗ cmd"; a "$ " or "% " prompt works too).
function lastCommand(text) { return lastCommands(text, 1)[0] ?? ""; }

// The last n commands typed at a shell prompt, oldest first.
function lastCommands(text, n) {
  const lines = text.replace(/\s+$/, "").split("\n"), out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    let l = lines[i];
    if (/^\s*➜\s/.test(l)) l = l.replace(/^\s*➜\s+\S+/, "").replace(/^\s+git:\([^)]*\)/, "").replace(/^\s+✗/, "");
    else if (/^\S*[$%#]\s/.test(l)) l = l.replace(/^\S*[$%#]/, "");
    else continue;
    if (l.trim()) out.unshift(l.trim());
  }
  return out;
}

const ago = (ms) => { if (!ms) return ""; const s = (Date.now() - ms) / 1000; return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };

export default class TabSwitcher extends View {
  init(p, cx) {
    this.items = recentTabs();
    const dir = p?.dir === -1 ? -1 : 1;
    if (this.items.length < 2) { if (p?.overlay) closeOverlay(p.overlay); return; }
    this.sel = dir > 0 ? 1 : this.items.length - 1;
    this.visible = false; this.info = {}; this.done = false;
    this.step0 = shared("tab-switcher.step")?.n ?? 0; this.lastKeyStep = 0;
    this.handle = cx.focus_handle(); this.handle.focus();
    setShared("tab-switcher.open", p?.overlay ?? true);
    cx.timer.after(DELAY, (cx) => { this.visible = true; cx.notify(); });
    // Live while open. Herdr redraws on its own when a status changes. A Claude tab's trail
    // comes from its transcript, watched for changes (watchFolder); a shell's from its screen.
    this.busy = {}; this.again = {}; this.paths = {}; this.watching = new Set();
    this.refresh(this.items.map(x => x.tab.id), cx);
    cx.timer.every(SHELL_POLL, (cx) => this.refresh(this.items.filter(x => this.pane(x.tab.id)?.program?.shell).map(x => x.tab.id), cx));
    cx.timer.every(FALLBACK, (cx) => this.refresh(this.items.map(x => x.tab.id), cx));
  }

  // Re-read these tabs' cards; a tab already being read is read again once it finishes.
  refresh(ids, cx) {
    for (const id of ids) {
      if (this.done) return;
      if (this.busy[id]) { this.again[id] = true; continue; }
      this.busy[id] = true;
      cx.spawn(async (cx) => {
        try { do { this.again[id] = false; await this.load(id, cx); } while (this.again[id] && !this.done); }
        finally { this.busy[id] = false; cx.notify(); }
      });
    }
  }

  async load(id, cx) {
    const pane = this.pane(id);
    if (!pane?.terminal) return;
    const info = this.info[id] ??= {};
    if (pane.program?.shell) {
      const r = await hc(["read", pane.terminal]).catch(() => null);
      if (r?.code === 0) { info.cmds = lastCommands(r.stdout, TRAIL); info.cmd = info.cmds.at(-1) ?? ""; }
      return;
    }
    const g = await hc(["get", pane.terminal, "--json"]).catch(() => null);
    if (g?.code !== 0) return;
    const d = JSON.parse(g.stdout);
    info.msg = d.status?.msg || null;
    const fg = d.foreground;
    if (!fg || !/(^|\/)claude$/.test(fg.argv?.[0] ?? "")) return;
    const r = await exec("python3", ["-I", `${appHome()}/mods/tab-switcher/lasttool.py`, String(fg.pid), String(TRAIL)]).catch(() => null);
    if (r?.code !== 0) return;
    const out = JSON.parse(r.stdout || "{}");
    info.tools = out.tools ?? []; info.tool = info.tools.at(-1) ?? null;
    if (out.path) { this.paths[id] = out.path; this.watch(out.path.slice(0, out.path.lastIndexOf("/")), cx); }
  }

  // One watch per project folder; a change to a tab's transcript re-reads just that card.
  watch(dir, cx) {
    if (this.watching.has(dir)) return;
    this.watching.add(dir);
    cx.spawn(async (cx) => {
      try {
        while (!this.done) {
          const changed = await watchFolder(dir);
          if (this.done) return;
          const all = changed.includes(dir);
          const ids = Object.keys(this.paths).filter(id => all || changed.includes(this.paths[id]));
          if (ids.length) this.refresh(ids, cx);
        }
      } catch { this.watching.delete(dir); }
    });
  }

  async close() { this.done = true; setShared("tab-switcher.open", null); }

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
    const where = [space.name, pane?.branch].filter(Boolean).join(" · ");
    const status = tab.status, info = this.info[tab.id] ?? {}, shell = Boolean(program?.shell);
    // The agent's live report, else the last one polled.
    const report = terminals().find(x => x.address === pane?.terminal)?.report;
    const msg = (typeof report === "object" && report?.msg) || info.msg;
    const label = shell ? "LAST COMMAND"
      : status === "working" ? `WORKING · ${ago(tab.working_since)}`
      : status === "blocked" ? "NEEDS YOU"
      : status === "done" ? `DONE · ${ago(tab.changed_at)}`
      : "IDLE";
    const doing = shell ? (info.cmd ? `$ ${info.cmd}` : info.cmd === "" ? "Nothing run yet" : "")
      : msg || (status === "working" ? "Working…" : status === "blocked" ? "Waiting for your answer" : "Waiting for you");
    return v_flex().id(`card-${tab.id}`).w(CARD).h_full().flex_none().p(10).gap(6).rounded(10)
      .bg(sel ? t.selected : t.raised).border(sel ? 2 : 1).border_color(sel ? t.accent : t.border)
      .cursor_pointer().hover(s => s.border_color(sel ? t.accent : t.input))
      .on_click(() => { this.sel = i; this.commit(); })
      .child(h_flex().gap(7).items_center()
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(15).flex_none().text_color(t.muted) : image(program.icon).size(15).flex_none()))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child(name))
        .when(status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(status === "blocked" || status === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t[status]))))
      .child(div().text_size(10.5).text_color(t.dim).truncate().child(where || " "))
      .child((shared("tab-switcher.design") ?? DESIGN) === "trail" ? this.trail(info, shell, t, status === "working") : v_flex().flex_1().min_h(0).justify_center().gap(8)
        .child(div().text_size(9.5).font_semibold().text_color(status === "blocked" ? t.blocked : t.dim).child(label))
        .child(div().h(60).overflow_hidden().text_size(15).font_medium().line_height("19.5px").child(doing))
        .when(Boolean(info.tool), el => el.child(div().h(30).overflow_hidden().text_size(11).line_height("15px").text_color(t.muted)
          .child(`${info.tool.verb} ${info.tool.detail}`.trim()))));
  }

  // A timeline, newest at the bottom: what the agent did (Ran …, Edited …) or the commands
  // typed in a shell. The newest step has an accent dot; a line joins the dots.
  trail(info, shell, t, running) {
    const steps = shell ? (info.cmds ?? []).map(c => ({ verb: "$", detail: c })) : (info.tools ?? []);
    if (!steps.length) return v_flex().flex_1().min_h(0).justify_center().child(div().text_size(11).text_color(t.dim)
      .child(info.cmds || info.tools ? (shell ? "No commands yet" : "No tool calls yet") : "…"));
    return v_flex().flex_1().min_h(0).relative().overflow_hidden().pl(14).gap(5).justify_end()
      .child(div().absolute().left(3).top(4).bottom(6).w(1).bg(t.border))
      .children(steps.map((x, j) => {
        // The newest step is "in progress" only while the agent is working: its accent dot
        // breathes (a native loop, no timer); the text stays still.
        const last = j === steps.length - 1, live = last && running;
        // Older steps stay on one line so six always fit; the newest may take two.
        // The dot sits outside the text box, which clips.
        return div().relative().flex_none()
          .child(div().absolute().left(-14).top(3).size(7).rounded(4).bg(live ? t.accent : last ? t.dim : t.input)
            .when(live, el => el.loop("opacity", { from: 0.3, to: 1, period: 1600 })))
          .child(div().text_size(10.5).line_height("13.5px").text_color(last ? t.foreground : t.muted)
            .when(last, el => el.max_h(27).overflow_hidden()).when(!last, el => el.truncate())
            .child(`${x.verb} ${x.detail}`.trim()));
      }));
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
