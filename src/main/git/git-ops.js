const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const exec = promisify(execFile);

async function isGitRepo(cwd) {
  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    return true;
  } catch (e) {
    return false;
  }
}

async function gitStatus(cwd) {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd });
    return stdout.trim();
  } catch (e) {
    return null;
  }
}

async function gitDiff(cwd) {
  try {
    const { stdout } = await exec('git', ['diff', '--stat'], { cwd });
    return stdout.trim();
  } catch (e) {
    return null;
  }
}

async function gitDiffFull(cwd) {
  try {
    const { stdout } = await exec('git', ['diff'], { cwd });
    return stdout;
  } catch (e) {
    return null;
  }
}

async function autoCommit(cwd, sessionName) {
  const status = await gitStatus(cwd);
  if (!status) return null;

  try {
    // Stage all changes
    await exec('git', ['add', '-A'], { cwd });

    // Generate commit message
    const lines = status.split('\n');
    const fileCount = lines.length;
    const added = lines.filter(l => l.startsWith('??') || l.startsWith('A ')).length;
    const modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
    const deleted = lines.filter(l => l.startsWith(' D') || l.startsWith('D ')).length;

    const parts = [];
    if (added > 0) parts.push(`add ${added} file${added > 1 ? 's' : ''}`);
    if (modified > 0) parts.push(`update ${modified} file${modified > 1 ? 's' : ''}`);
    if (deleted > 0) parts.push(`remove ${deleted} file${deleted > 1 ? 's' : ''}`);

    const message = `[omniclaw/${sessionName}] ${parts.join(', ') || `${fileCount} changes`}`;

    await exec('git', ['commit', '-m', message], { cwd });
    return message;
  } catch (e) {
    console.error('Auto-commit failed:', e.message);
    return null;
  }
}

async function createGitWorktree(cwd, sessionName) {
  const worktreePath = path.join(cwd, '.claude', 'worktrees', sessionName);
  const branchName = `omniclaw/${sessionName}`;

  try {
    await exec('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd });
    return { success: true, path: worktreePath, branch: branchName };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function createGithubRepo(opts) {
  const { name, private: isPrivate, sourcePath } = opts;
  const visibility = isPrivate ? '--private' : '--public';

  try {
    const { stdout } = await exec('gh', ['repo', 'create', name, visibility, `--source=${sourcePath}`, '--push'], {
      cwd: sourcePath,
      timeout: 60000
    });
    return { success: true, output: stdout.trim() };
  } catch (e) {
    if (e.message.includes('gh')) {
      return {
        success: false,
        error: 'GitHub CLI (gh) not found. Install from https://cli.github.com and run `gh auth login`.'
      };
    }
    return { success: false, error: e.message };
  }
}

async function getCommitLog(cwd, limit = 20) {
  try {
    const { stdout } = await exec('git', [
      'log', `--max-count=${limit}`,
      '--pretty=format:%H|%ai|%s',
      '--no-merges'
    ], { cwd });
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, date, message] = line.split('|');
      return { hash, date, message };
    });
  } catch (e) {
    return [];
  }
}

module.exports = { isGitRepo, gitStatus, gitDiff, gitDiffFull, autoCommit, createGitWorktree, createGithubRepo, getCommitLog };
