import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, panes, exec, hc, home, appHome, theme } from "herdr";

// The focused terminal, else the focused pane's, else the agent an agent block shows.
const current = () => { const f = focused(); return f?.shown ?? f?.terminal ?? (f?.pane ? panes().find(p => p.pane === f.pane)?.terminal : null) ?? f?.agent ?? null; };

// Skills the focused Claude Code session has loaded, newest first.
// Data: focused terminal -> its foreground pid (hc get) -> ~/.claude/sessions/<pid>.json
// -> the transcript, read incrementally by scan.py.

const ago = (ts) => {
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const clock = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

function source(folder) {
  if (!folder) return "";
  if (folder.includes("/plugins/")) return "plugin";
  if (folder.startsWith(`${home()}/.claude/skills`) || folder.startsWith(`${home()}/.agents/skills`)) return "user";
  return "project";
}

// Claude Code's agent switcher at the bottom of its screen: "⏺ main", then one row per
// sub-agent, "◯ general-purpose  <activity>   54m 39s · ↓ 140.3k tokens". ⏺ marks the
// agent whose view is open. Returns {type, secs} when that is a sub-agent, else null.
function shownAgent(screen) {
  const lines = screen.split("\n"); let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  const rows = [];
  for (; i >= 0; i--) {
    const r = lines[i].match(/^\s*(?:❯\s+)?([⏺◯●○])\s+(\S+)(.*)$/);
    if (!r) break;
    rows.unshift(r);
    if (r[2] === "main" && !r[3].trim()) break;
  }
  if (rows.length < 2 || rows[0][2] !== "main") return null;
  const on = rows.slice(1).find(r => r[1] === "⏺" || r[1] === "●");
  if (!on) return null;
  const e = on[3].match(/(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s\s*·/);
  return { type: on[2], secs: e ? (+(e[1] ?? 0)) * 3600 + (+(e[2] ?? 0)) * 60 + +e[3] : null };
}

// The sub-agent transcript the switcher row names: same type, started elapsed-time ago.
function matchAgent(view, agents) {
  if (!view) return null;
  const now = Date.now();
  let best = null, gap = Infinity;
  for (const [id, a] of Object.entries(agents ?? {})) {
    if (a.type !== view.type || !a.start) continue;
    const g = view.secs == null ? now - Date.parse(a.start) : Math.abs(now - view.secs * 1000 - Date.parse(a.start));
    if (g < gap) { gap = g; best = id; }
  }
  return view.secs == null || gap < 120000 ? best : null;
}

const HOW = { typed: "typed /command", agent: "agent called", path: "used by path" };

export default class Skills extends View {
  init(_props, cx) {
    this.reset(); this.terminal = null; this.open = new Set();
    this.refresh(cx);
    cx.timer.every(4000, (cx) => this.refresh(cx));
  }

  reset() { this.view = null; this.agents = {}; this.session = null; this.name = null; this.offsets = {}; this.events = []; this.skills = []; this.note = null; }

  refresh(cx) {
    // Clicking this panel doesn't move terminal focus, but keep the last one if it goes null.
    const t = current() ?? this.terminal;
    if (t !== this.terminal) { this.terminal = t; this.pid = null; this.reset(); }
    if (!t) { this.note = "Focus a Claude Code pane"; cx.notify(); return; }
    if (this.loading) return;
    if (t.includes("/")) { this.note = "Remote terminals aren't tracked yet"; cx.notify(); return; }
    this.loading = true;
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
        this.session = out.session; this.name = out.name; this.offsets = out.offsets; this.note = null; this.agents = out.agents ?? {};
        const screen = await hc(["read", t]);
        if (t !== this.terminal) return;
        const view = screen.code === 0 ? matchAgent(shownAgent(screen.stdout), this.agents) : null;
        if (out.events.length || view !== this.view) { this.events.push(...out.events); this.view = view; this.build(); }
      } catch (e) { this.note = `Can't read skills: ${e}`; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  build() {
    const calls = {}; let slash = null;
    const by = new Map();
    for (const e of this.view ? this.events.filter(e => e.agent === this.view) : this.events) {
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
        .child(div().w(30).flex_none().text_right().text_size(11).text_color(t.dim).child(ago(last.ts))))
      .when(open, e => e.child(v_flex().pl(28).pr(8).pb(6).gap(4).children([...s.uses].reverse().map((u, i) =>
        v_flex().id(`use-${s.name}-${i}`).gap(1).p(6).rounded(6).bg(t.raised)
          .child(h_flex().gap(6).text_size(10.5).text_color(t.dim).child(clock(u.ts)).child(HOW[u.how] ?? "agent called").when(u.sub, x => x.child(div().text_color(t.blocked).child("sub-agent"))))
          .when(typeof u.sub === "string", x => x.child(div().text_size(11).text_color(t.muted).truncate().child(u.sub)))
          .child(div().text_size(11.5).text_color(u.args || u.how === "path" ? t.foreground : t.dim).child(u.how === "path"
            ? `${u.tools.map(x => x === "Bash" ? "ran its scripts" : "read its files").join(", ")} · ${u.n} call${u.n > 1 ? "s" : ""}`
            : u.args ? (u.args.length > 400 ? u.args.slice(0, 400) + "…" : u.args) : "no arguments"))))));
  }

  render(cx) {
    if ((current() ?? this.terminal) !== this.terminal) this.refresh(cx);
    const t = theme(), uses = this.skills.reduce((n, s) => n + s.uses.length, 0);
    return v_flex().id("skills").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Skills"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.skills.length} skills`))
        .child(div().flex_1())
        .when(uses > 0, e => e.child(div().text_size(11).text_color(t.dim).child(`${uses} loads`))))
      .when(Boolean(this.view), e => e.child(h_flex().px(14).py(6).gap(6).flex_none().text_size(11).border_b(1).border_color(t.border)
        .child(div().text_color(t.accent).flex_none().child("Sub-agent"))
        .child(div().text_color(t.muted).truncate().child(this.agents[this.view]?.description ?? this.view))))
      .when(Boolean(this.name), e => e.child(div().px(14).py(6).flex_none().text_size(11).text_color(t.dim).truncate().border_b(1).border_color(t.border).child(`session ${this.name} · ${this.session?.slice(0, 8)}`)))
      .child(v_flex().id("skills-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .children(this.skills.map(s => this.row(s, t)))
        .when(!this.skills.length, e => e.child(div().p(8).text_color(t.dim).child(this.note ?? (this.loading || !this.session ? "Loading…" : this.view ? "This sub-agent hasn't used a skill yet" : "No skills used in this session yet")))));
  }
}
