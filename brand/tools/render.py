"""Rasterise an HTML file to PNG with headless Chrome (macOS).

Chrome writes the screenshot but does not always exit, so we poll for the
file and then terminate it. Usage from Python: render(html_path, png_path, w, h). Pages render in the
light colour scheme unless scheme="dark".
"""
import os, shutil, subprocess, tempfile, time

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def render(html, png, w, h, scale=1, transparent=True, scheme="light", timeout=60):
    html, png = os.path.abspath(html), os.path.abspath(png)
    if os.path.exists(png):
        os.remove(png)
    prof = tempfile.mkdtemp(prefix="palm-chrome-")
    args = [CHROME, "--headless=new", f"--user-data-dir={prof}", "--disable-gpu",
            "--hide-scrollbars", "--no-first-run", "--disable-extensions",
            # prefers-color-scheme for the page (Chrome otherwise follows the OS)
            f"--blink-settings=preferredColorScheme={0 if scheme == 'dark' else 1}",
            f"--force-device-scale-factor={scale}", f"--window-size={w},{h}",
            f"--screenshot={png}", "file://" + html]
    if transparent:
        args.insert(1, "--default-background-color=00000000")
    p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    t0, last = time.time(), -1
    try:
        while time.time() - t0 < timeout:
            if os.path.exists(png):
                size = os.path.getsize(png)
                if size > 0 and size == last:
                    break
                last = size
            if p.poll() is not None and os.path.exists(png):
                break
            time.sleep(0.4)
        else:
            raise TimeoutError(f"chrome did not write {png}")
    finally:
        try:
            os.killpg(p.pid, 15)
        except ProcessLookupError:
            pass
        p.wait(timeout=10)
        shutil.rmtree(prof, ignore_errors=True)
    return png
