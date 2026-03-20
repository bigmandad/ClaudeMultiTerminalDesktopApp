// ── Metric Chart — renders SVG sparkline of experiment metrics ──

export function renderMetricChart(timeline) {
  if (!timeline || timeline.length < 2) {
    return '<div class="ar-chart-empty">Need 2+ experiments for chart</div>';
  }

  const W = 320;
  const H = 80;
  const PAD = 4;

  const values = timeline.map(e => e.metric_value ?? 0);
  const statuses = timeline.map(e => e.status);
  const minVal = Math.min(...values) * 0.95;
  const maxVal = Math.max(...values) * 1.05 || 1;
  const range = maxVal - minVal || 1;

  const points = values.map((v, i) => {
    const x = PAD + (i / (values.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((v - minVal) / range) * (H - PAD * 2);
    return { x, y, status: statuses[i], value: v };
  });

  // Build SVG path
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  // Dots colored by status
  const dots = points.map(p => {
    const color = p.status === 'keep' ? '#6ec76e' : p.status === 'crash' ? '#cc4444' : '#888';
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${color}" />`;
  }).join('');

  // Best value line (only if any "keep" experiments exist)
  const keepValues = values.filter((v, i) => statuses[i] === 'keep');
  let bestLine = '';
  if (keepValues.length > 0) {
    const bestVal = Math.max(...keepValues);
    const bestY = H - PAD - ((bestVal - minVal) / range) * (H - PAD * 2);
    bestLine = `
      <line x1="${PAD}" y1="${bestY.toFixed(1)}" x2="${W - PAD}" y2="${bestY.toFixed(1)}"
            stroke="#6ec76e" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.5"/>
      <text x="${W - PAD}" y="${(bestY - 3).toFixed(1)}" font-size="8" fill="#6ec76e" text-anchor="end">
        best: ${bestVal.toFixed(3)}
      </text>`;
  }

  return `
    <div class="ar-chart">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
        ${bestLine}
        <path d="${pathD}" fill="none" stroke="#d4845a" stroke-width="1.5" opacity="0.8"/>
        ${dots}
      </svg>
    </div>`;
}
