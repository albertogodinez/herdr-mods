import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, panes, exec, hc, home, appHome, theme, watchFolder } from "herdr";

// The focused terminal, else the focused pane's, else the agent an agent block shows.
const current = () => { const f = focused(); return f?.shown ?? f?.terminal ?? (f?.pane ? panes().find(p => p.pane === f.pane)?.terminal : null) ?? f?.agent ?? null; };

// Skills the focused Claude Code session has loaded, newest first.
// Data: focused terminal -> its foreground pid (hc get) -> ~/.claude/sessions/<pid>.json
// -> the transcript, read incrementally by scan.py.

// Fixed times, not "5m ago": a fixed label never goes stale, so nothing redraws on a timer.
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const clock = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const today = (d) => new Date(d).toDateString() === new Date().toDateString();
// The list's column: 13:42 today, then Tue for the last week, then Nov 2.
const when = (ts) => {
  const d = new Date(ts);
  if (today(d)) return clock(ts);
  return Date.now() - d < 6 * 86400000 ? DAY[d.getDay()] : `${MON[d.getMonth()]} ${d.getDate()}`;
};
// An expanded use: 13:42 today, else Tue 13:42.
const stamp = (ts) => today(ts) ? clock(ts) : `${when(ts)} ${clock(ts)}`;

function source(folder) {
  if (!folder) return "";
  if (folder.includes("/plugins/")) return "plugin";
  if (folder.startsWith(`${home()}/.claude/skills`) || folder.startsWith(`${home()}/.agents/skills`)) return "user";
  return "project";
}

const HOW = { typed: "typed /command", agent: "agent called", path: "used by path" };

export default class Skills extends View {
  init(_props, cx) {
    this.reset(); this.terminal = null; this.open = new Set(); this.watching = new Set();
    this.refresh(cx);
    // No polling and no timer: a rescan runs when Claude Code writes this session's transcript
    // or session file (watchFolder), or when focus or the pane's program changes (render).
  }

  async close() { this.done = true; }

  // One loop per folder for the panel's life; each batch is checked against the session shown now.
  watch(dir, cx) {
    if (!dir || this.watching.has(dir)) return;
    this.watching.add(dir);
    cx.spawn(async (cx) => {
      try {
        while (!this.done) {
          const changed = await watchFolder(dir);
          if (this.done) return;
          if (changed.some(p => p === dir || this.wants(p))) this.refresh(cx);
        }
      } catch { /* folder gone: the next refresh watches again */ } finally { this.watching.delete(dir); }
    });
  }

  wants(p) {
    const tr = this.transcript;
    if (tr && (p === tr || p.startsWith(tr.slice(0, -6) + "/"))) return true; // transcript or its subagents/
    if (this.info) return p === this.info;                                    // /clear, resume
    return Boolean(this.pid) && p.includes("/.claude/sessions/");            // session file not written yet
  }

  program() { return panes().find(p => p.terminal === this.terminal)?.program?.key ?? null; }

  reset() { this.transcript = null; this.info = null; this.session = null; this.name = null; this.offsets = {}; this.events = []; this.skills = []; this.note = null; }

  refresh(cx) {
    // Clicking this panel doesn't move terminal focus, but keep the last one if it goes null.
    const t = current() ?? this.terminal;
    if (t !== this.terminal) { this.terminal = t; this.pid = null; this.reset(); }
    if (!t) { this.note = "Focus a Claude Code pane"; cx.notify(); return; }
    if (this.loading) { this.again = true; return; }
    if (t.includes("/")) { this.note = "Remote terminals aren't tracked yet"; cx.notify(); return; }
    this.loading = true; this.again = false; this.prog = this.program();
    cx.spawn(async (cx) => {
      try {
        const g = await hc(["get", t, "--json"]);
        const fg = g.code === 0 ? JSON.parse(g.stdout).foreground : null;
        if (t !== this.terminal) return;
        if (g.code !== 0) throw new Error(g.stderr.trim() || `hc get ${t} failed`);
        const isClaude = fg && (fg.argv ?? []).some(a => /(^|\/)claude$/.test(a));
        if (!isClaude) { if (this.pid) this.reset(); this.pid = null; this.note = "No Claude Code session in this pane"; return; }
        if (fg.pid !== this.pid) { this.reset(); this.pid = fg.pid; }
        const scan = async (offsets) => {
          const r = await exec("python3", ["-I", `${appHome()}/mods/skills/scan.py`, String(fg.pid), JSON.stringify(offsets)]);
          if (r.code !== 0) throw new Error(r.stderr.trim() || "scan failed");
          return JSON.parse(r.stdout);
        };
        let out = await scan(this.offsets);
        // A new session id under the same process (/clear, resume): read it from the top.
        if (out.session && this.session && out.session !== this.session) { const pid = this.pid; this.reset(); this.pid = pid; out = await scan({}); }
        if (t !== this.terminal || fg.pid !== this.pid) return;
        if (!out.session) { this.note = "Session file not found yet"; return; }
        this.session = out.session; this.name = out.name; this.offsets = out.offsets; this.note = null;
        this.transcript = out.transcript; this.info = out.info;
        this.watch(out.transcript?.replace(/\/[^/]+$/, ""), cx);
        if (out.events.length) { this.events.push(...out.events); this.build(); }
      } catch (e) { this.note = `Can't read skills: ${e}`; }
      finally {
        this.loading = false; cx.notify();
        if (this.pid) this.watch(`${home()}/.claude/sessions`, cx);
        if (this.again && !this.done) this.refresh(cx);
      }
    });
  }

