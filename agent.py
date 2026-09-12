from flask import Flask, request, jsonify
import subprocess, os, tempfile, threading, re, time, pty, select, signal

app = Flask(__name__)

HOME    = os.path.expanduser("~")
TMPDIR  = os.environ.get('TMPDIR') or os.path.join(HOME, '.agent_tmp')
STATE_DIR = os.path.join(TMPDIR, 'agent_state')
LOG_DIR   = os.path.join(TMPDIR, 'agent_log')
CWD_FILE  = os.path.join(STATE_DIR, 'cwd')

os.makedirs(STATE_DIR, exist_ok=True)
os.makedirs(LOG_DIR,   exist_ok=True)

if not os.path.exists(CWD_FILE):
    open(CWD_FILE,'w').write(HOME)

TIMEOUT   = 30
MAX_LINES = 300
# FIX E: normalize ke baad compare — space variations se bypass nahi hoga
BLACKLIST = [
    r'\brm\b(?=.*\s-[a-z]*r)(?=.*\s-[a-z]*f).*\s+/\s*$',  # rm ... -r ... -f ... / (flexible)
    r'\brm\b(?=.*\s-[a-z]*r)(?=.*\s-[a-z]*f).*\s+/\s',     # rm ... -r ... -f ... /path
    r'\bmkfs\b',                             # mkfs, mkfs.ext4, etc.
    r'\bdd\b.*\bif\s*=',                     # dd if=...
    r'\bshutdown\b',
    r'\breboot\b',
    r':\(\)\s*\{.*\};\s*:',                  # fork bomb
    r'\bchmod\s+-[a-z]*r[a-z]*\s+0*777\s+/\s*$',  # chmod -R 777 / (lower ke baad)
]

# ── Global session state ──────────────────────────────────────────────────────
session = {
    'running': False,
    'chunks': [],       # live output chunks
    'done': False,
    'final_output': '',
    'input_needed': False,
    'input_context': '',
    'input_event': threading.Event(),
    'input_value': None,
}

# FIX C: session fields ko thread-safe banane ke liye lock
session_lock = threading.Lock()

def get_cwd():
    return open(CWD_FILE).read().strip()

def set_cwd(path):
    open(CWD_FILE,'w').write(path)

def strip_ansi(text):
    # FIX F: CSI (incl. private modes ?), OSC, charset-select, bell, CR — sab strip
    patterns = [
        r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)',  # OSC ... BEL/ST
        r'\x1b\[[\?0-9;]*[a-zA-Z@`]',          # CSI (with ? for private modes)
        r'\x1b[()][AB012]',                     # charset select
        r'\x1b[=>78]',                          # keypad / save-restore
        r'\x1b[@-Z\\-_]',                       # single-char ESC seqs
        r'\x07',                                # BEL
        r'\r',                                  # CR (progress bars overwrite)
    ]
    for p in patterns:
        text = re.sub(p, '', text)
    return text

def clean_output(text):
    lines = text.splitlines()
    cleaned, blank = [], False
    for line in lines:
        # FIX D: legacy `script` filter hataya — ab pty.openpty() use hota hai,
        # aur 'Script started/done' asli output mein aa sakta hai (grep/echo etc).
        line = line.rstrip()
        if line:
            cleaned.append(line); blank = False
        elif not blank:
            cleaned.append(''); blank = True
    return '\n'.join(cleaned)

def smart_truncate(text):
    lines = text.splitlines()
    if len(lines) <= MAX_LINES:
        return text
    skipped = len(lines) - MAX_LINES
    return f'[{skipped} lines truncated]\n\n' + '\n'.join(lines[-MAX_LINES:])

def is_blacklisted(cmd):
    # FIX E: whitespace normalize + case-insensitive regex match — bypass mushkil
    normalized = re.sub(r'\s+', ' ', cmd.strip().lower())
    return any(re.search(b, normalized) for b in BLACKLIST)

