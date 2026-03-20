/**
 * Path normalization utilities for cross-machine sync.
 *
 * Absolute paths differ between machines (different usernames, OS, drive letters).
 * These helpers convert to/from a portable "~/" prefix form so that paths stored
 * in Turso are meaningful on any machine in the sync group.
 */

const os = require('os');
const path = require('path');

/**
 * Convert an absolute filesystem path to a portable relative path.
 * Paths under the user's home directory become ~/rest/of/path (forward slashes).
 * Other paths are returned with forward slashes but otherwise unchanged.
 */
function toPortablePath(absolutePath) {
  if (!absolutePath) return absolutePath;
  const home = os.homedir();
  const normalized = path.resolve(absolutePath);
  if (normalized.startsWith(home)) {
    return '~' + normalized.slice(home.length).replace(/\\/g, '/');
  }
  return normalized.replace(/\\/g, '/');
}

/**
 * Convert a portable path back to an absolute path for this machine.
 * ~/rest/of/path becomes <homedir>/rest/of/path using native separators.
 */
function toAbsolutePath(portablePath) {
  if (!portablePath) return portablePath;
  if (portablePath.startsWith('~')) {
    return path.join(os.homedir(), portablePath.slice(1));
  }
  return portablePath;
}

/**
 * Generate a stable machine identifier based on hostname + platform.
 * This isn't cryptographically unique but is sufficient for distinguishing
 * machines in a personal sync group.
 */
function getMachineId() {
  const crypto = require('crypto');
  const raw = `${os.hostname()}-${os.platform()}-${os.userInfo().username}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Return a human-friendly machine name.
 */
function getMachineName() {
  return `${os.userInfo().username}@${os.hostname()}`;
}

module.exports = { toPortablePath, toAbsolutePath, getMachineId, getMachineName };