  build() {
    const calls = {}; let slash = null;
    const by = new Map();
    for (const e of this.events) {
      if (e.kind === "call") { calls[e.id] = e; continue; }
      if (e.kind === "path") {
        // One use per sub-agent and skill, however many of its files that agent touched.
        const s = by.get(e.skill) ?? { name: e.skill, folder: e.folder, source: source(e.folder), uses: [] };
        const u = s.uses.find(u => u.agent === e.agent);
        if (u) { u.n++; u.ts = e.ts > u.ts ? e.ts : u.ts; if (!u.tools.includes(e.tool)) u.tools.push(e.tool); }
        else s.uses.push({ ts: e.ts, args: "", how: "path", sub: e.sub, agent: e.agent, n: 1, tools: [e.tool] });
        by.set(e.skill, s); continue;
      }
      if (e.kind === "slash") { slash = e; continue; }
      const call = e.id ? calls[e.id] : null;
      const typed = !call && slash && slash.skill.split(":").pop() === e.skill ? slash : null;
      const name = call?.skill ?? typed?.skill ?? e.skill;
      if (!call) slash = null;
      const s = by.get(name) ?? { name, folder: e.folder, source: source(e.folder), uses: [] };
      s.uses.push({ ts: e.ts, args: call?.args ?? typed?.args ?? "", how: call ? "agent" : "typed", sub: e.sub });
      by.set(name, s);
    }
    for (const s of by.values()) s.uses.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    this.skills = [...by.values()].sort((a, b) => Date.parse(b.uses.at(-1).ts) - Date.parse(a.uses.at(-1).ts));
  }

  toggle(name, cx) { if (this.open.has(name)) this.open.delete(name); else this.open.add(name); cx.notify(); }

  row(s, t) {
    const last = s.uses.at(-1), open = this.open.has(s.name);
    const tag = (text, color) => div().px(5).py(0.5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(color).child(text);
    return v_flex().flex_none()
      .child(h_flex().id(`skill-${s.name}`).h(30).px(8).gap(8).items_center().rounded(7).cursor_pointer().when(open, e => e.bg(t.selected)).hover(x => x.bg(t.hover))
        .on_click((_e, cx) => this.toggle(s.name, cx))
        .child(svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().child(s.name))
        .when(Boolean(s.source), e => e.child(tag(s.source, s.source === "project" ? t.accent : t.muted)))
        .when(s.uses.length > 1, e => e.child(div().text_size(11).text_color(t.muted).child(`×${s.uses.length}`)))
        .child(div().w(40).flex_none().text_right().text_size(11).text_color(t.dim).child(when(last.ts))))
      .when(open, e => e.child(v_flex().pl(28).pr(8).pb(6).gap(4).children([...s.uses].reverse().map((u, i) =>
        v_flex().id(`use-${s.name}-${i}`).gap(1).p(6).rounded(6).bg(t.raised)
          .child(h_flex().gap(6).text_size(10.5).text_color(t.dim).child(stamp(u.ts)).child(HOW[u.how] ?? "agent called").when(u.sub, x => x.child(div().text_color(t.blocked).child("sub-agent"))))
          .when(typeof u.sub === "string", x => x.child(div().text_size(11).text_color(t.muted).truncate().child(u.sub)))
          .child(div().text_size(11.5).text_color(u.args || u.how === "path" ? t.foreground : t.dim).child(u.how === "path"
            ? `${u.tools.map(x => x === "Bash" ? "ran its scripts" : "read its files").join(", ")} · ${u.n} call${u.n > 1 ? "s" : ""}`
            : u.args ? (u.args.length > 400 ? u.args.slice(0, 400) + "…" : u.args) : "no arguments"))))));
  }

  render(cx) {
    // Focus moved, or the pane started or quit Claude Code.
    if ((current() ?? this.terminal) !== this.terminal || (this.terminal && this.program() !== this.prog)) this.refresh(cx);
    const t = theme(), uses = this.skills.reduce((n, s) => n + s.uses.length, 0);
    return v_flex().id("skills").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Skills"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.skills.length} skills`))
        .child(div().flex_1())
        .when(uses > 0, e => e.child(div().text_size(11).text_color(t.dim).child(`${uses} loads`))))
      .when(Boolean(this.name), e => e.child(div().px(14).py(6).flex_none().text_size(11).text_color(t.dim).truncate().border_b(1).border_color(t.border).child(`session ${this.name} · ${this.session?.slice(0, 8)}`)))
      .child(v_flex().id("skills-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .children(this.skills.map(s => this.row(s, t)))
        .when(!this.skills.length, e => e.child(div().p(8).text_color(t.dim).child(this.note ?? (this.loading || !this.session ? "Loading…" : "No skills used in this session yet")))));
  }
}
