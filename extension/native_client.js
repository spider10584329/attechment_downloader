// Chrome Native Messaging client — saves files directly to configured_download_dir.

const NATIVE_HOST_NAME = "com.gmail_downloader.native_host";
const NATIVE_CHUNK_RAW_BYTES = 400 * 1024;

let nativePort = null;
let nativeTargetDir = "";
let nativeRequestId = 0;
const nativeWaiters = new Map();

function nextNativeRequestId() {
  nativeRequestId += 1;
  return `req_${Date.now()}_${nativeRequestId}`;
}

function waitForNativeResponse(requestId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeWaiters.delete(requestId);
      reject(new Error("Native host response timeout."));
    }, timeoutMs);
    nativeWaiters.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

function handleNativeMessage(payload) {
  const requestId = payload?.request_id;
  if (!requestId || !nativeWaiters.has(requestId)) {
    return;
  }
  const waiter = nativeWaiters.get(requestId);
  nativeWaiters.delete(requestId);
  if (payload?.ok) {
    waiter.resolve(payload);
  } else {
    waiter.reject(new Error(payload?.error || "Native host error."));
  }
}

function postNativeMessage(message) {
  return new Promise((resolve, reject) => {
    if (!nativePort) {
      reject(new Error("Native host is not connected."));
      return;
    }
    const requestId = nextNativeRequestId();
    const payload = { ...message, request_id: requestId };
    waitForNativeResponse(requestId).then(resolve).catch(reject);
    try {
      nativePort.postMessage(payload);
    } catch (error) {
      nativeWaiters.delete(requestId);
      reject(error);
    }
  });
}

async function connectNativeHost(targetDir) {
  const configured = String(targetDir || "").trim();
  if (nativePort && nativeTargetDir === configured) {
    return true;
  }
  disconnectNativeHost();
  if (!configured) {
    throw new Error("configured_download_dir is required for native downloads.");
  }

  nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort.onMessage.addListener(handleNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    nativePort = null;
    nativeTargetDir = "";
    for (const [, waiter] of nativeWaiters.entries()) {
      waiter.reject(new Error("Native host disconnected."));
    }
    nativeWaiters.clear();
  });

  const response = await postNativeMessage({
    action: "configure",
    target_dir: configured,
  });
  if (!response?.ok) {
    disconnectNativeHost();
    throw new Error(response?.error || "Native host configure failed.");
  }
  nativeTargetDir = configured;
  return true;
}

function disconnectNativeHost() {
  if (!nativePort) {
    nativeTargetDir = "";
    return;
  }
  try {
    nativePort.disconnect();
  } catch (_error) {
    // Port may already be closed.
  }
  nativePort = null;
  nativeTargetDir = "";
  nativeWaiters.clear();
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function saveBase64ViaNative(filename, base64Data, targetDir) {
  await connectNativeHost(targetDir);
  const bytes = base64ToBytes(base64Data);
  const chunkTotal = Math.max(1, Math.ceil(bytes.length / NATIVE_CHUNK_RAW_BYTES));
  const transferId =
    chunkTotal > 1 ? `xfer_${Date.now()}_${Math.random().toString(16).slice(2)}` : "";

  for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex += 1) {
    const start = chunkIndex * NATIVE_CHUNK_RAW_BYTES;
    const slice = bytes.subarray(start, start + NATIVE_CHUNK_RAW_BYTES);
    let binary = "";
    const step = 0x8000;
    for (let offset = 0; offset < slice.length; offset += step) {
      binary += String.fromCharCode.apply(null, slice.subarray(offset, offset + step));
    }
    const response = await postNativeMessage({
      action: "save_file",
      target_dir: targetDir,
      filename,
      data: btoa(binary),
      transfer_id: transferId,
      chunk_index: chunkIndex,
      chunk_total: chunkTotal,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Native save failed.");
    }
    if (response.pending) {
      continue;
    }
  }
  return true;
}