def run_cmd_thread(raw_cmd):
    global session
    cwd = get_cwd()

    # Pure cd
    if re.match(r'^cd\s+[^;&|]+$', raw_cmd.strip()):
        target = raw_cmd.strip()[3:].strip()
        result = subprocess.run(
            f"cd {cwd!r} && cd {target!r} && pwd",
            shell=True, capture_output=True, text=True
        )
        new_dir = result.stdout.strip()
        if new_dir and os.path.isdir(new_dir):
            set_cwd(new_dir)
            out = f'📂 Changed directory to: {new_dir}'
        else:
            out = f'⚠ cd failed: {target}'
        # FIX C: lock ke andar session update
        with session_lock:
            session['chunks'].append(out)
            session['final_output'] = out
            session['done'] = True
            session['running'] = False
        return

    full_cmd = f"cd {cwd!r} && {raw_cmd}"
    output_lines = []
    timed_out = False

    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(
        ['bash', '-c', full_cmd],
        stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
        close_fds=True, preexec_fn=os.setsid
    )
    os.close(slave_fd)

    start_time = time.time()

    while True:
        if time.time() - start_time > TIMEOUT:
            timed_out = True
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except:
                pass
            break

        try:
            rlist, _, _ = select.select([master_fd], [], [], 0.1)
        except:
            break

        if not rlist:
            if proc.poll() is not None:
                break
            continue

        try:
            data = os.read(master_fd, 1024).decode('utf-8', errors='replace')
        except OSError:
            break

        clean = strip_ansi(data)
        output_lines.append(clean)
        # FIX C: lock ke andar append — poll ke saath race nahi
        with session_lock:
            session['chunks'].append(clean)

        # Input detect — 2 layer approach
        stripped = clean.strip()
        lower    = stripped.lower()
        is_short_line = len(stripped.splitlines()) == 1 and len(stripped) < 200

        # Layer 1: Known strong patterns — turant trigger
        known_prompt = is_short_line and (
            bool(re.search(r'\[y[/\\]n\][\s:]*$',  lower)) or
            bool(re.search(r'\(y[/\\]n\)[\s:]*$',  lower)) or
            bool(re.search(r'password\s*:\s*$',        lower)) or
            bool(re.search(r'passphrase\s*:\s*$',      lower)) or
            bool(re.search(r'enter passw',               lower)) or
            bool(re.search(r'pin\s*:\s*$',             lower)) or
            bool(re.search(r'username\s*:\s*$',        lower)) or
            bool(re.search(r'login\s*:\s*$',           lower)) or
            bool(re.search(r'continue\s*\?',           lower)) or
            bool(re.search(r'proceed\s*\?',            lower)) or
            bool(re.search(r'\[yes[/\\]no\]',        lower)) or
            bool(re.search(r'overwrite\s*\?',          lower))
        )

        # Layer 2: Generic — colon/? se end hone wala short line
        # 400ms silence check — confirm karo process block hai
        generic_prompt = is_short_line and not known_prompt and (
            bool(re.search(r'[\w\s]{2,}[\?\:]\s*$', stripped))
        )

        needs_input = known_prompt or generic_prompt

        if needs_input and generic_prompt and proc.poll() is None:
            time.sleep(0.4)
            try:
                rlist2, _, _ = select.select([master_fd], [], [], 0.0)
                if rlist2:
                    needs_input = False  # naya output aa raha — false positive
            except:
                pass

        if needs_input and proc.poll() is None:
            with session_lock:
                session['input_needed']  = True
                session['input_context'] = clean.strip()
                session['input_event'].clear()

            got_input = session['input_event'].wait(timeout=60)

            with session_lock:
                val = session['input_value']
                session['input_value']  = None
                session['input_needed'] = False

            if got_input and val is not None:
                try:
                    os.write(master_fd, (val + '\n').encode())
                except:
                    pass
            elif not got_input:
                # FIX H: 60s tak input nahi mila — process kill + message (silent hang khatam)
                print("⚠️ Input timeout 60s — process kill kar raha hoon")
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except:
                    pass
                output_lines.append(
                    "\n[INPUT TIMEOUT — 60s tak input nahi mila, process killed]\n"
                )
                break

    # FIX B: /proc/PID/cwd readlink PEHLE karo — proc.wait() ke baad /proc entry
    # reap ho jaati hai aur readlink hamesha FileNotFoundError deta tha
    try:
        proc_cwd = os.readlink(f'/proc/{proc.pid}/cwd')
        if proc_cwd and os.path.isdir(proc_cwd):
            set_cwd(proc_cwd)
    except:
        pass

    try:
        proc.wait(timeout=2)
    except:
        pass
    try:
        os.close(master_fd)
    except:
        pass

    exit_code = proc.returncode or 0
    full_output = clean_output(strip_ansi(''.join(output_lines)))

    if not full_output.strip():
        if timed_out:
            final = f'⏰ Timeout — killed after {TIMEOUT}s.'
        elif exit_code == 0:
            final = '✅ Done. No output.'
        else:
            final = f'❌ Failed (exit {exit_code}). No output.'
    else:
        prefix = ''
        if timed_out:
            prefix = f'[TIMEOUT — {TIMEOUT}s]\n'
        elif exit_code != 0:
            prefix = f'[exit code: {exit_code}]\n'
        final = smart_truncate(prefix + full_output)

    # FIX C: final update lock ke andar — poll ke saath atomic
    with session_lock:
        session['final_output'] = final
        session['done'] = True
        session['running'] = False

