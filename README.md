# Gmail Attachment Downloader (Chrome Extension)

All project files, messages, and documentation are **English only**.

## Project goal

**Automatically download attachments from Gmail** using your existing Chrome login session.

Each run:

1. Finds the **newest unprocessed** email matching the configured search
2. Opens that email
3. **Downloads every attachment** it can detect (file attachments and inline embedded images)
4. Saves files to the folder in `downloader_config.json`
5. Marks the email as processed so it is not downloaded again

Success means at least one attachment file was saved. If an email is found but nothing is downloaded, the run reports an error.

This project does **not** require your Gmail password, app password, or API OAuth.  
(Your Chrome profile must already be signed in to Gmail.)

### What counts as an attachment

Gmail search uses `has:attachment`, which includes:

| Type | Gmail UI location | Download method in this tool |
|------|-------------------|------------------------------|
| **File attachment** (PDF, DOC, ZIP, etc.) | Attachment bar below the message (`div.aQH` / `div.aZo`) | `view=att` URLs, attachment chip hover + Download |
| **Inline embedded image** | Inside the message body (`div.a3s`) | `view=fimg` URL, image URL, hover Download |

This is **not a MIME-type issue**. Gmail renders file attachments and inline images in different parts of the page DOM. The tool must detect each type separately.

---

This project searches for the **newest unprocessed** Gmail message matching  
`to:<account> -cc:<account> has:attachment`.

---

## 1) Supported approach (Chrome 137+)

| Method | Works on Chrome 148? |
|--------|----------------------|
| `--load-extension` flag | **No (removed in Chrome 137+)** |
| **One-time Load unpacked + profile extension** | **Yes (recommended)** |

---

## 2) Extension setup on a new PC (automatic)

Chrome 148 ignores `--load-extension`. This project registers the extension directly in your Chrome profile (no manual **Load unpacked** on each machine).

1. Copy the whole `downloader` project folder to the new PC (any path is fine).
2. Edit **`downloader_config.json`** on that PC (`chrome.profile_name`, `download_dir`, `account_email`).
3. **Close all Chrome windows** (the installer will close `chrome.exe` if it is still running).
4. Run (Chrome must be closed):

```powershell
d:\My_Projects\z_testing\blockchain\downloader\run_downloader.bat
```

Or only the installer step:

```powershell
python extension_auto_installer.py
```

5. Sign in to Gmail in Chrome for the profile that matches `account_email` (if not already signed in).
6. Run `run_downloader.bat` again after Chrome is open when you need to refresh the native host or extension sync.

`run_downloader.bat` also calls the auto-installer when `auto_install_extension` is `true` (default) and the extension is missing.

### Manual fallback (Load unpacked)

If auto-install fails (brand-new Windows user with no developer-mode history in any profile):

