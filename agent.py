from flask import Flask, request, jsonify
import subprocess, os, tempfile, threading, re, time, pty, select, signal
import sys

app = Flask(__name__)

# ── Load web_search helper from agent_skill/ ────────────────────────────
def _load_web_search():
    import importlib.util
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agent_skill'),
        '/sdcard/Ai-agent-script/agent_skill',
        os.path.join(get_cwd() if 'get_cwd' in globals() else os.getcwd(), 'agent_skill'),
    ]
    for d in candidates:
        fpath = os.path.join(d, 'web_search.py')
        if os.path.exists(fpath):
            try:
                spec = importlib.util.spec_from_file_location('web_search', fpath)
                mod  = importlib.util.module_from_spec(spec)
                sys.modules['web_search'] = mod
                spec.loader.exec_module(mod)
                print(f'🌐 web_search loaded from {fpath}')
                return mod
            except Exception as e:
                print(f'⚠️ web_search load fail ({fpath}): {e}')
    return None

web_search = _load_web_search()

HOME    = os.path.expanduser("~")
TMPDIR  = os.environ.get('TMPDIR') or os.path.join(HOME, '.agent_tmp')
STATE_DIR = os.path.join(TMPDIR, 'agent_state')
LOG_DIR   = os.path.join(TMPDIR, 'agent_log')
CWD_FILE  = os.path.join(STATE_DIR, 'cwd')

os.makedirs(STATE_DIR, exist_ok=True)
os.makedirs(LOG_DIR,   exist_ok=True)

if not os.path.exists(CWD_FILE):
    open(CWD_FILE,'w').write(HOME)

