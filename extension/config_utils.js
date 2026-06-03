// Shared download-path normalization (service worker + content script).

function isAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || ""));
}

function normalizeDownloadConfig(config) {
  const normalized = { ...(config || {}) };

  let configured = String(normalized.configured_download_dir || "").trim();
  const legacyDir = String(normalized.download_dir || "").trim();

  if (!configured && isAbsolutePath(legacyDir)) {
    configured = legacyDir;
  }
  if (!configured) {
    throw new Error(
      "configured_download_dir is required in config.runtime.json (re-run run_downloader.bat)"
    );
  }

  normalized.configured_download_dir = configured;
  normalized.download_dir = configured;
  normalized.use_native_download = normalized.use_native_download !== false;
  return normalized;
}
