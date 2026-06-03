// Shared download-path normalization (service worker + content script).

function isAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || ""));
}

function pathBaseName(value) {
  const parts = String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
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

  let relative = normalized.download_relative_dir;
  if (relative === undefined || relative === null) {
    if (normalized.needs_relocate) {
      const staging = String(normalized.staging_dir || "").trim();
      relative = pathBaseName(staging) || "download";
    } else if (isAbsolutePath(legacyDir)) {
      relative = "";
    } else if (legacyDir) {
      relative = legacyDir.replace(/\\/g, "/");
    } else {
      relative = "";
    }
  }

  normalized.download_relative_dir = String(relative);
  return normalized;
}

function resolveRunDownloadRelativeDir(config) {
  return normalizeDownloadConfig(config).download_relative_dir;
}