# No hard timeout — commands run until they finish or user kills them.
# (Input-prompt wait still has its own 60s timeout inside run_cmd_thread.)
TIMEOUT   = None
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
    'pid': None,             # current process pid (for /kill)
    'start_time': 0,         # epoch when command started
    'killed_by_user': False, # set True by /kill endpoint
    'cancel_event': None,    # threading.Event for pure-python tasks (downloads)
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
        r'\\033\[[0-9;]*[a-zA-Z]',             # literal \033[0m etc (echo -e fallback)
        r'\x07',                                # BEL
    ]
    for p in patterns:
        text = re.sub(p, '', text)
    # CR (\r) ko newline banao — progress bars / spinners jo ek hi line
    # pe overwrite karte hain, wo terminal box me alag-alag lines ban jayenge.
    text = text.replace('\r\n', '\n').replace('\r', '\n')
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

    # Publish pid + start_time so /kill endpoint can find this process.
    with session_lock:
        session['pid']            = proc.pid
        session['start_time']     = start_time
        session['killed_by_user'] = False

    while True:
        # TIMEOUT is None -> run forever until process ends or user kills it.
        if TIMEOUT is not None and (time.time() - start_time > TIMEOUT):
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
        # bash's `read -p` prints the prompt WITHOUT a trailing newline,
        # so the prompt often shares a chunk with previous menu output.
        # Check the LAST LINE only, not the whole chunk.
        stripped = clean.strip()
        _lines_now = stripped.splitlines() if stripped else []
        last_line  = _lines_now[-1].strip() if _lines_now else ''
        lower    = last_line.lower()
        is_short_line = 0 < len(last_line) < 200

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
            bool(re.search(r'overwrite\s*\?',          lower)) or
            bool(re.search(r'choice\s*\([0-9\-/a-z]+\)\s*:?\s*$', lower)) or
            bool(re.search(r'(select|enter|choose|input|chuno|daalo)[^\n]{0,40}:\s*$', lower))
        )

        # Layer 2: Generic — colon/? se end hone wala short line
        # 400ms silence check — confirm karo process block hai
        generic_prompt = is_short_line and not known_prompt and (
            bool(re.search(r'[:\?]\s*$', last_line))
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
                session['input_context'] = last_line
                session['input_event'].clear()

            got_input = session['input_event'].wait(timeout=60)

            with session_lock:
                val = session['input_value']
                session['input_value']  = None
                session['input_needed'] = False
                killed_during_wait = session.get('killed_by_user', False)

            if killed_during_wait:
                # User ne Kill dabaya input-wait ke dauraan — loop se bahar
                break
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

    with session_lock:
        killed_by_user = session.get('killed_by_user', False)

    if killed_by_user:
        partial = full_output.strip() if full_output.strip() else '(no output)'
        final = (
            "🛑 User ne Kill button dabaya — command band kar di.\n\n"
            "[Partial output]\n" + smart_truncate(partial)
        )
    elif not full_output.strip():
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
        session['running']        = True
        session['chunks']         = [f'$ {cmd}\n']
        session['done']           = False
        session['final_output']   = ''
        session['input_needed']   = False
        session['input_context']  = ''
        session['input_value']    = None
        session['input_event']    = threading.Event()  # fresh event
        session['pid']            = None
        session['start_time']     = 0
        session['killed_by_user'] = False

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
            "running":       session['running'],
            "elapsed":       (time.time() - session['start_time']) if session['running'] and session['start_time'] else 0,
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

@app.route('/kill', methods=['POST'])
def kill_running():
    """User ne terminal box ka Kill button dabaya — running process ko SIGKILL karo."""
    with session_lock:
        if not session['running']:
            return jsonify({"status": "error", "output": "❌ Koi command nahi chal rahi"})
        pid = session.get('pid')
        session['killed_by_user'] = True
        print(f"🛑 KILL requested for pid={pid}")
    # 1) Subprocess ho to usko SIGKILL karo
    if pid:
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
            print(f"🛑 SIGKILL sent to pid {pid}")
        except Exception as e:
            print(f"⚠️ kill error: {e}")
    # 2) Pure-python task (download) ho to uska cancel Event set karo
    ev = session.get('cancel_event')
    if ev is not None:
        try:
            ev.set()
            print("🛑 cancel_event set for python task")
        except Exception as e:
            print(f"⚠️ cancel_event set fail: {e}")
    # 3) Agar input wait me hai to uska event bhi set karo
    try:
        session['input_value']  = None
        session['input_needed'] = False
        session['input_event'].set()
    except Exception:
        pass
    return jsonify({"status": "ok", "output": "🛑 Kill signal bhej diya"})

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


# ── File Operation Endpoints ──────────────────────────────────────────────────

def _resolve(path):
    if not path:
        return path
    if not os.path.isabs(path):
        return os.path.join(get_cwd(), path)
    return path


@app.route('/append', methods=['POST'])
def append_file():
    """File ke end me content add karo (file na ho to bana do)."""
    data    = request.json
    path    = data.get('path', '').strip()
    content = data.get('content', '')

    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    path = _resolve(path)
    try:
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        # Smart newline: file exist karti hai, non-empty hai, aur newline pe end nahi hoti
        # to content se pehle newline insert karo — warna lines chipak jaati hain
        needs_newline = False
        if os.path.exists(path) and os.path.getsize(path) > 0:
            with open(path, 'rb') as fb:
                fb.seek(-1, os.SEEK_END)
                last_byte = fb.read(1)
                if last_byte != b'\n':
                    needs_newline = True
        with open(path, 'a', encoding='utf-8') as f:
            if needs_newline:
                f.write('\n')
            f.write(content)
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Append error: {e}"})

    size = os.path.getsize(path)
    print(f"➕ APPEND: {path} (+{len(content)} chars, now {size} bytes)")
    return jsonify({"status": "ok", "output": f"✅ Appended to {path} (now {size} bytes)"})


@app.route('/delete', methods=['POST'])
def delete_path():
    """File ya directory delete — recursive flag se dir bhi."""
    data      = request.json
    path      = data.get('path', '').strip()
    recursive = bool(data.get('recursive', False))

    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    path = _resolve(path)

    if not os.path.exists(path):
        return jsonify({"status": "error", "output": f"❌ Not found: {path}"})

    # Safety: home/root delete block
    danger = ['/', HOME, '/sdcard', '/storage']
    if os.path.abspath(path) in danger:
        return jsonify({"status": "error", "output": f"🚫 Refusing to delete protected path: {path}"})

    try:
        if os.path.isdir(path):
            if recursive:
                import shutil
                shutil.rmtree(path)
                print(f"🗑️  RMDIR -r: {path}")
                return jsonify({"status": "ok", "output": f"✅ Directory (recursive) deleted: {path}"})
            else:
                os.rmdir(path)
                print(f"🗑️  RMDIR: {path}")
                return jsonify({"status": "ok", "output": f"✅ Empty directory deleted: {path}"})
        else:
            os.remove(path)
            print(f"🗑️  RM: {path}")
            return jsonify({"status": "ok", "output": f"✅ File deleted: {path}"})
    except OSError as e:
        # Non-empty dir without recursive
        if os.path.isdir(path) and not recursive:
            return jsonify({"status": "error", "output": f"❌ Directory not empty. DELETE_DIR use karo (recursive): {e}"})
        return jsonify({"status": "error", "output": f"❌ Delete error: {e}"})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Delete error: {e}"})


@app.route('/move', methods=['POST'])
def move_path():
    """File/directory move ya rename."""
    data = request.json
    src  = data.get('src', '').strip()
    dst  = data.get('dst', '').strip()

    if not src or not dst:
        return jsonify({"status": "error", "output": "❌ src ya dst missing"})

    src = _resolve(src)
    dst = _resolve(dst)

    if not os.path.exists(src):
        return jsonify({"status": "error", "output": f"❌ Source not found: {src}"})

    try:
        import shutil
        os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
        shutil.move(src, dst)
        print(f"➡️  MOVE: {src} → {dst}")
        return jsonify({"status": "ok", "output": f"✅ Moved: {src} → {dst}"})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Move error: {e}"})


@app.route('/copy', methods=['POST'])
def copy_path():
    """File/directory copy."""
    data = request.json
    src  = data.get('src', '').strip()
    dst  = data.get('dst', '').strip()

    if not src or not dst:
        return jsonify({"status": "error", "output": "❌ src ya dst missing"})

    src = _resolve(src)
    dst = _resolve(dst)

    if not os.path.exists(src):
        return jsonify({"status": "error", "output": f"❌ Source not found: {src}"})

    try:
        import shutil
        os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        print(f"📋 COPY: {src} → {dst}")
        return jsonify({"status": "ok", "output": f"✅ Copied: {src} → {dst}"})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Copy error: {e}"})


@app.route('/list', methods=['POST'])
def list_dir():
    """Directory listing with type/size/mtime."""
    data = request.json
    path = data.get('path', '.').strip() or '.'

    path = _resolve(path)

    if not os.path.exists(path):
        return jsonify({"status": "error", "output": f"❌ Not found: {path}"})
    if not os.path.isdir(path):
        return jsonify({"status": "error", "output": f"❌ Not a directory: {path}"})

    try:
        entries = sorted(os.listdir(path))
        dirs, files = [], []
        for name in entries:
            full = os.path.join(path, name)
            try:
                st = os.stat(full)
                mtime = time.strftime('%Y-%m-%d %H:%M', time.localtime(st.st_mtime))
                if os.path.isdir(full):
                    dirs.append(f"  📁 {name}/  ({mtime})")
                else:
                    sz = st.st_size
                    if sz < 1024:
                        szstr = f"{sz}B"
                    elif sz < 1024 * 1024:
                        szstr = f"{sz/1024:.1f}K"
                    else:
                        szstr = f"{sz/1024/1024:.1f}M"
                    files.append(f"  📄 {name}  ({szstr}, {mtime})")
            except Exception:
                files.append(f"  ❓ {name}  (stat failed)")

        header = f"📂 {path}/  — {len(dirs)} dirs, {len(files)} files"
        out = [header] + dirs + files
        print(f"📂 LIST: {path} ({len(dirs)}d/{len(files)}f)")
        return jsonify({"status": "ok", "output": "\n".join(out)})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ List error: {e}"})


@app.route('/mkdir', methods=['POST'])
def make_dir():
    """Naya directory banao (parents bhi)."""
    data = request.json
    path = data.get('path', '').strip()

    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    path = _resolve(path)
    try:
        os.makedirs(path, exist_ok=True)
        print(f"📁 MKDIR: {path}")
        return jsonify({"status": "ok", "output": f"✅ Directory created: {path}"})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ mkdir error: {e}"})


@app.route('/info', methods=['POST'])
def file_info():
    """File/directory ki details (size, mode, mtime, mime)."""
    data = request.json
    path = data.get('path', '').strip()

    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    path = _resolve(path)

    if not os.path.exists(path):
        return jsonify({"status": "error", "output": f"❌ Not found: {path}"})

    try:
        st = os.stat(path)
        is_dir = os.path.isdir(path)
        info = [
            f"📄 Path: {path}",
            f"Type: {'Directory' if is_dir else 'File'}",
            f"Size: {st.st_size} bytes",
            f"Modified: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime))}",
            f"Accessed: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_atime))}",
            f"Mode: {oct(st.st_mode)}",
            f"UID/GID: {st.st_uid}/{st.st_gid}",
        ]
        if not is_dir:
            import mimetypes
            mt, _ = mimetypes.guess_type(path)
            if mt:
                info.append(f"MIME: {mt}")
        print(f"ℹ️  INFO: {path}")
        return jsonify({"status": "ok", "output": "\n".join(info)})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Info error: {e}"})


@app.route('/find', methods=['POST'])
def find_files():
    """Filename pattern (glob) se files dhundho."""
    data    = request.json
    root    = data.get('root', '.').strip() or '.'
    pattern = data.get('pattern', '*').strip() or '*'
    maxres  = int(data.get('max', 200))

    root = _resolve(root)

    if not os.path.exists(root):
        return jsonify({"status": "error", "output": f"❌ Root not found: {root}"})

    import fnmatch
    try:
        matches = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith('.')]
            for name in filenames + dirnames:
                if fnmatch.fnmatch(name, pattern):
                    matches.append(os.path.join(dirpath, name))
                    if len(matches) >= maxres:
                        break
            if len(matches) >= maxres:
                break

        if not matches:
            return jsonify({"status": "ok", "output": f"🔍 No matches for '{pattern}' in {root}"})

        out = [f"🔍 {len(matches)} match(es) for '{pattern}' in {root}:"]
        out += matches
        print(f"🔍 FIND: {pattern} in {root} → {len(matches)} hits")
        return jsonify({"status": "ok", "output": "\n".join(out)})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Find error: {e}"})


