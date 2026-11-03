import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Where a panel menu opens: clear of the pointer, just under what was clicked (the bar or a
// button), like the terminal's menu. Event coordinates are window coordinates, as `at` is.
const menuAt = (e) => e.bounds ? { x: e.position.x + 2, y: e.bounds.y + e.bounds.height + 6 } : "pointer";

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  dragMove(e, cx) {
    const d = this.drag;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.position.x - d.startX) < 4) return;
      d.active = true;
    }
    const order = this.panelOrder, widths = this.widths, w = widths[d.id], others = order.filter(id => id !== d.id);
    const total = order.reduce((n, id) => n + widths[id], 0) + 3 * (order.length - 1);
    d.ghostLeft = Math.max(0, Math.min(total - w, d.startLeft + (e.position.x - d.startX) / d.scale));
    // The slot whose center is nearest the ghost's center.
    const center = d.ghostLeft + w / 2;
    let best = 0, bestDist = Infinity;
    for (let k = 0; k <= others.length; k++) {
      const left = others.slice(0, k).reduce((n, id) => n + widths[id] + 3, 0);
      const dist = Math.abs(left + w / 2 - center);
      if (dist < bestDist) { bestDist = dist; best = k; }
    }
    d.preview = [...others.slice(0, best), d.id, ...others.slice(best)];
    cx.notify();
  }

  // Release: a drag drops where its slot is; a press that never moved is a click.
  // Leaving the tab bar mid-drag drops it there too, so nothing is left hanging.
  dragEnd(released, cx) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.active) setShared("my-tabs.panelOrder", d.preview);
    else if (released) {
      const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
      if (panel && !panel.hidden && body?.active === d.id) run("layout.hide", { id: "panel" });
      else { run("layout.select", { stack: "panel-body", child: d.id }); run("layout.show", { id: "panel" }); }
    }
    cx.notify();
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const hiddenPanels = shared("my-tabs.panelHidden") ?? [];
    const enabled = [...new Set([...(shared("workspace.panels") ?? ["files", "changes"]), "skills"])].filter(id => !hiddenPanels.includes(id));
    this.syncPanel(space, panel, body, enabled);
    // Panel buttons. Click toggles a panel. Drag one (Firefox toolbar style): it follows the
    // pointer as a ghost, a dashed slot shows where it lands, and the others slide aside.
    const PANELS = { files: ["Files", "mods/files/file.svg"], skills: ["Skills", "mods/skills/skills.svg"], changes: ["Changes", "mods/changes/changes.svg"] };
    const GAP = 3, SLIDE = { duration: 140, easing: "ease-out" };
    const saved = (shared("my-tabs.panelOrder") ?? []).filter(id => id in PANELS);
    const order = [...new Set([...saved, ...Object.keys(PANELS)])].filter(id => enabled.includes(id));
    this.panelOrder = order;
    const widths = this.widths ??= {};
    const measured = order.every(id => widths[id] > 0);
    const lefts = (ids) => { const out = {}; let x = 0; for (const id of ids) { out[id] = x; x += widths[id] + GAP; } return out; };
    const total = order.reduce((n, id) => n + (widths[id] ?? 0), 0) + GAP * Math.max(0, order.length - 1);
    const drag = this.drag?.active ? this.drag : null;
    const shownOrder = drag ? drag.preview : order;
    const at = lefts(shownOrder);
    const face = (id, on) => {
      const [label, icon] = PANELS[id];
      return h_flex().h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).border(1).border_color(on ? t.selected : t.chrome)
        .child(svg(icon).size(14)).child(label);
    };
    const panelButton = (id) => {
      const on = panel && !panel.hidden && body?.active === id;
      const slot = drag?.id === id;
      let el = slot
        ? h_flex().h(26).rounded(6).border(1).border_dashed().border_color(t.accent).bg(t.hover).w(widths[id])
        : face(id, on).hover(s => s.bg(t.hover));
      el = el.id(`panel-${id}`).flex_none()
        .on_size_change((size, cx) => { const w = size.width / (settings().zoom || 1); if (!slot && Math.abs((widths[id] ?? 0) - w) > 0.5) { widths[id] = w; cx.notify(); } })
        .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); openOverlay({ mod: "panel-menu", kind: "popup", width: 200, at: menuAt(e), props: { panel: id } }); })
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          // Pointer units can differ from layout units (app zoom): the pressed button's event
          // width against its measured width gives the ratio.
          const scale = e.bounds?.width && widths[id] ? e.bounds.width / widths[id] : 1;
          this.drag = { id, scale, startX: e.position.x, startLeft: lefts(this.panelOrder)[id] ?? 0, active: false };
        });
      return measured ? el.absolute().top(0).left(at[id]).transition("left", SLIDE) : el;
    };
    const ghost = drag && measured
      ? face(drag.id, false).id("panel-ghost").absolute().top(0).left(drag.ghostLeft).opacity(0.85).bg(t.raised).border_color(t.input).shadow_md().cursor_grabbing()
      : null;
    const panelGroup = h_flex().id("panel-group").flex_none().items_center().gap(GAP)
      .when(measured, el => el.relative().w(total).h(26))
      .children(order.map(panelButton))
      .when(Boolean(ghost), el => el.child(ghost));
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_down("right", (e) => { openOverlay({ mod: "panel-menu", kind: "popup", width: 200, at: menuAt(e), props: {} }); })
      .on_mouse_move((e, cx) => this.dragMove(e, cx))
      .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.dragEnd(true, cx); })
      .on_hover((hovered, cx) => { if (!hovered) this.dragEnd(false, cx); })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .child(panelGroup)
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/my-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/my-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/my-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
