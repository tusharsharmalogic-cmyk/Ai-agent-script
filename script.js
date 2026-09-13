// ==UserScript==
// @name         Termux AI Agent+ (DeepSeek + Claude + ChatGPT)
// @namespace    termux-agent
// @version      17.6
// @updateURL    https://raw.githubusercontent.com/tusharsharmalogic-cmyk/Ai-agent-script/main/script.js
// @downloadURL  https://raw.githubusercontent.com/tusharsharmalogic-cmyk/Ai-agent-script/main/script.js
// @match        *://chat.deepseek.com/*
// @match        *://claude.ai/*
// @match        *://gemini.google.com/*
// @match        *://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';

    // ── Site Detection ────────────────────────────────────────────────────────
    const IS_CLAUDE   = location.hostname === 'claude.ai';
    const IS_DEEPSEEK = location.hostname === 'chat.deepseek.com';
    const IS_GEMINI   = location.hostname === 'gemini.google.com';
    const IS_CHATGPT  = location.hostname === 'chatgpt.com';

    let processedFps   = new Set();
    let lastAIMsgCount = -1;
    let lastTextSeen   = '';
    let stableCount    = 0;
    let isRunning      = false;
    let pollInterval   = null;
    let inputPending   = false;
    let runTimeout     = null;
    let execCounter    = 0;
    let termOverlay    = null;   // live terminal box (shown after 10s)
    let termShownAt    = 0;
    let lastTermChunk  = '';

    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
    ).set;

    // ── Input UI Overlay ──────────────────────────────────────────────────────
    const OVERLAY_ID = 'termux-agent-input-overlay';

    function showInputOverlay(context) {
        // Purana overlay hata do agar hai
        let existing = document.getElementById(OVERLAY_ID);
        if (existing) existing.remove();

        let overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.6);
            z-index: 999999;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            font-family: monospace;
            padding-top: 12px;
        `;

        let box = document.createElement('div');
        box.style.cssText = `
            background: #1e1e2e;
            border: 1.5px solid #444;
            border-radius: 10px;
            padding: 18px 16px;
            width: 96vw;
            max-width: 480px;
            box-sizing: border-box;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            color: #cdd6f4;
        `;

        let title = document.createElement('div');
        title.textContent = '⌨️ Terminal Input Required';
        title.style.cssText = 'font-size:14px; font-weight:bold; margin-bottom:12px; color:#cba6f7;';

        let ctx = document.createElement('div');
        ctx.textContent = context || 'Program waiting for input...';
        ctx.style.cssText = `
            background: #181825;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 13px;
            color: #a6e3a1;
            margin-bottom: 16px;
            word-break: break-all;
            max-height: 80px;
            overflow-y: auto;
        `;

        let input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Type your response...';
        input.style.cssText = `
            width: 100%;
            box-sizing: border-box;
            background: #181825;
            border: 1px solid #555;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 14px;
            color: #cdd6f4;
            outline: none;
            margin-bottom: 14px;
        `;

        let btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:10px; justify-content:flex-end;';

        let cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `
            background: #313244;
            color: #cdd6f4;
            border: none;
            border-radius: 6px;
            padding: 7px 18px;
            cursor: pointer;
            font-size: 13px;
        `;

        let sendBtn = document.createElement('button');
        sendBtn.textContent = 'Send ↵';
        sendBtn.style.cssText = `
            background: #cba6f7;
            color: #1e1e2e;
            border: none;
            border-radius: 6px;
            padding: 7px 18px;
            cursor: pointer;
            font-size: 13px;
            font-weight: bold;
        `;

        function submitInput() {
            let val = input.value;
            overlay.remove();
            inputPending = false;
            sendInputToServer(val);
        }

        function cancelInput() {
            overlay.remove();
            inputPending = false;
            sendInputToServer('');  // empty → server side timeout handle karega
        }

        sendBtn.onclick = submitInput;
        cancelBtn.onclick = cancelInput;
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitInput();
            if (e.key === 'Escape') cancelInput();
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(sendBtn);
        box.appendChild(title);
        box.appendChild(ctx);
        box.appendChild(input);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // Auto-focus input
        setTimeout(() => input.focus(), 50);
    }

    function sendInputToServer(value) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:5000/input',
            headers: {'Content-Type': 'application/json'},
            data: JSON.stringify({value: value}),
            onload: function(r) {
                console.log('✅ Input sent to server:', value);
            },
            onerror: function() {
                console.error('❌ Input send failed');
                isRunning = false;
                sendToAI('❌ Input server tak nahi pahuncha.');
            }
        });
    }

    // ── Live Terminal Overlay ─────────────────────────────────────────────────
    const TERM_ID = 'termux-agent-terminal-overlay';

    function showTerminalOverlay() {
        if (document.getElementById(TERM_ID)) return;

        let ov = document.createElement('div');
        ov.id = TERM_ID;
        ov.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.65);
            z-index: 999998;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            font-family: monospace;
            padding: 10px 8px;
        `;

        let box = document.createElement('div');
        box.style.cssText = `
            background: #11111b;
            border: 1.5px solid #f38ba8;
            border-radius: 10px;
            width: 96vw;
            max-width: 640px;
            box-sizing: border-box;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6);
            color: #cdd6f4;
            display: flex;
            flex-direction: column;
            max-height: 70vh;
            overflow: hidden;
        `;

        let hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#181825;border-bottom:1px solid #313244;';
        let hLeft = document.createElement('div');
        hLeft.textContent = '🖥️ Live Command';
        hLeft.style.cssText = 'font-size:13px;font-weight:bold;color:#f38ba8;';
        let hTimer = document.createElement('div');
        hTimer.id = TERM_ID + '-timer';
        hTimer.textContent = '0s';
        hTimer.style.cssText = 'font-size:12px;color:#a6e3a1;font-weight:bold;';
        hdr.appendChild(hLeft);
        hdr.appendChild(hTimer);

        let pre = document.createElement('pre');
        pre.id = TERM_ID + '-out';
        pre.style.cssText = `
            margin: 0;
            padding: 10px 12px;
            font-size: 12px;
            line-height: 1.35;
            color: #a6e3a1;
            background: #0b0b12;
            white-space: pre-wrap;
            word-break: break-all;
            overflow-y: auto;
            flex: 1;
            min-height: 120px;
            max-height: 55vh;
        `;

        let footer = document.createElement('div');
        footer.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;padding:10px 12px;background:#181825;border-top:1px solid #313244;';

        let killBtn = document.createElement('button');
        killBtn.textContent = '🛑 Kill';
        killBtn.style.cssText = `
            background: #f38ba8;
            color: #11111b;
            border: none;
            border-radius: 6px;
            padding: 8px 22px;
            font-size: 13px;
            font-weight: bold;
            cursor: pointer;
        `;
        killBtn.onclick = killRunningCommand;

        footer.appendChild(killBtn);
        box.appendChild(hdr);
        box.appendChild(pre);
        box.appendChild(footer);
        ov.appendChild(box);
        document.body.appendChild(ov);

        termOverlay = ov;
        termShownAt = Date.now();
    }

    function updateTerminalOverlay(chunks) {
        // Always accumulate chunks — even before the overlay box opens.
        // (Otherwise pre-10s output is lost and the box looks empty.)
        for (let c of chunks) {
            lastTermChunk += c;
        }
        // Keep last ~400 lines for perf
        let lines = lastTermChunk.split('\n');
        if (lines.length > 400) {
            lines = lines.slice(lines.length - 400);
            lastTermChunk = lines.join('\n');
        }
        // If overlay not open yet, we're done — chunks are buffered.
        if (!termOverlay) return;
        let pre = document.getElementById(TERM_ID + '-out');
        if (!pre) return;
        pre.textContent = lastTermChunk;
        pre.scrollTop = pre.scrollHeight;

        let t = document.getElementById(TERM_ID + '-timer');
        if (t) {
            let sec = Math.floor((Date.now() - termShownAt) / 1000);
            t.textContent = sec + 's';
        }
    }

    function hideTerminalOverlay() {
        if (termOverlay) { termOverlay.remove(); }
        termOverlay = null;
        termShownAt = 0;
        lastTermChunk = '';
    }

    function killRunningCommand() {
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:5000/kill',
            headers: {'Content-Type': 'application/json'},
            data: '{}',
            onload: function(r) {
                console.log('🛑 Kill response:', r.responseText);
            },
            onerror: function() {
                console.error('❌ Kill request failed');
            }
        });
    }

    // ── Polling ───────────────────────────────────────────────────────────────
    function startPolling() {
        if (pollInterval) return;

        pollInterval = setInterval(() => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'http://localhost:5000/poll',
                onload: function(r) {
                    try {
                        let data = JSON.parse(r.responseText);

                        // Live chunks → feed to terminal overlay
                        if (data.chunks && data.chunks.length) {
                            updateTerminalOverlay(data.chunks);
                        }

                        // After 10s of running → auto-show terminal overlay
                        if (data.running && !termOverlay && data.elapsed && data.elapsed > 10) {
                            showTerminalOverlay();
                            if (lastTermChunk) {
                                let pre = document.getElementById(TERM_ID + '-out');
                                if (pre) { pre.textContent = lastTermChunk; pre.scrollTop = pre.scrollHeight; }
                            }
                        }

                        if (data.input_needed && !inputPending) {
                            inputPending = true;
                            showInputOverlay(data.input_context);
                        }

                        if (data.done) {
                            clearInterval(pollInterval);
                            pollInterval  = null;
                            inputPending  = false;
                            if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
                            hideTerminalOverlay();
                            // Input overlay bhi hata do agar khula hua hai
                            let inpOv = document.getElementById(OVERLAY_ID);
                            if (inpOv) inpOv.remove();
                            sendToAI(data.final_output);
                        }
                    } catch(e) {
                        console.error('❌ Poll response parse error:', e, '| Raw:', r.responseText);
                    }
                },
                onerror: function() {
                    console.error('❌ Poll request failed — server unreachable');
                    clearInterval(pollInterval);
                    pollInterval = null;
                    if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
                    hideTerminalOverlay();
                    isRunning = false;
                    sendToAI('❌ Server se connection toot gaya polling ke dauraan.');
                }
            });
        }, 500);
    }

    // ── Send to AI ────────────────────────────────────────────────────────────
    function sendToAI(output) {
        if (IS_CLAUDE) {
            sendToClaude(output);
        } else if (IS_GEMINI) {
            sendToGemini(output);
        } else if (IS_CHATGPT) {
            sendToChatGPT(output);
        } else {
            sendToDeepSeek(output);
        }
    }

    // ── insertTextIntoEditor ──────────────────────────────────────────────────
    function insertTextIntoEditor(editor, text) {
        try {
            editor.focus();
            let range = document.createRange();
            range.selectNodeContents(editor);
            let sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            let deleted = document.execCommand('delete', false, null);
            let inserted = document.execCommand('insertText', false, text);
            if (inserted && editor.textContent.trim()) return true;
        } catch(e) {
            console.warn('execCommand failed, trying fallback:', e);
        }

        try {
            editor.focus();
            editor.innerHTML = '';
            const inputEvent = new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                data: text,
                inputType: 'insertText'
            });
            editor.textContent = text;
            editor.dispatchEvent(inputEvent);
            editor.dispatchEvent(new Event('change', { bubbles: true }));
            if (editor.textContent.trim()) return true;
        } catch(e) {
            console.warn('InputEvent fallback failed:', e);
        }

        try {
            editor.innerHTML = '';
            editor.textContent = text;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
            return editor.textContent.trim().length > 0;
        } catch(e) {
            console.error('All text insertion methods failed:', e);
            return false;
        }
    }

    // ── Claude sender ─────────────────────────────────────────────────────────
    function sendToClaude(output) {
        let editor = document.querySelector('.ProseMirror');
        if (!editor) {
            console.error('❌ Claude ProseMirror editor nahi mila. Page reload karo.');
            isRunning = false;
            return;
        }

        let success = insertTextIntoEditor(editor, output);
        if (!success) {
            console.error('❌ Claude editor mein text insert nahi hua');
            isRunning = false;
            return;
        }

        editor.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true}));

        setTimeout(() => {
            let sendBtn = document.querySelector('button[aria-label="Send message"]');
            if (sendBtn) {
                sendBtn.click();
                console.log('✅ Claude ko send kiya!');
            } else {
                console.log('❌ Claude send button nahi mila');
                isRunning = false;
                return;
            }
            setTimeout(() => { isRunning = false; }, 3000);
        }, 1000);
    }

    // ── Gemini sender ─────────────────────────────────────────────────────────
    function sendToGemini(output) {
        let editor = document.querySelector('rich-textarea div[contenteditable="true"]')
                  || document.querySelector('.ql-editor[contenteditable="true"]')
                  || document.querySelector('div[contenteditable="true"][role="textbox"]')
                  || document.querySelector('div[contenteditable="true"]');

        if (!editor) {
            console.log('❌ Gemini editor not found');
            isRunning = false;
            return;
        }

        let success = insertTextIntoEditor(editor, output);
        if (!success) {
            console.error('❌ Gemini editor mein text insert nahi hua');
            isRunning = false;
            return;
        }

        editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));

        setTimeout(() => {
            let sendBtn = document.querySelector('button[aria-label="Send message"]');
            if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                console.log('✅ Gemini ko send kiya!');
            } else {
                let fallback = document.querySelector('button[data-mat-icon-name="arrow_upward"]')
                            || document.querySelector('button mat-icon[data-mat-icon-name="arrow_upward"]')?.closest('button');
                if (fallback) {
                    fallback.click();
                    console.log('✅ Gemini fallback send kiya!');
                } else {
                    console.log('❌ Gemini send button nahi mila');
                    sendToAI('❌ Gemini send button nahi mila.');
                }
            }
            setTimeout(() => { isRunning = false; }, 3000);
        }, 1000);
    }

    // ── DeepSeek sender ───────────────────────────────────────────────────────
    function sendToDeepSeek(output) {
        const textarea = document.querySelector('textarea[placeholder="Message DeepSeek"]');
        if (!textarea) { isRunning = false; return; }

        valueSetter.call(textarea, output);
        textarea.dispatchEvent(new InputEvent('input', {bubbles: true}));

        setTimeout(() => {
            let clicked = false;

            let btn1 = document.querySelector('button[aria-label*="Send"]')
                    || document.querySelector('button[aria-label*="send"]')
                    || document.querySelector('div[role="button"][aria-label*="Send"]');
            if (btn1 && !btn1.disabled) { btn1.click(); clicked = true; }

            if (!clicked) {
                let btn2 = document.querySelector('[data-testid*="send" i]')
                        || document.querySelector('[data-testid*="submit" i]');
                if (btn2) { btn2.click(); clicked = true; }
            }

            if (!clicked) {
                let btn3 = document.querySelector('button[type="submit"]');
                if (btn3 && !btn3.disabled) { btn3.click(); clicked = true; }
            }

            if (!clicked) {
                let allPaths = document.querySelectorAll('path[d*="M8.3125"]');
                for (let path of allPaths) {
                    let btn = path.closest('div[role="button"]');
                    if (btn) { btn.click(); clicked = true; break; }
                }
            }

            if (!clicked) {
                console.log('❌ DeepSeek send button nahi mila (saare selectors fail)');
                sendToAI('❌ DeepSeek send button nahi mila.');
            }

            setTimeout(() => { isRunning = false; }, 3000);
        }, 1500);
    }

    // ── ChatGPT Sender ────────────────────────────────────────────────────────
    function sendToChatGPT(output) {
        const editor = document.querySelector('div#prompt-textarea[contenteditable="true"]');
        if (!editor) { isRunning = false; return; }

        let success = insertTextIntoEditor(editor, output);
        if (!success) {
            editor.textContent = output;
            editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
        }

        setTimeout(() => {
            let clicked = false;

            let btn1 = document.querySelector('button#composer-submit-button[data-testid="send-button"]');
            if (btn1 && btn1.getAttribute('aria-disabled') !== 'true') { btn1.click(); clicked = true; }

            if (!clicked) {
                let btn2 = document.querySelector('[data-testid="send-button"]');
                if (btn2 && btn2.getAttribute('aria-disabled') !== 'true') { btn2.click(); clicked = true; }
            }

            if (!clicked) {
                let btn3 = document.querySelector('button[aria-label="Send prompt"]');
                if (btn3 && btn3.getAttribute('aria-disabled') !== 'true') { btn3.click(); clicked = true; }
            }

            if (!clicked) {
                console.log('❌ ChatGPT send button nahi mila');
                sendToAI('❌ ChatGPT send button nahi mila.');
            }

            setTimeout(() => { isRunning = false; }, 3000);
        }, 1000);
    }

    // ── Read File ─────────────────────────────────────────────────────────────
    function readFile(path) {
        isRunning = true;
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:5000/read',
            headers: {'Content-Type': 'application/json'},
            data: JSON.stringify({path: path}),
            onload: function(r) {
                try {
                    let data = JSON.parse(r.responseText);
                    isRunning = false;
                    setTimeout(() => { sendToAI(data.output || '❌ No output received'); }, 500);
                } catch(e) {
                    console.error('❌ Read parse error:', e, '| Raw:', r.responseText);
                    isRunning = false;
                    sendToAI('❌ Read parse error');
                }
            },
            onerror: function() {
                isRunning = false;
                sendToAI('❌ Read request failed');
            }
        });
    }

    // ── Edit File ─────────────────────────────────────────────────────────────
    function editFile(path, oldStr, newStr) {
        isRunning = true;
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:5000/edit',
            headers: {'Content-Type': 'application/json'},
            data: JSON.stringify({path: path, old_str: oldStr, new_str: newStr}),
            onload: function(r) {
                try {
                    let data = JSON.parse(r.responseText);
                    isRunning = false;
                    setTimeout(() => { sendToAI(data.output || '❌ No output received'); }, 500);
                } catch(e) {
                    console.error('❌ Edit parse error:', e, '| Raw:', r.responseText);
                    isRunning = false;
                    sendToAI('❌ Edit parse error');
                }
            },
            onerror: function() {
                isRunning = false;
                sendToAI('❌ Edit request failed');
            }
        });
    }

    // ── Write File ────────────────────────────────────────────────────────────
    function writeFile(path, content) {
        isRunning = true;
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:5000/write',
            headers: {'Content-Type': 'application/json'},
            data: JSON.stringify({path: path, content: content}),
            onload: function(r) {
                try {
                    let data = JSON.parse(r.responseText);
                    isRunning = false;
                    setTimeout(() => { sendToAI(data.output || '❌ No output received'); }, 500);
                } catch(e) {
                    console.error('❌ Write parse error:', e, '| Raw:', r.responseText);
                    isRunning = false;
                    sendToAI('❌ Write parse error');
                }
            },
            onerror: function() {
                isRunning = false;
                sendToAI('❌ Write request failed');
            }
        });
    }

    // ── Generic JSON endpoint helper ──────────────────────────────────────────
    function callEndpoint(endpoint, payload) {
        isRunning = true;
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:5000' + endpoint,
            headers: {'Content-Type': 'application/json'},
            data: JSON.stringify(payload),
            onload: function(r) {
                try {
                    let data = JSON.parse(r.responseText);
                    isRunning = false;
                    setTimeout(() => { sendToAI(data.output || '❌ No output received'); }, 500);
                } catch(e) {
                    console.error('❌ ' + endpoint + ' parse error:', e, '| Raw:', r.responseText);
                    isRunning = false;
                    sendToAI('❌ Parse error from ' + endpoint);
                }
            },
            onerror: function() {
                isRunning = false;
                sendToAI('❌ ' + endpoint + ' request failed');
            }
        });
    }

    function appendFile(path, content)  { callEndpoint('/append', {path, content}); }
    function deletePath(path, recur)    { callEndpoint('/delete', {path, recursive: recur}); }
    function movePath(src, dst)         { callEndpoint('/move',   {src, dst}); }
    function copyPath(src, dst)         { callEndpoint('/copy',   {src, dst}); }
    function listDir(path)              { callEndpoint('/list',   {path}); }
    function makeDir(path)              { callEndpoint('/mkdir',  {path}); }
    function fileInfo(path)             { callEndpoint('/info',   {path}); }
    function findFile(root, pattern)    { callEndpoint('/find',   {root, pattern}); }
    function grepFile(pattern, path)    { callEndpoint('/grep',   {pattern, path}); }
    function headFile(path, n)          { callEndpoint('/head',   {path, n}); }
    function tailFile(path, n)          { callEndpoint('/tail',   {path, n}); }
    function pdfCreate(spec)            { callEndpoint('/pdf',    spec); }

    // ── Run Command ───────────────────────────────────────────────────────────
    function runCommand(cmd) {
        isRunning    = true;
        inputPending = false;
        hideTerminalOverlay();
        if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:5000/run',
            headers: {'Content-Type': 'application/json'},
            data: JSON.stringify({cmd: cmd}),
            onload: function(r) {
                try {
                    let data = JSON.parse(r.responseText);
                    if (data.status === 'started') {
                        startPolling();
                    } else {
                        if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
                        isRunning = false;
                        sendToAI(data.output || '❌ Error');
                    }
                } catch(e) {
                    console.error('❌ Run parse error:', e, '| Raw:', r.responseText);
                    if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
                    isRunning = false;
                    sendToAI('❌ Parse error');
                }
            },
            onerror: function() {
                if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
                isRunning = false;
                sendToAI('❌ Server connect nahi hua.');
            }
        });

        // No client-side timeout — server runs until done or user kills.
        // A 90s safety net remains in case the server becomes unresponsive,
        // but it only fires if polling itself has already died.
        runTimeout = setTimeout(() => {
            runTimeout = null;
            if (isRunning && !pollInterval) {
                hideTerminalOverlay();
                isRunning = false;
                sendToAI('❌ Server polling toot gaya — koi response nahi mila.');
            }
        }, 90000);
    }

    // ── AI Message Detection ──────────────────────────────────────────────────
    function getAssistantMsgCount() {
        if (IS_CLAUDE) {
            for (let sel of ['[data-testid="assistant-message"]', '.font-claude-message', '.group.relative.relative']) {
                let n = document.querySelectorAll(sel).length;
                if (n) return n;
            }
            return 0;
        } else if (IS_CHATGPT) {
            return document.querySelectorAll('[data-message-author-role="assistant"]').length;
        } else if (IS_GEMINI) {
            return document.querySelectorAll('model-response').length;
        } else {
            return document.querySelectorAll('.ds-markdown.ds-assistant-message-main-content').length;
        }
    }

    function getLastAIMessage() {
        if (IS_CLAUDE) {
            const SELECTORS = [
                '[data-testid="assistant-message"]',
                '.font-claude-message',
                '.group.relative.relative',
            ];
            for (let sel of SELECTORS) {
                let msgs = document.querySelectorAll(sel);
                if (msgs.length) return msgs[msgs.length - 1];
            }

            let allPres = document.querySelectorAll('pre');
            if (allPres.length) {
                let lastPre = allPres[allPres.length - 1];
                let el = lastPre.parentElement;
                let depth = 0;
                while (el && el.tagName !== 'BODY' && depth < 12) {
                    let style = window.getComputedStyle(el);
                    if (el.tagName === 'DIV' &&
                        el.querySelectorAll('pre').length === 1 &&
                        style.display !== 'inline') {
                        let parent = el.parentElement;
                        if (parent && parent.children.length >= 2) {
                            return el;
                        }
                    }
                    el = el.parentElement;
                    depth++;
                }
                return lastPre;
            }
            return null;
        } else if (IS_CHATGPT) {
            let msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (msgs.length) return msgs[msgs.length - 1];

            let paras = document.querySelectorAll('p[data-start][data-end]');
            if (!paras.length) return null;
            let last = paras[paras.length - 1];
            let el = last.parentElement;
            let depth = 0;
            while (el && el.tagName !== 'BODY' && depth < 8) {
                if (el.tagName === 'DIV' && el.querySelectorAll('p[data-start]').length > 0) {
                    return el;
                }
                el = el.parentElement;
                depth++;
            }
            return last;
        } else if (IS_GEMINI) {
            let containers = document.querySelectorAll('model-response');
            if (containers.length) return containers[containers.length - 1];

            let paras = document.querySelectorAll('p[data-path-to-node]');
            if (!paras.length) return null;
            let last = paras[paras.length - 1];
            let el = last.parentElement;
            let depth = 0;
            while (el && el.tagName !== 'BODY' && depth < 8) {
                if (el.tagName === 'DIV' && el.querySelectorAll('p[data-path-to-node]').length > 0) {
                    return el;
                }
                el = el.parentElement;
                depth++;
            }
            return last;
        } else {
            let msgs = document.querySelectorAll('.ds-markdown.ds-assistant-message-main-content');
            if (!msgs.length) return null;
            return msgs[msgs.length - 1];
        }
    }

    function extractAction(el) {
        let blocks = [];
        let pres = el.querySelectorAll('pre');
        if (pres.length) {
            blocks = Array.from(pres);
        } else if (IS_CHATGPT) {
            blocks = Array.from(el.querySelectorAll('p[data-start], code, pre'));
        } else if (IS_GEMINI) {
            blocks = Array.from(el.querySelectorAll('p[data-path-to-node], code, p'));
        }

        for (let i = blocks.length - 1; i >= 0; i--) {
            let codeEl = blocks[i].querySelector('code');
            let text = (codeEl ? codeEl.textContent : blocks[i].innerText || blocks[i].textContent).trim();
            if (!text) continue;

            text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

            let readMatch = text.match(/^READ_FILE:\s*(.+)$/m);
            if (readMatch) return {type: 'read', path: readMatch[1].trim(), fp: text};

            let appendMatch = text.match(/WRITE_FILE:\s*(.+?)\nAPPEND_MODE\s*\n<{1,3}\n([\s\S]*?)\n>{1,3}\s*(?:$|\n)/);
            if (!appendMatch) appendMatch = text.match(/^APPEND_FILE:\s*(.+?)\n<{1,3}\n([\s\S]*?)\n>{1,3}\s*(?:$|\n)/m);
            if (appendMatch) {
                return {type: 'append', path: appendMatch[1].trim(), content: appendMatch[2], fp: text};
            }

            let deleteDirMatch = text.match(/^DELETE_DIR:\s*(.+)$/m);
            if (deleteDirMatch) return {type: 'delete', path: deleteDirMatch[1].trim(), recursive: true, fp: text};

            let deleteFileMatch = text.match(/^DELETE_FILE:\s*(.+)$/m);
            if (deleteFileMatch) return {type: 'delete', path: deleteFileMatch[1].trim(), recursive: false, fp: text};

            let moveMatch = text.match(/^MOVE_FILE:\s*(.+?)\s*(?:->|=>|→)\s*(.+)$/m);
            if (!moveMatch) moveMatch = text.match(/^MOVE_FILE:\s*(.+?)\n(?:TO|DST|DESTINATION):\s*(.+)$/m);
            if (moveMatch) return {type: 'move', src: moveMatch[1].trim(), dst: moveMatch[2].trim(), fp: text};

            let copyMatch = text.match(/^COPY_FILE:\s*(.+?)\s*(?:->|=>|→)\s*(.+)$/m);
            if (!copyMatch) copyMatch = text.match(/^COPY_FILE:\s*(.+?)\n(?:TO|DST|DESTINATION):\s*(.+)$/m);
            if (copyMatch) return {type: 'copy', src: copyMatch[1].trim(), dst: copyMatch[2].trim(), fp: text};

            let listMatch = text.match(/^LIST_DIR:\s*(.+)$/m);
            if (listMatch) return {type: 'list', path: listMatch[1].trim(), fp: text};

            let mkdirMatch = text.match(/^MAKE_DIR:\s*(.+)$/m);
            if (mkdirMatch) return {type: 'mkdir', path: mkdirMatch[1].trim(), fp: text};

            let infoMatch = text.match(/^FILE_INFO:\s*(.+)$/m);
            if (infoMatch) return {type: 'info', path: infoMatch[1].trim(), fp: text};

            let findMatch = text.match(/^FIND_FILE:\s*(.+?)\s*\|\s*(.+)$/m);
            if (!findMatch) findMatch = text.match(/^FIND_FILE:\s*(.+)$/m);
            if (findMatch) {
                if (findMatch[2]) {
                    return {type: 'find', root: findMatch[1].trim(), pattern: findMatch[2].trim(), fp: text};
                } else {
                    return {type: 'find', root: '.', pattern: findMatch[1].trim(), fp: text};
                }
            }

            let grepMatch = text.match(/^GREP:\s*(.+?)\s*\|\s*(.+)$/m);
            if (!grepMatch) grepMatch = text.match(/^GREP:\s*(.+)$/m);
            if (grepMatch) {
                if (grepMatch[2]) {
                    return {type: 'grep', pattern: grepMatch[1].trim(), path: grepMatch[2].trim(), fp: text};
                } else {
                    return {type: 'grep', pattern: grepMatch[1].trim(), path: '.', fp: text};
                }
            }

            let headMatch = text.match(/^HEAD:\s*(.+?)(?:\s*\|\s*(?:N\s*=\s*)?(\d+))?$/m);
            if (headMatch) {
                return {type: 'head', path: headMatch[1].trim(), n: headMatch[2] ? parseInt(headMatch[2], 10) : 10, fp: text};
            }

            let tailMatch = text.match(/^TAIL:\s*(.+?)(?:\s*\|\s*(?:N\s*=\s*)?(\d+))?$/m);
            if (tailMatch) {
                return {type: 'tail', path: tailMatch[1].trim(), n: tailMatch[2] ? parseInt(tailMatch[2], 10) : 10, fp: text};
            }

            let editMatch = text.match(
                /EDIT_FILE:\s*(.+?)\nOLD_STR\s*\n<{1,3}\n([\s\S]*?)\n>{1,3}\s*\nNEW_STR\s*\n<{1,3}\n([\s\S]*?)\n>{1,3}\s*(?:$|\n)/
            );
            if (editMatch) {
                return {type: 'edit', path: editMatch[1].trim(), oldStr: editMatch[2], newStr: editMatch[3], fp: text};
            }

            let writeMatch = text.match(/WRITE_FILE:\s*(.+?)\n<{1,3}\n([\s\S]*?)\n>{1,3}\s*(?:$|\n)/);
            if (writeMatch) {
                return {type: 'write', path: writeMatch[1].trim(), content: writeMatch[2], fp: text};
            }

            let pdfMatch = text.match(/^PDF_CREATE:\s*(.+?)\n<{1,3}\n([\s\S]*?)\n>{1,3}\s*(?:$|\n)/);
            if (pdfMatch) {
                try {
                    let spec = JSON.parse(pdfMatch[2]);
                    spec.path = pdfMatch[1].trim();
                    return {type: 'pdf', spec: spec, fp: text};
                } catch(e) {
                    console.error('❌ PDF_CREATE JSON parse error:', e);
                    return null;
                }
            }

            let multiMatch = text.match(/^RUN_CMD_START\s*\n([\s\S]*?)\nRUN_CMD_END\s*$/m);
            if (multiMatch) return {type: 'cmd', cmd: multiMatch[1].trim(), fp: text};

            let match = text.match(/^RUN_CMD:\s*(.+)$/m);
            if (match && text.trim().split('\n').length <= 3) return {type: 'cmd', cmd: match[1].trim(), fp: text};
        }
        return null;
    }


    // ── DOM Execution Marker ──────────────────────────────────────────────────
    const EXEC_ATTR = 'data-termux-executed';

    function markExecuted(el) {
        if (el) el.setAttribute(EXEC_ATTR, '1');
    }

    function isAlreadyExecuted(el) {
        return el && el.getAttribute(EXEC_ATTR) === '1';
    }

    // ── Main Loop ─────────────────────────────────────────────────────────────
    setInterval(() => {
        if (isRunning) return;

        let el = getLastAIMessage();
        if (!el) return;

        const elRect = el.getBoundingClientRect();
        if (elRect.bottom < 0) return;

        let msgCount = getAssistantMsgCount();
        if (msgCount !== lastAIMsgCount) {
            lastAIMsgCount = msgCount;
            processedFps.clear();
            execCounter  = 0;
            stableCount  = 0;
            lastTextSeen = '';
        }

        let pres = el.querySelectorAll('pre');
        let lastPre, preText;

        if (pres.length) {
            lastPre = pres[pres.length - 1];
            let codeEl = lastPre.querySelector('code');
            preText = (codeEl ? codeEl.textContent : lastPre.innerText).trim();
        } else if (IS_CHATGPT) {
            let chatgptBlocks = el.querySelectorAll('pre.cm-content, pre');
            if (chatgptBlocks.length) {
                lastPre = chatgptBlocks[chatgptBlocks.length - 1];
                let codeEl = lastPre.querySelector('code');
                preText = (codeEl ? codeEl.textContent : lastPre.innerText || lastPre.textContent).trim();
            } else {
                let paras = el.querySelectorAll('p[data-start]');
                if (!paras.length) return;
                lastPre = paras[paras.length - 1];
                preText = (lastPre.textContent || lastPre.innerText).trim();
            }
        } else if (IS_GEMINI) {
            let codeBlocks = el.querySelectorAll('code, p[data-path-to-node]');
            if (!codeBlocks.length) return;
            lastPre = codeBlocks[codeBlocks.length - 1];
            preText = (lastPre.textContent || lastPre.innerText).trim();
        } else {
            // DeepSeek — pre blocks use karta hai
            let deepPres = el.querySelectorAll('pre');
            if (!deepPres.length) return;
            lastPre = deepPres[deepPres.length - 1];
            let codeEl = lastPre.querySelector('code');
            preText = (codeEl ? codeEl.textContent : lastPre.innerText || lastPre.textContent).trim();
        }

        if (!preText) return;

        if (isAlreadyExecuted(lastPre)) return;

        if (preText === lastTextSeen) {
            stableCount++;
        } else {
            lastTextSeen = preText;
            stableCount  = 0;
            return;
        }
        if (stableCount < 2) return;

        let action = extractAction(el);
        if (!action) return;

        const scopedFp = `${msgCount}::${action.fp}`;
        if (processedFps.has(scopedFp)) return;
        processedFps.add(scopedFp);

        markExecuted(lastPre);

        stableCount  = 0;
        lastTextSeen = '';

        execCounter++;
        console.log(`🚀 [msg:${msgCount} exec:#${execCounter}] Action: ${action.type}`, action);

        if (action.type === 'cmd')    runCommand(action.cmd);
        if (action.type === 'read')   readFile(action.path);
        if (action.type === 'edit')   editFile(action.path, action.oldStr, action.newStr);
        if (action.type === 'write')  writeFile(action.path, action.content);
        if (action.type === 'append') appendFile(action.path, action.content);
        if (action.type === 'delete') deletePath(action.path, action.recursive);
        if (action.type === 'move')   movePath(action.src, action.dst);
        if (action.type === 'copy')   copyPath(action.src, action.dst);
        if (action.type === 'list')   listDir(action.path);
        if (action.type === 'mkdir')  makeDir(action.path);
        if (action.type === 'info')   fileInfo(action.path);
        if (action.type === 'find')   findFile(action.root, action.pattern);
        if (action.type === 'grep')   grepFile(action.pattern, action.path);
        if (action.type === 'head')   headFile(action.path, action.n);
        if (action.type === 'tail')   tailFile(action.path, action.n);
        if (action.type === 'pdf')    pdfCreate(action.spec);
    }, 600);

    console.log(`✅ Termux Agent v17.6 loaded on ${IS_CLAUDE ? 'Claude.ai' : IS_GEMINI ? 'Gemini' : IS_CHATGPT ? 'ChatGPT' : 'DeepSeek'}`);

})();