@app.route('/grep', methods=['POST'])
def grep_files():
    """Regex se file(s) ke andar text search (file ya dir)."""
    data    = request.json
    path    = data.get('path', '.').strip() or '.'
    pattern = data.get('pattern', '').strip()

    if not pattern:
        return jsonify({"status": "error", "output": "❌ pattern missing"})

    path = _resolve(path)

    if not os.path.exists(path):
        return jsonify({"status": "error", "output": f"❌ Path not found: {path}"})

    try:
        regex = re.compile(pattern)
    except re.error as e:
        return jsonify({"status": "error", "output": f"❌ Bad regex: {e}"})

    try:
        files_to_check = []
        if os.path.isfile(path):
            files_to_check = [path]
        else:
            for dirpath, dirnames, filenames in os.walk(path):
                dirnames[:] = [d for d in dirnames if not d.startswith('.')]
                for f in filenames:
                    files_to_check.append(os.path.join(dirpath, f))
                    if len(files_to_check) >= 500:
                        break
                if len(files_to_check) >= 500:
                    break

        results = []
        for fp in files_to_check:
            try:
                if os.path.getsize(fp) > 1_000_000:
                    continue
                with open(fp, 'r', encoding='utf-8', errors='replace') as fh:
                    for i, line in enumerate(fh, 1):
                        if regex.search(line):
                            snippet = line.rstrip()[:200]
                            results.append(f"{fp}:{i}: {snippet}")
                            if len(results) >= 200:
                                break
                if len(results) >= 200:
                    break
            except Exception:
                continue

        if not results:
            return jsonify({"status": "ok", "output": f"🔍 No matches for /{pattern}/ in {path}"})

        out = [f"🔍 {len(results)} match(es) for /{pattern}/ in {path}:"]
        out += results
        print(f"🔍 GREP: /{pattern}/ in {path} → {len(results)} hits")
        return jsonify({"status": "ok", "output": "\n".join(out)})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Grep error: {e}"})