1. Open `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the project `extension` folder
3. Close Chrome and run `run_downloader.bat` again

Chrome 137+ stores extension data in **Secure Preferences** (plain `Preferences` may list 0 extensions — that is normal).

---

## 3) Configuration — `downloader_config.json` (one file per PC)

Copy `downloader_config.example.json` to `downloader_config.json` on a new machine, then edit.

```json
{
  "account_email": "karan.guptage@gmail.com",

  "chrome": {
    "user_data_path": "",
    "profile_name": "Profile 3"
  },

  "download_dir": "C:\\Users\\YOUR_USER\\AppData\\Local\\download",

  "auto_install_extension": true,
  "launch_mode": "auto"
}
```

### Change on each PC

| Field | Description |
|-------|-------------|
| `chrome.user_data_path` | Chrome **User Data** folder. Leave `""` for default (`%LOCALAPPDATA%\\Google\\Chrome\\User Data`). |
| `chrome.profile_name` | Profile folder: `Default`, `Profile 1`, `Profile 3`, … Run `python list_chrome_profiles.py` to list. |
| `download_dir` | Folder where attachments are saved on this PC. |
| `account_email` | Gmail address for search (must match the signed-in Chrome profile). |

### Other fields

| Field | Description |
|-------|-------------|
| `extension_id` | Filled automatically on first `run_downloader.bat` (path-dependent). |
| `auto_install_extension` | `true` (default): register extension when missing. |
| `launch_mode` | `auto` (default), `attach`, or `launch` |

Processed email IDs are stored in the extension’s Chrome profile (`chrome.storage.local`), not in a project JSON file.

**Legacy flat keys** still work: `source_profile_path`, `source_profile_name`, `chrome_user_data_path`, `chrome_profile_name`.

List profiles:

```powershell
python list_chrome_profiles.py
```

---

## 4) Setup

Requires **Python 3** on PATH (stdlib only; no `pip install` needed).

---

## 5) Run

`run_downloader.bat` prepares the environment. **Downloads happen automatically** when you open a Gmail message in Chrome (content script auto-detect).

Each `run_downloader.bat` run:

1. **Profile setup** (close Chrome if Developer mode or the extension is missing): register extension in Secure Preferences.
2. **Native Messaging host**: register `com.gmail_downloader.native_host` so auto-downloads save **directly** to `download_dir` (not via the default Downloads folder).
3. Sync `extension/config.runtime.json`.

Then keep Chrome open with Gmail. When you **view an email**, the extension downloads attachments to `download_dir`.

```powershell
d:\My_Projects\z_testing\blockchain\downloader\run_downloader.bat
```

| `launch_mode` | Behavior |
|---------------|----------|
| `attach` / `auto` (default) | Requires Chrome already open with the configured Gmail profile |
| `launch` | Legacy debug mode only (separate Chrome instance) |

**Download path:** URL attachments are saved via **Native Messaging** straight into `download_dir`. Click-based fallbacks still use Chrome’s default download folder (manual downloads unchanged).

**Task Scheduler:** point the action at `run_downloader.bat` and enable “Run whether user is logged on or not” / hidden window as needed.

If Chrome window placement was corrupted by an older build (Chrome closed):

```powershell
python repair_chrome_window.py
```

---

## 6) Behavior rules

- Search: `to:<account_email> -cc:<account_email> has:attachment`
- Only the **newest** matching email is checked (read or unread)
- If already processed, nothing is downloaded
- Filenames: `<timestamp>__<subject>__<original_filename>`
- Attachment detection: **file bar** (`view=att`, attachment chips) + **inline images** (body)
- Gmail UI language should be **English** for button-based fallback; URL-based download works regardless of UI language

### Status messages

| Message | Meaning |
|---------|---------|
| `No matching emails found.` | Gmail search returned **0 rows** for the filter. |
| `Latest email already processed.` | Email was detected; attachments were already downloaded in a previous run. |
| `Could not locate attachments in the opened email.` | Email was opened but no attachment targets were found. |
| `Attachments were found but none could be downloaded.` | Targets were found but every download attempt failed. |

**Success:** `ok: true` and `downloaded` ≥ 1. The email is marked processed only after a successful download.

Each run prints **Detected newest matching email** (sender, subject, date, read/unread) to the console before the JSON result.

---

## 7) Project layout

```text
downloader/
  chrome_launcher.py           # Main launcher
  extension_auto_installer.py  # Registers extension in Chrome profile
  register_native_host.py      # Windows Native Messaging registration
  native_messaging_host.py     # Saves attachments directly to download_dir
  native_download_host.bat     # Chrome native host entry point
  chrome_secure_prefs.py       # Secure Preferences MAC helpers
  chrome_developer_mode.py
  extension_profile.py
  config_loader.py
  run_downloader.bat
  repair_chrome_window.py      # optional: fix 1x1 window placement
  list_chrome_profiles.py
  downloader_config.json
  extension/
    manifest.json
    service_worker.js
    native_client.js
    content.js
    config_utils.js
    favicon.png
    config.runtime.json        # Generated (gitignored); created by run_downloader.bat
```

---

## 8) Troubleshooting

| Symptom | Fix |
|---------|-----|
| Script closed all Chrome / tiny window after restart | Run `python repair_chrome_window.py` (Chrome closed). Current launcher does not force-close Chrome on each run. |
| Native host not found | Run `run_downloader.bat`, restart Chrome |
| Extension not listed | Close Chrome, run `run_downloader.bat` |
| Extension disabled | Enable it in `chrome://extensions` |
| Gmail login page | Use profile that is already signed in to Gmail |
| Download skipped | Open Chrome with the configured Gmail profile, then run again |

---

## 9) Notes

- If Google invalidates your session, re-authentication may be required.
- Keep Chrome open with Gmail signed in; open the target email to trigger auto-download.
- Protect `download_dir`; it may contain sensitive files.
- Use only on your own account and authorized communications.
