const { Notification } = require('electron');
const path = require('path');

class Notifier {
  constructor() {
    this.muted = false;
  }

  setMuted(muted) {
    this.muted = muted;
  }

  showNative(title, body, onClick) {
    if (!Notification.isSupported()) return;

    const notification = new Notification({
      title,
      body,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      silent: this.muted
    });

    if (onClick) {
      notification.on('click', onClick);
    }

    notification.show();
    return notification;
  }

  sessionWaiting(sessionName) {
    this.showNative(
      `${sessionName} needs your input`,
      'Session is waiting for your response.'
    );
  }

  taskComplete(sessionName) {
    this.showNative(
      `${sessionName} finished a task`,
      'Claude has completed processing.'
    );
  }

  mcpDisconnected(serverName) {
    this.showNative(
      `${serverName} lost connection`,
      'MCP server disconnected. Check server status.'
    );
  }

  repoCreated(repoName, url) {
    this.showNative(
      `Repo ${repoName} created`,
      url || 'Repository created successfully.'
    );
  }

  // ── AutoResearch notifications ───────────────────────────

  researchStarted(targetId) {
    this.showNative(
      'Research Started',
      `AutoResearch is now running on "${targetId}".`
    );
  }

  researchStopped(targetId, reason) {
    this.showNative(
      'Research Stopped',
      reason
        ? `Research on "${targetId}" stopped: ${reason}`
        : `Research on "${targetId}" has been stopped.`
    );
  }

  researchNewBest(targetId, metricName, metricValue, experimentNum) {
    this.showNative(
      `New Best: ${metricValue.toFixed(3)}`,
      `Experiment #${experimentNum} on "${targetId}" set a new best for ${metricName}.`
    );
  }

  researchAutoStopped(targetId, reason) {
    this.showNative(
      'Research Auto-Stopped',
      `"${targetId}" stopped automatically: ${reason}`
    );
  }

  researchExperimentFailed(targetId, experimentNum, description) {
    this.showNative(
      `Experiment #${experimentNum} Failed`,
      `Research on "${targetId}": ${description || 'Experiment crashed.'}`
    );
  }
}

module.exports = { Notifier };
