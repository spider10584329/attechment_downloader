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
| Playwright profile copy | No (cookie lock) |
| Playwright CDP (`9222`) | No (port unavailable) |
| `--load-extension` flag | **No (removed in Chrome 137+)** |
| **One-time Load unpacked + profile extension** | **Yes (recommended)** |

---

## 2) Extension setup on a new PC (automatic)

Chrome 148 ignores `--load-extension`. This project registers the extension directly in your Chrome profile (no manual **Load unpacked** on each machine).

1. Copy the whole `downloader` project folder to the new PC (any path is fine).
2. Edit **`downloader_config.json`** on that PC (`chrome.profile_name`, `download_dir`, `account_email`).
3. **Close all Chrome windows** (the installer will close `chrome.exe` if it is still running).
4. Run:

```powershell
d:\My_Projects\z_testing\blockchain\downloader\install_extension.bat
```

Or:

```powershell
python extension_auto_installer.py
```

5. Sign in to Gmail in Chrome for the profile that matches `account_email` (if not already signed in).
6. Run `run_downloader.bat` as usual.

`run_downloader.bat` also calls the auto-installer when `auto_install_extension` is `true` (default) and the extension is missing.

Verify:

```powershell
python diagnose_extension.py
```

You should see `Status: READY for run_downloader.bat`.

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
  "launch_mode": "auto",
  "state_file": "downloaded_attachments.json"
}
```

### Change on each PC

| Field | Description |
|-------|-------------|
| `chrome.user_data_path` | Chrome **User Data** folder. Leave `""` for default (`%LOCALAPPDATA%\\Google\\Chrome\\User Data`). |
| `chrome.profile_name` | Profile folder: `Default`, `Profile 1`, `Profile 3`, … Run `list_profiles.bat` to list. |
| `download_dir` | Folder where attachments are saved on this PC. |
| `account_email` | Gmail address for search (must match the signed-in Chrome profile). |

### Other fields

| Field | Description |
|-------|-------------|
| `extension_id` | Filled automatically after `install_extension.bat` (path-dependent). |
| `auto_install_extension` | `true` (default): register extension when missing. |
| `launch_mode` | `auto` (default), `attach`, or `launch` |
| `background_launch` / `invisible_launch` | Chrome window behavior in launch mode |
| `state_file` | Processed email IDs (relative to project folder, or absolute path) |

**Legacy flat keys** still work: `source_profile_path`, `source_profile_name`, `chrome_user_data_path`, `chrome_profile_name`.

List profiles:

```powershell
list_profiles.bat
```

---

## 4) Setup

```powershell
pip install -r requirements.txt
```

Playwright is optional (legacy `gmail_downloader.py` only).

---

## 5) Run

Downloads run **only** when you execute `run_downloader.bat` (or `run_downloader_hidden.vbs`). The extension does **not** start a download job when Chrome starts.

Each run follows this order:

1. **Profile setup** (Chrome must be **closed** if Developer mode or the extension is missing): verify Developer mode in `Secure Preferences`, enable it with MAC + `super_mac` if off, then register the extension in the configured profile.
2. **Attachment download** (Chrome must be **open** with Gmail in that profile): attach to your running browser and download the newest unprocessed email’s attachments.

If setup runs while Chrome is closed, the script exits with *“Open Chrome … then run again.”* The downloader **never** force-closes Chrome during `run_downloader.bat`.

Chrome **can stay open** for step 2 when the profile is already prepared (default `launch_mode: attach`).

```powershell
d:\My_Projects\z_testing\blockchain\downloader\run_downloader.bat
```

### Launch modes (`launch_mode` in config)

| Mode | When Chrome is open | When Chrome is closed |
|------|---------------------|------------------------|
| **`attach`** (default) | Attach: trigger extension in running Chrome | Skip (Chrome must be open) |
| **`auto`** | Same as `attach` | Skip (Chrome must be open) |
| **`launch`** | Debug only: separate Chrome instance | Separate instance, closed when done |

**Attach mode** (Chrome already running):

1. Syncs config into the extension folder
2. Opens `chrome-extension://.../trigger.html` in a **minimized hidden window** (not in your visible tabs)
3. Waits for downloads to finish
4. **Does not close Chrome** — your tabs stay open

**Launch mode** (`launch_mode: launch`, debugging only):

