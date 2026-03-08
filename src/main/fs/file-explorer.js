const fs = require('fs');
const path = require('path');

async function readDirectory(dirPath, depth = 0, maxDepth = 1) {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const result = [];

    // Sort: directories first, then files, both alphabetical
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    for (const entry of sorted) {
      // Skip hidden/system dirs
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      const item = {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        extension: entry.isFile() ? path.extname(entry.name).toLowerCase() : null
      };

      // Recursively read subdirectories up to maxDepth
      if (entry.isDirectory() && depth < maxDepth) {
        item.children = await readDirectory(fullPath, depth + 1, maxDepth);
      }

      result.push(item);
    }

    return result;
  } catch (error) {
    console.error(`Failed to read directory ${dirPath}:`, error.message);
    return [];
  }
}

function getFileExtensionClass(ext) {
  const map = {
    '.md': 'md', '.markdown': 'md',
    '.json': 'json', '.jsonc': 'json',
    '.js': 'js', '.mjs': 'js', '.cjs': 'js',
    '.ts': 'ts', '.mts': 'ts',
    '.jsx': 'jsx', '.tsx': 'tsx',
    '.css': 'css', '.scss': 'css', '.less': 'css',
    '.html': 'html', '.htm': 'html',
    '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.gif': 'gif', '.svg': 'svg',
    '.java': 'java',
    '.py': 'py',
    '.rs': 'rs',
    '.go': 'go',
    '.sql': 'sql',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml',
    '.sh': 'sh', '.bash': 'sh',
    '.ps1': 'ps1',
    '.xml': 'xml'
  };
  return map[ext] || 'default';
}

module.exports = { readDirectory, getFileExtensionClass };
