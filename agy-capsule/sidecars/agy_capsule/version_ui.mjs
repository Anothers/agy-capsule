// Used inside the sidebar's inline runtime, with no imports.
export function createVersionPanel(root, check, saveSettings, install, now = Date.now, system) {
  const get = id => root.querySelector('#version-' + id);
  const button = get('check');
  const toggle = get('notify');
  const message = get('status');
  const notice = get('notice');
  const details = get('available');
  const release = get('release');
  const dismiss = get('dismiss');
  const updateButton = get('update');
  const copyButton = get('copy-diagnostics');
  const copyStatus = get('copy-status');
  const diagnosticsField = get('diagnostics');
  let t = {}, enabled = false, nextAutoAt = 0;
  let autoBusy = false, manualBusy = false, manualResult, update, dismissed;
  let revision = 0, installResult;
  let copiedResult, copyState;
  const installing = () => ['updating', 'updated'].includes(installResult?.status);
  const visibleUpdate = () => update && (installing() || update.manual || enabled) && update.latestVersion !== dismissed;
  const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  function rateLimitMessage(retryAt) {
    if (!Number.isFinite(retryAt)) return t.versionRateLimit;
    const time = new Intl.DateTimeFormat(root.lang, {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(retryAt);
    return t.versionRateLimitUntil.replace('{time}', time);
  }
  function render() {
    const busy = installing();
    const showUpdate = visibleUpdate();
    const state = showUpdate ? installResult?.status || 'available' : manualBusy ? 'checking'
      : manualResult?.status === 'error' ? 'check-error' : manualResult?.status === 'current' ? 'current' : '';
    const installFailed = state === 'error';
    const checkFailed = state === 'check-error';
    button.disabled = manualBusy || busy;
    toggle.disabled = busy;
    dismiss.disabled = busy || manualBusy;
    updateButton.disabled = busy;
    setText(button, t[manualBusy ? 'versionChecking' : 'versionCheck']);
    setText(toggle, t.notifyUpdates);
    toggle.title = t.notifyUpdatesHelp;
    toggle.dataset.active = String(enabled);
    toggle.setAttribute('aria-pressed', String(enabled));
    updateButton.hidden = !checkFailed && !['available', 'updating', 'error'].includes(state);
    setText(updateButton, state === 'updating' ? t.versionUpdating : checkFailed || installFailed ? t.versionRetry : t.versionUpdate);
    const updateError = {
      busy: t.versionUpdateBusy, timeout: t.versionUpdateTimeout, releaseChanged: t.versionUpdateChanged,
      releaseCheck: t.versionUpdateRelease, download: t.versionUpdateDownload, redirect: t.versionUpdateRedirect,
      size: t.versionUpdateSize, archive: t.versionUpdateArchive, version: t.versionUpdateArchive,
      incomplete: t.versionUpdateArchive, notInstalled: t.versionUpdateNotInstalled,
      permission: t.versionUpdatePermission, locked: t.versionUpdateLocked, pathConflict: t.versionUpdatePathConflict,
      recovery: t.versionUpdateRecovery, sidecar: t.versionSidecar,
    }[installResult?.reason] || t.versionUpdateInstall;
    const installReason = installResult?.reason === 'rateLimit' ? rateLimitMessage(installResult.retryAt) : updateError;
    const restored = installResult?.diagnostics?.restored === true ? ' ' + t.versionUpdateRestored : '';
    const checkLimited = checkFailed && manualResult.reason === 'rateLimit';
    const checkReason = checkLimited ? rateLimitMessage(manualResult.retryAt) : { timeout: t.versionTimeout, noRelease: t.versionNoRelease,
      invalidRelease: t.versionInvalidRelease, localVersion: t.versionLocalMissing, sidecar: t.versionSidecar,
      http: t.versionHttp?.replace('{status}', manualResult?.httpStatus) }[manualResult?.reason] || t.versionNetwork;
    setText(message, checkFailed ? checkReason : installFailed ? installReason + restored : '');
    const link = checkLimited ? release.dataset.releasesUrl : state === 'available' || installFailed ? update.releaseUrl : '';
    release.hidden = !link;
    setText(release, checkLimited || installFailed ? t.versionUpdateManual : t.versionRelease);
    if (link) release.href = link;
    else release.removeAttribute('href');
    dismiss.setAttribute('aria-label', state === 'available' ? t.versionDismiss : t.versionClose);
    notice.hidden = !state;
    notice.dataset.state = state;
    copyButton.hidden = !installFailed;
    setText(copyButton, t.versionCopyDiagnostics);
    if (copyButton.hidden || copiedResult !== installResult) {
      copyState = '';
      diagnosticsField.value = '';
    }
    diagnosticsField.hidden = copyState !== 'manual';
    diagnosticsField.setAttribute('aria-label', t.versionCopyDiagnostics);
    setText(copyStatus, copyState === 'copied' ? t.versionDiagnosticsCopied : copyState === 'manual' ? t.versionDiagnosticsManual : '');
    const downloadFailed = ['timeout', 'download', 'redirect'].includes(installResult?.reason);
    setText(details, ({
      checking: t.versionChecking, current: t.versionUpToDate, 'check-error': t.versionCheckFailed,
      updating: t.versionUpdating, updated: t.versionUpdated,
      error: downloadFailed ? t.versionDownloadFailed : t.versionUpdateFailed,
      available: showUpdate ? t.versionAvailable + ':\u00a0' + update.currentVersion + ' → ' + update.latestVersion : '',
    })[state] || '');
  }
  function sync(prefs, labels) {
    t = labels;
    root.lang = prefs.settingsLanguage;
    if (enabled && !prefs.notifyUpdates) {
      revision++;
      nextAutoAt = 0;
      if (!update?.manual && !installing()) update = null;
    }
    enabled = prefs.notifyUpdates === true;
    render();
  }
  async function checkAutomatically() {
    if (!enabled || autoBusy || manualBusy || installing() || now() < nextAutoAt) return;
    const started = revision;
    nextAutoAt = now() + 5 * 60_000;
    autoBusy = true;
    try {
      const data = await check('auto');
      if (started !== revision || !enabled) return;
      if (['update', 'current'].includes(data.status) && manualResult?.reason === 'rateLimit') manualResult = null;
      if (data.status === 'update') {
        if (update?.latestVersion !== data.latestVersion || installResult?.reason === 'rateLimit') installResult = null;
        if (!update?.manual || update.latestVersion !== data.latestVersion) update = data;
        if (manualResult?.status === 'current') manualResult = null;
      } else if (data.status === 'current') update = null;
      render();
    } catch {} // Background checks are optional; leave the sidebar usable.
    finally { autoBusy = false; }
  }
  async function checkManually() {
    if (manualBusy || installing()) return;
    revision++;
    dismissed = null;
    update = null;
    installResult = null;
    manualResult = null;
    manualBusy = true;
    render();
    try {
      const data = await check('manual');
      manualResult = ['current', 'update', 'error'].includes(data?.status) ? data : { status: 'error', reason: 'sidecar' };
      if (manualResult.status === 'update') update = { ...manualResult, manual: true };
    } catch (error) { manualResult = { status: 'error', reason: error?.name === 'TimeoutError' ? 'timeout' : 'sidecar' }; }
    finally { manualBusy = false; render(); }
  }
  async function installUpdate() {
    if (installing() || !visibleUpdate()) return;
    revision++;
    update = { ...update, manual: true };
    installResult = { status: 'updating' };
    render();
    try {
      const result = await install(update.latestVersion);
      installResult = ['updated', 'error'].includes(result?.status) ? result : { status: 'error', reason: 'sidecar' };
    } catch (error) { installResult = { status: 'error', reason: error?.name === 'TimeoutError' ? 'timeout' : 'sidecar' }; }
    render();
  }
  async function copyDiagnostics() {
    if (copyButton.hidden) return;
    const result = installResult;
    const { step = 'sidebar-request', code, path, restored } = result.diagnostics || {};
    const text = 'agy-capsule update diagnostics\n' + JSON.stringify({
      system, currentVersion: update.currentVersion, targetVersion: update.latestVersion,
      reason: result.reason, step, code, path, restored,
    }, null, 2);
    let nextState = 'copied';
    try { await root.ownerDocument.defaultView.navigator.clipboard.writeText(text); }
    catch { nextState = 'manual'; }
    if (copyButton.hidden || result !== installResult) return;
    copiedResult = result;
    copyState = nextState;
    render();
    if (nextState === 'manual') {
      diagnosticsField.value = text;
      diagnosticsField.focus();
      diagnosticsField.select();
    }
  }
  button.addEventListener('click', checkManually);
  updateButton.addEventListener('click', () => notice.dataset.state === 'check-error' ? checkManually() : installUpdate());
  copyButton.addEventListener('click', copyDiagnostics);
  toggle.addEventListener('click', () => saveSettings({ notifyUpdates: !enabled }));
  dismiss.addEventListener('click', () => {
    if (dismiss.disabled) return;
    dismissed = update?.latestVersion;
    manualResult = null;
    render();
    button.focus();
    if (root.ownerDocument.activeElement !== button) root.ownerDocument.querySelector?.('.sidebar-tabs [aria-selected="true"]')?.focus();
  });
  return { sync, checkAutomatically, checkManually };
}