@app.route('/head', methods=['POST'])
def head_file():
    """File ke pehle N lines."""
    data = request.json
    path = data.get('path', '').strip()
    n    = int(data.get('n', 10))

    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    path = _resolve(path)

    if not os.path.exists(path):
        return jsonify({"status": "error", "output": f"❌ Not found: {path}"})
    if os.path.isdir(path):
        return jsonify({"status": "error", "output": f"❌ Is a directory: {path}"})

    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            lines = []
            for i, line in enumerate(f):
                if i >= n:
                    break
                lines.append(line.rstrip('\n'))
        print(f"📄 HEAD -n {n}: {path}")
        return jsonify({"status": "ok", "output": f"📄 First {n} lines of {path}:\n\n" + "\n".join(lines)})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Head error: {e}"})


@app.route('/tail', methods=['POST'])
def tail_file():
    """File ke aakhri N lines."""
    data = request.json
    path = data.get('path', '').strip()
    n    = int(data.get('n', 10))

    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    path = _resolve(path)

    if not os.path.exists(path):
        return jsonify({"status": "error", "output": f"❌ Not found: {path}"})
    if os.path.isdir(path):
        return jsonify({"status": "error", "output": f"❌ Is a directory: {path}"})

    try:
        from collections import deque
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            lines = list(deque(f, maxlen=n))
        print(f"📄 TAIL -n {n}: {path}")
        return jsonify({"status": "ok", "output": f"📄 Last {n} lines of {path}:\n\n" + "".join(lines).rstrip()})
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ Tail error: {e}"})