# ── HTTP Endpoints ────────────────────────────────────────────────────────────

@app.route('/run', methods=['POST'])
def run():
    global session
    data = request.json
    cmd  = data.get('cmd','').strip()

    if not cmd:
        return jsonify({"output": "❌ Empty command."})
    if is_blacklisted(cmd):
        return jsonify({"output": f"🚫 Blocked: {cmd}"})

    # FIX A: concurrent run block — agar koi command already chal rahi hai to reject
    with session_lock:
        if session['running']:
            print(f"⚠️ Rejected concurrent cmd (busy): {cmd}")
            return jsonify({
                "status": "busy",
                "output": "⚠️ Ek command already chal rahi hai. Finish hone do."
            })

        # Session reset (lock ke andar — atomic)
        session['running']       = True
        session['chunks']        = [f'$ {cmd}\n']
        session['done']          = False
        session['final_output']  = ''
        session['input_needed']  = False
        session['input_context'] = ''
        session['input_value']   = None
        session['input_event']   = threading.Event()  # fresh event — purana set state clear

    print(f"\n⚡ CMD: {cmd}\n📂 CWD: {get_cwd()}")

    t = threading.Thread(target=run_cmd_thread, args=(cmd,), daemon=True)
    t.start()

    return jsonify({"status": "started"})

@app.route('/poll', methods=['GET'])
def poll():
    # FIX C: saare fields ek hi lock ke andar snapshot — multi-field race khatam
    with session_lock:
        chunks = session['chunks']
        session['chunks'] = []
        snapshot = {
            "chunks":        chunks,
            "done":          session['done'],
            "final_output":  session['final_output'],
            "input_needed":  session['input_needed'],
            "input_context": session['input_context'],
        }
    return jsonify(snapshot)

@app.route('/input', methods=['POST'])
def send_input():
    data = request.json
    session['input_value'] = data.get('value', '')
    session['input_needed'] = False
    session['input_event'].set()
    print(f"✏️ Input received: {session['input_value']}")
    return jsonify({"status": "ok"})

