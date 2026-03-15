// ── Target Selector — renders list of researchable targets ──

export function renderTargetSelector(targets, activeResearch, selectedTargetId) {
  // Group by type
  const grouped = { plugin: [], mcp: [], skill: [] };
  for (const t of targets) {
    const group = grouped[t.type] || (grouped.other = grouped.other || []);
    group.push(t);
  }

  let html = '';

  for (const [type, items] of Object.entries(grouped)) {
    if (!items || items.length === 0) continue;
    const typeLabel = type === 'plugin' ? 'Plugins' : type === 'mcp' ? 'MCP Servers' : type === 'skill' ? 'Skills' : 'Other';
    html += `<div class="ar-type-group"><div class="ar-type-label">${typeLabel}</div>`;

    for (const target of items) {
      const id = target.id;
      const isActive = activeResearch[id] && (activeResearch[id].status === 'running' || activeResearch[id].status === 'starting');
      const isSelected = id === selectedTargetId;
      const research = activeResearch[id];

      let statusBadge = '';
      if (isActive) {
        const count = research.experimentCount || 0;
        statusBadge = `<span class="ar-badge running">${count} exp</span>`;
      }

      // Metrics summary
      let metricsHtml = '';
      if (target.metrics) {
        const m = target.metrics;
        const parts = [];
        if (m.skillCount) parts.push(`${m.skillCount} skills`);
        if (m.hookCount) parts.push(`${m.hookCount} hooks`);
        if (m.commandCount) parts.push(`${m.commandCount} cmds`);
        if (m.totalLines) parts.push(`${m.totalLines} lines`);
        if (m.toolCount) parts.push(`${m.toolCount} tools`);
        if (parts.length > 0) {
          metricsHtml = `<div class="ar-target-metrics">${parts.join(' · ')}</div>`;
        }
      }

      const editableCount = (target.editableFiles || []).length;

      html += `
        <div class="ar-target-card ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}">
          <div class="ar-target-header">
            <button class="ar-select-btn" data-target-id="${id}" title="Select for timeline view">
              <span class="ar-target-name">${target.name}</span>
            </button>
            ${statusBadge}
          </div>
          ${metricsHtml}
          <div class="ar-target-info">
            <span>${editableCount} editable file${editableCount !== 1 ? 's' : ''}</span>
          </div>
          <div class="ar-target-actions">
            ${isActive
              ? `<button class="btn ar-stop-btn" data-target-id="${id}" style="padding:1px 6px;font-size:9px">Stop</button>`
              : `<button class="btn btn-primary ar-start-btn" data-target-id="${id}" style="padding:1px 6px;font-size:9px">Start Research</button>`
            }
          </div>
        </div>`;
    }
    html += '</div>';
  }

  return html;
}