@app.route('/pdf', methods=['POST'])
def generate_pdf():
    """
    Structured content se PDF banao — pdf_engine.py use karta hai.

    Body (JSON):
      {
        "path": "/sdcard/report.pdf",
        "title": "...", "subtitle": "...",
        "header": "...", "footer": "...",
        "show_page_numbers": true,
        "overwrite": true,
        "author": "...", "subject": "...",
        "content": [ {"type":"heading","text":"..."}, ... ]
      }
    """
    data = request.json or {}

    path = data.get('path', '').strip()
    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    # Relative path → CWD se resolve
    if not os.path.isabs(path):
        path = os.path.join(get_cwd(), path)

    # pdf_engine ko robustly import karo — sys.path + importlib fallback
    import sys, importlib, importlib.util

    # Try 1: normal import (agar sys.path mein pehle se hai)
    create_pdf = None
    try:
        from pdf_engine import create_pdf
    except ImportError:
        pass

    # Try 2: script dir + cwd sys.path mein daalo
    if create_pdf is None:
        candidates = [
            os.path.dirname(os.path.abspath(__file__)),
            '/sdcard/Ai-agent-script',
            os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agent_skill'),
            '/sdcard/Ai-agent-script/agent_skill',
            get_cwd(),
        ]
        for d in candidates:
            if d and d not in sys.path:
                sys.path.insert(0, d)
        try:
            from pdf_engine import create_pdf
        except ImportError:
            pass

    # Try 3: importlib direct file load — koi sys.path dependency nahi
    if create_pdf is None:
        for d in candidates:
            fpath = os.path.join(d, 'pdf_engine.py')
            if os.path.exists(fpath):
                try:
                    spec = importlib.util.spec_from_file_location('pdf_engine', fpath)
                    mod  = importlib.util.module_from_spec(spec)
                    sys.modules['pdf_engine'] = mod
                    spec.loader.exec_module(mod)
                    create_pdf = mod.create_pdf
                    print(f"📦 pdf_engine loaded via importlib from {fpath}")
                    break
                except Exception as e:
                    print(f"⚠️ importlib load fail ({fpath}): {e}")

    if create_pdf is None:
        return jsonify({
            "status": "error",
            "output": "❌ pdf_engine import fail — file /sdcard/Ai-agent-script/pdf_engine.py check karo"
        })

    content = data.get('content') or []
    if not isinstance(content, list):
        return jsonify({"status": "error", "output": "❌ 'content' must be a list of dicts"})

    # Agar content empty hai aur title/subtitle bhi nahi — reject
    if not content and not data.get('title') and not data.get('subtitle'):
        return jsonify({"status": "error", "output": "❌ PDF ke liye 'content' ya 'title'/'subtitle' chahiye"})

    try:
        result = create_pdf(
            output=path,
            content=content,
            title=data.get('title'),
            subtitle=data.get('subtitle'),
            header=data.get('header'),
            footer=data.get('footer'),
            show_page_numbers=bool(data.get('show_page_numbers', True)),
            overwrite=bool(data.get('overwrite', False)),
            author=data.get('author'),
            subject=data.get('subject'),
        )
    except Exception as e:
        return jsonify({"status": "error", "output": f"❌ PDF engine exception: {e}"})

    if result.get('status') == 'ok':
        size   = result.get('size', 0)
        warns  = result.get('warnings') or []
        out    = f"✅ PDF created: {result.get('path')} ({size} bytes)"
        if warns:
            out += "\n⚠️ Warnings:\n  - " + "\n  - ".join(warns)
        print(f"📕 PDF: {result.get('path')} ({size}B, {len(warns)} warnings)")
        return jsonify({"status": "ok", "output": out})
    else:
        msg = result.get('message', 'unknown error')
        tb  = result.get('traceback', '')
        out = f"❌ PDF failed: {msg}"
        if tb:
            out += f"\n\n{tb}"
        print(f"❌ PDF failed: {msg}")
        return jsonify({"status": "error", "output": out})