@app.route('/edit', methods=['POST'])
def edit_file():
    """str_replace style edit — old_str ko new_str se replace karo."""
    data     = request.json
    path     = data.get('path', '').strip()
    old_str  = data.get('old_str', '')
    new_str  = data.get('new_str', '')

    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    # Relative path → CWD se resolve karo
    if not os.path.isabs(path):
        path = os.path.join(get_cwd(), path)

    if not os.path.exists(path):
        return jsonify({"status": "error", "output": f"❌ File not found: {path}"})

    try:
        content = open(path, 'r', encoding='utf-8', errors='replace').read()
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Read error: {e}"})

    count = content.count(old_str)
    if count == 0:
        return jsonify({"status": "error", "output": "❌ old_str not found in file. Exact match chahiye (whitespace/newlines sahi hone chahiye)."})
    if count > 1:
        return jsonify({"status": "error", "output": f"❌ old_str {count} jagah mila — unique hona chahiye. old_str aur surrounding lines badao."})

    new_content = content.replace(old_str, new_str, 1)

    try:
        open(path, 'w', encoding='utf-8').write(new_content)
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Write error: {e}"})

    lines_before = content.count('\n')
    lines_after  = new_content.count('\n')
    print(f"✏️ EDIT: {path}  ({lines_before}→{lines_after} lines)")
    return jsonify({"status": "ok", "output": f"✅ Edit done: {path} ({lines_before}→{lines_after} lines)"})


@app.route('/write', methods=['POST'])
def write_file():
    """Poori file ek baar mein likho — koi shell nahi, koi heredoc nahi."""
    data    = request.json
    path    = data.get('path', '').strip()
    content = data.get('content', '')

    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    if not os.path.isabs(path):
        path = os.path.join(get_cwd(), path)

    try:
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        open(path, 'w', encoding='utf-8').write(content)
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Write error: {e}"})

    lines = content.count('\n')
    print(f"📝 WRITE: {path} ({lines} lines)")
    return jsonify({"status": "ok", "output": f"✅ Written: {path} ({lines} lines)"})

@app.route('/read', methods=['POST'])
def read_file():
    """File ka content directly return karo — cat se faster, no shell round-trip."""
    data = request.json
    path = data.get('path', '').strip()

    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    if not os.path.isabs(path):
        path = os.path.join(get_cwd(), path)

    if not os.path.exists(path):
        return jsonify({"status": "error", "output": f"❌ File not found: {path}"})

    if os.path.isdir(path):
        try:
            entries = os.listdir(path)
            entries.sort()
            listing = '\n'.join(entries)
            return jsonify({"status": "ok", "output": f"📂 {path}/\n{listing}"})
        except Exception as e:
            return jsonify({"status": "error", "output": f"❌ Dir read error: {e}"})

    try:
        size = os.path.getsize(path)
        if size > 500_000:
            return jsonify({"status": "error", "output": f"❌ File too large ({size} bytes). RUN_CMD: head -n 100 {path} use karo."})
        content = open(path, 'r', encoding='utf-8', errors='replace').read()
        lines = content.count('\n')
        print(f"📖 READ: {path} ({lines} lines)")
        return jsonify({"status": "ok", "output": f"📄 {path} ({lines} lines):\n\n{content}"})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Read error: {e}"})


@app.route('/status', methods=['GET'])
def status():
    """Server alive check + current state."""
    with session_lock:
        running = session['running']
        input_needed = session['input_needed']
    return jsonify({
        "status": "ok",
        "cwd": get_cwd(),
        "running": running,
        "input_needed": input_needed
    })


if __name__ == '__main__':
    print("╔══════════════════════════════════════════╗")
    print("║     🤖  Termux AI Agent Server           ║")
    print("╠══════════════════════════════════════════╣")
    print(f"║  CWD    : {get_cwd()[:30]:<30}║")
    print(f"║  Timeout: {TIMEOUT}s  │  Max: {MAX_LINES} lines          ║")
    print("╠══════════════════════════════════════════╣")
    print("║  HTTP  : localhost:5000                  ║")
    print("║  Poll  : localhost:5000/poll             ║")
    print("╚══════════════════════════════════════════╝")
    app.run(host='0.0.0.0', port=5000, threaded=True)