// Right-click menu for the tab bar's panel buttons (Files, Skills, Changes), like a
// browser toolbar's: "Remove <panel>" for the one clicked, then every panel with a
// check mark to show or hide it. Opened by my-tabs as a popup with props { panel?: id }.
// Hidden ids live in shared "my-tabs.panelHidden"; my-tabs reads it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared, run, layout } from "herdr";

const PANELS = { files: ["Files", "mods/files/file.svg"], skills: ["Skills", "mods/skills/skills.svg"], changes: ["Changes", "mods/changes/changes.svg"] };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

function hide(id, hidden) {
  setShared("my-tabs.panelHidden", [...hidden, id]);
  // Its panel shouldn't stay open with no button to close it.
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  if (panel && !panel.hidden && body?.active === id) run("layout.hide", { id: "panel" });
}

function items() {
  const hidden = (shared("my-tabs.panelHidden") ?? []).filter(id => id in PANELS), clicked = props()?.panel;
  const order = [...new Set([...(shared("my-tabs.panelOrder") ?? []).filter(id => id in PANELS), ...Object.keys(PANELS)])];
  const out = [];
  if (clicked in PANELS && !hidden.includes(clicked))
    out.push({ label: `Remove ${PANELS[clicked][0]}`, icon: "mods/pane/close.svg", act: () => hide(clicked, hidden) });
  for (const id of order) {
    const shown = !hidden.includes(id);
    out.push({ label: PANELS[id][0], icon: PANELS[id][1], check: shown, line: out.length > 0 && id === order[0],
      act: () => shown ? hide(id, hidden) : setShared("my-tabs.panelHidden", hidden.filter(x => x !== id)) });
  }
  return out;
}

export default class PanelMenu extends View {
  init(_props, cx) {
    // Nothing is highlighted until the keyboard moves, as in the other menus' hover look.
    this.at = -1; this.handle = cx.focus_handle(); this.handle.focus();
  }

  choose(i) {
    const it = items()[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    it.act();
  }

  render(cx) {
    const t = theme(), list = items();
    return v_flex().id("panel-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => v_flex()
        .when(Boolean(it.line), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`pm-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(i === this.at, el => el.bg(t.selected))
          .hover(s => s.bg(t.hover))
          .on_click(() => this.choose(i))
          .child(svg(it.icon).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().child(it.label))
          .when(it.check !== undefined, el => el.child(div().w(14).flex_none().when(it.check, x => x.child(svg("mods/workspace-chrome/check.svg").size(14).text_color(t.accent))))))));
  }
}
