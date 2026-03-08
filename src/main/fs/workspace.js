const fs = require('fs');
const path = require('path');

function detectClaudeMd(workspacePath) {
  if (!workspacePath) return null;
  const claudeMdPath = path.join(workspacePath, 'CLAUDE.md');
  try {
    if (fs.existsSync(claudeMdPath)) {
      return fs.readFileSync(claudeMdPath, 'utf-8');
    }
  } catch (e) { /* ignore */ }
  return null;
}

function generateFileMap(workspacePath, maxFiles = 50) {
  if (!workspacePath) return '';

  const files = [];
  const ignoreDirs = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.claude']);

  function walk(dir, prefix = '') {
    if (files.length >= maxFiles) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of sorted) {
        if (files.length >= maxFiles) break;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        if (ignoreDirs.has(entry.name)) continue;

        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          files.push(`${relPath}/`);
          walk(path.join(dir, entry.name), relPath);
        } else {
          files.push(relPath);
        }
      }
    } catch (e) { /* skip unreadable dirs */ }
  }

  walk(workspacePath);
  return files.join('\n');
}

function resolveRelativePath(workspacePath, refPath) {
  if (path.isAbsolute(refPath)) return refPath;
  return path.resolve(workspacePath, refPath);
}

module.exports = { detectClaudeMd, generateFileMap, resolveRelativePath };