1. Starts a separate Chrome instance
2. Runs the download job
3. Closes only that instance when finished

The downloader **never** force-closes your open Chrome windows.

Requirements for attach mode:

- Extension installed and enabled in the **profile you use daily**
- Gmail signed in in that same profile (no password needed if already logged in)

### Stealth / minimized automation window

Stealth applies **only** to the extension's automation window (Gmail search + download), not your existing Chrome windows:

- `trigger.html` relocates into a **minimized** window (`trigger.js` + `window_utils.js`)
- The Python launcher does **not** hide or resize your normal Chrome windows
- Do **not** set off-screen `--window-size=1,1` flags from the launcher (they can corrupt `browser.window_placement` in your profile)

If Chrome opens as a tiny corner after an older run, close Chrome and run:

```powershell
repair_chrome_window.bat
```

### Automation window (extension)

When `run_downloader.bat` triggers the extension, Gmail opens in a **separate window** that:

- Starts **minimized** (Chrome 148+ does not allow windows at -3000,-3000; they must be ≥50% on screen)
- Does **not** take focus (`focused: false`)
- **Closes automatically** when the download job finishes

Optional size in `downloader_config.json`:

```json
"automation_window_width": 900,
"automation_window_height": 700
```

During a run, the extension uses `chrome.downloads.setUiOptions({ enabled: false })` (requires `downloads.ui` permission) to hide Chrome’s download icon and “Done” bubble. The UI is restored when the job finishes. Manual downloads in the same profile are also hidden while a job is running.

Reload the extension at `chrome://extensions` after updating to **1.116.0** (accept the new permission if prompted).

`chrome_launcher.py` will:

1. Verify extension is installed and enabled in your profile
2. Sync `config.runtime.json` into the extension folder
3. Trigger the extension (attach or launch)
4. Open Gmail search and download attachments from the newest unprocessed email
6. Save attachments (directly to `download_dir` in launch mode, or relocate there after attach mode)
7. Report completion via HTTP (`127.0.0.1:8765`) and `.gmail_dl_status.json`

**Download path note:** Set `download_dir` to your final folder (for example `C:\Users\Administrator\AppData\Local\download`).

- **Launch mode** (Chrome started by `run_downloader.bat`): the launcher sets Chrome's default download folder to `download_dir`, so files land there directly.
- **Attach mode** (Chrome already running): Chrome still uses its current default (usually `Downloads\download`); when the run finishes, the launcher waits for downloads to complete and **moves** them into `download_dir`.

**Hidden run (Task Scheduler):**

```text
wscript "d:\My_Projects\z_testing\blockchain\downloader\run_downloader_hidden.vbs"
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
  chrome_launcher.py          # Main launcher (profile extension only)
  extension_auto_installer.py # Registers extension in Chrome profile (new PC)
  chrome_secure_prefs.py      # Secure Preferences MAC helpers
  diagnose_extension.py       # Installation diagnostics
  install_extension.bat       # Auto-install extension (close Chrome first)
  setup_extension.bat         # Same as install_extension.bat
  extension_installer.py      # Legacy wrapper (calls extension_auto_installer)
  run_downloader.bat
  run_downloader_hidden.vbs
  downloader_config.example.json
  config_loader.py
  list_chrome_profiles.py
  list_profiles.bat
  downloader_config.json
  extension/
    manifest.json
    background.js
    content.js
    trigger.html
    trigger.js
    config.runtime.json       # Generated at runtime
  gmail_downloader.py         # Legacy Playwright script (optional)
```

---

## 8) Troubleshooting

| Symptom | Fix |
|---------|-----|
| Script closed all Chrome / tiny window after restart | Run `repair_chrome_window.bat` (Chrome closed). Update to latest launcher (attach-only, no taskkill on run). |
| Timeout waiting for extension | Run `python diagnose_extension.py`, redo one-time Load unpacked |
| Extension not listed | Close Chrome, run `setup_extension.bat` |
| Extension disabled | Enable it in `chrome://extensions` |
| Gmail login page | Use profile that is already signed in to Gmail |
| Download skipped | Open Chrome with the configured Gmail profile, then run again |

---

## 9) Notes

- If Google invalidates your session, re-authentication may be required.
- Keep Chrome open with Gmail signed in; only the automation window is minimized during a run.
- Protect `download_dir`; it may contain sensitive files.
- Use only on your own account and authorized communications.
