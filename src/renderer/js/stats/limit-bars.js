// ── Mini Limit Bars — Icon rail usage indicators ──────────

export function updateLimitBar(id, percent) {
  const bar = document.getElementById(id);
  if (!bar) return;

  const fill = bar.querySelector('.mini-fill');
  if (!fill) return;

  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  fill.className = 'mini-fill';

  if (percent > 85) fill.classList.add('critical');
  else if (percent > 60) fill.classList.add('warning');
}