@app.route('/search', methods=['POST'])
def web_search_endpoint():
    """
    DuckDuckGo search.
    Body: {"query": "...", "num": 10}
    """
    if web_search is None:
        return jsonify({"status": "error",
                        "output": "❌ web_search module load nahi hua — agent_skill/web_search.py check karo"})

    data  = request.json or {}
    query = (data.get('query') or '').strip()
    num   = int(data.get('num', 10))

    if not query:
        return jsonify({"status": "error", "output": "❌ query missing"})

    results, err = web_search.search(query, num=num)
    if err:
        return jsonify({"status": "error", "output": err})

    out = [f"🔍 {len(results)} results for: {query}", ""]
    for i, r in enumerate(results, 1):
        out.append(f"{i}. {r['title']}")
        out.append(f"   🔗 {r['url']}")
        if r.get('snippet'):
            out.append(f"   {r['snippet']}")
        out.append("")
    print(f"🔍 SEARCH: {query} -> {len(results)} results")
    return jsonify({"status": "ok", "output": "\n".join(out).rstrip()})


@app.route('/download', methods=['POST'])
def download_endpoint():
    """
    Download a URL to a local path, streaming with progress.
    Body: {"url": "...", "path": "/sdcard/...", "overwrite": false}
    """
    if web_search is None:
        return jsonify({"status": "error",
                        "output": "❌ web_search module load nahi hua"})

    data      = request.json or {}
    url       = (data.get('url') or '').strip()
    path      = (data.get('path') or '').strip()
    overwrite = bool(data.get('overwrite', False))

    if not url:
        return jsonify({"status": "error", "output": "❌ url missing"})
    if not path:
        return jsonify({"status": "error", "output": "❌ path missing"})

    if not os.path.isabs(path):
        path = os.path.join(get_cwd(), path)

    # Publish a small 'running' flag so the client shows the terminal box
    with session_lock:
        if session['running']:
            return jsonify({"status": "busy",
                            "output": "⚠️ Ek command already chal rahi hai"})
        session['running']       = True
        session['chunks']        = [f'⬇️  Downloading {url}\n', f'📁 → {path}\n']
        session['done']          = False
        session['final_output']  = ''
        session['input_needed']  = False
        session['input_context'] = ''
        session['input_value']   = None
        session['input_event']   = threading.Event()
        session['pid']            = None
        session['start_time']     = time.time()
        session['killed_by_user'] = False
        session['cancel_event']   = threading.Event()

    cancel_ev = session['cancel_event']

    def _progress(done, total):
        if total > 0:
            pct = done * 100 // total
            line = f'  {done:>10,} / {total:>10,} bytes  ({pct}%)'
        else:
            line = f'  {done:>10,} bytes downloaded'
        with session_lock:
            session['chunks'].append(line)

    def _worker():
        try:
            result = web_search.download(
                url=url, dest=path, overwrite=overwrite,
                progress_cb=_progress,
                cancel_check=cancel_ev.is_set,
            )
        except Exception as e:
            result = {'status': 'error', 'message': f'❌ Exception: {e}'}

        with session_lock:
            killed = session.get('killed_by_user', False)
            if killed or result.get('cancelled'):
                final = result.get('message') or '🛑 User ne Kill button dabaya — download band kar di.'
            else:
                final = result.get('message', 'done')
            session['chunks'].append('\n' + final + '\n')
            session['final_output'] = final
            session['done']         = True
            session['running']      = False
            session['cancel_event'] = None

    threading.Thread(target=_worker, daemon=True).start()
    return jsonify({"status": "started"})


if __name__ == '__main__':
    print("╔══════════════════════════════════════════╗")
    print("║     🤖  Termux AI Agent Server           ║")
    print("╠══════════════════════════════════════════╣")
    print(f"║  CWD    : {get_cwd()[:30]:<30}║")
    tstr = f"{TIMEOUT}s" if TIMEOUT else "none (KILL)"
    print(f"║  Timeout: {tstr:<32}║")
    print("╠══════════════════════════════════════════╣")
    print("║  HTTP  : localhost:5000                  ║")
    print("║  Poll  : localhost:5000/poll             ║")
    print("╚══════════════════════════════════════════╝")
    app.run(host='0.0.0.0', port=5000, threaded=True)