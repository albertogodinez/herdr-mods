// Keep identical in my-tabs and my-agents: Herdr restricts imports to each mod folder.
export function tabName(tab, allPanes, labelsOf) {
  if (tab.named) return tab.name;
  const mine = allPanes.filter(p => p.tab === tab.id && p.terminal);
  const lead = mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
  for (const p of lead ? [lead, ...mine.filter(p => p !== lead)] : []) {
    const what = String(labelsOf.get(p.terminal)?.['agent.what'] ?? '').trim();
    if (what) return what;
  }
  const program = lead?.program;
  const raw = lead?.title ?? '';
  const live = raw.replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, '').replace(/^\[ [!.] \] /, '').trim();
  const path = /^[~/]|^[A-Za-z]:\\/.test(raw.replace(/^[^\p{L}\p{N}~/]+/u, ''));
  if (live && !path && !live.includes('@') && live !== lead?.terminal && live !== program?.name && live.toLowerCase() !== program?.key) return live;
  return /^(?:tb)?\d+$/.test(tab.name) ? program?.name ?? 'Terminal' : tab.name;
}
