const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

// Copy xterm.css to dist
const xtermCssSrc = path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
const distDir = path.join(__dirname, 'dist');

if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

if (fs.existsSync(xtermCssSrc)) {
  fs.copyFileSync(xtermCssSrc, path.join(distDir, 'xterm.css'));
}

// Bundle renderer JS
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'src', 'renderer', 'js', 'app.js')],
  bundle: true,
  outfile: path.join(distDir, 'renderer.js'),
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
  minify: false,
  target: ['chrome120'],
  define: {
    'process.env.NODE_ENV': '"development"'
  }
});

console.log('Build complete: dist/renderer.js');
