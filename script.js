// ==UserScript==
// @name         Termux AI Agent+ (DeepSeek + Claude)
// @namespace    termux-agent
// @version      12.0
// @match        *://chat.deepseek.com/*
// @match        *://claude.ai/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';

    // ── Site Detection ────────────────────────────────────────────────────────
    const IS_CLAUDE   = location.hostname === 'claude.ai';
    const IS_DEEPSEEK = location.hostname === 'chat.deepseek.com';

    let lastProcessed = '';
    let lastTextSeen  = '';
    let isRunning     = false;
    let pollInterval  = null;
    let inputPending  = false;
    let runTimeout    = null;  // FIX: leaked 40s timer ko track karo

    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
    ).set;

    // ── Terminal Box ──────────────────────────────────────────────────────────
    function createTerminal() {
        return; // terminal box disabled
        let existing = document.getElementById('termux-box');
        if (existing) existing.remove();

        let box = document.createElement('div');
        box.id = 'termux-box';
        box.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0;
            height: 220px;
            background: #0d1117;
            color: #00ff88;
            font-family: monospace;
            font-size: 11px;
            border-bottom: 2px solid #00ff88;
            z-index: 999999;
            display: flex;
            flex-direction: column;
        `;
        box.innerHTML = `
            <div style="
                padding: 5px 12px;
                background: #161b22;
                border-bottom: 1px solid #00ff88;
                font-size: 11px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            ">
                <span>⚡ Termux Agent ${IS_CLAUDE ? '(Claude)' : '(DeepSeek)'}</span>
                <span id="t-status" style="color:#00ff88;">Running...</span>
            </div>
            <div id="t-output" style="
                padding: 6px 10px;
                overflow-y: auto;
                flex: 1;
                white-space: pre-wrap;
                word-break: break-all;
                line-height: 1.5;
                font-size: 11px;
            "></div>
        `;
        document.body.appendChild(box);
    }

    function appendOutput(text) {
        let out = document.getElementById('t-output');
        if (!out) return;
        out.textContent += text;
        out.scrollTop = out.scrollHeight;
    }

    function setStatus(text, color) {
        let s = document.getElementById('t-status');
        if (s) {
            s.textContent = text;
            if (color) s.style.color = color;
        }
    }

    function closeTerminal() {
        return; // (a) terminal box disabled — kuch banaya hi nahi, kuch hataana bhi nahi
        setTimeout(() => {
            let box = document.getElementById('termux-box');
            if (box) {
                box.style.transition = 'transform 0.3s ease';
                box.style.transform  = 'translateY(-100%)';
                setTimeout(() => box.remove(), 300);
            }
        }, 2000);
    }

    // ── Input Popup ───────────────────────────────────────────────────────────
    function showInputPopup(context) {
        if (inputPending) return;
        inputPending = true;

        let existing = document.getElementById('termux-input');
        if (existing) existing.remove();

        let popup = document.createElement('div');
        popup.id = 'termux-input';
        popup.style.cssText = `
            position: fixed;
            top: 220px;
            left: 0; right: 0;
            background: #1a1a2e;
            border-bottom: 2px solid #f0883e;
            padding: 10px 14px;
            z-index: 9999999;
            font-family: monospace;
        `;
        popup.innerHTML = `
            <div style="color:#f0883e;font-size:11px;margin-bottom:4px;">⌨️ Input Required</div>
            <div id="t-input-context" style="color:#aaa;font-size:10px;margin-bottom:8px;word-break:break-all;max-height:40px;overflow:hidden;"></div>
            <div style="display:flex;gap:8px;">
                <input id="t-input-field" type="text" style="
                    flex:1; background:#0d1117; border:1px solid #f0883e;
                    color:#fff; padding:8px; border-radius:6px;
                    font-family:monospace; font-size:12px;
                " placeholder="Type input..." />
                <button id="t-input-btn" style="
                    background:#f0883e; color:#000; border:none;
                    padding:8px 16px; border-radius:6px;
                    font-weight:bold; font-size:13px;
                ">↵</button>
            </div>
        `;
        document.body.appendChild(popup);

        // BUG 4 fix: context ko textContent se set karo (HTML injection rok)
        let ctxEl = document.getElementById('t-input-context');
        if (ctxEl) ctxEl.textContent = context || '';

        let field = document.getElementById('t-input-field');
        let btn   = document.getElementById('t-input-btn');
        field.focus();

        function sendInput() {
            let val = field.value;
            popup.remove();
            inputPending = false;
            setStatus('Running...', '#00ff88');
            appendOutput(val + '\n');

            GM_xmlhttpRequest({
                method: 'POST',
                url: 'http://localhost:5000/input',
                headers: {'Content-Type': 'application/json'},
                data: JSON.stringify({value: val}),
                onerror: function() { appendOutput('❌ Input send failed\n'); }
            });
        }

        btn.addEventListener('click', sendInput);
        field.addEventListener('keydown', e => { if (e.key === 'Enter') sendInput(); });
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

                        if (data.chunks && data.chunks.length > 0) {
                            data.chunks.forEach(c => appendOutput(c));
                        }

                        if (data.input_needed && !inputPending) {
                            setStatus('⌨️ Input', '#f0883e');
                            showInputPopup(data.input_context);
                        }

                        if (data.done) {
                            clearInterval(pollInterval);
                            pollInterval  = null;
                            inputPending  = false;
                            // FIX: 40s timer clear — leaked timer jhootha timeout deta tha
                            if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
                            // (b) agar input popup khula reh gaya ho to hata do
                            let stalePopup = document.getElementById('termux-input');
                            if (stalePopup) stalePopup.remove();
                            setStatus('✅ Done', '#00ff88');
                            closeTerminal();
                            sendToAI(data.final_output);
                        }
                    } catch(e) {}
                }
            });
        }, 500);
    }

    // ── Send to AI ────────────────────────────────────────────────────────────
    function sendToAI(output) {
        if (IS_CLAUDE) {
            sendToClaude(output);
        } else {
            sendToDeepSeek(output);
        }
    }

    // ── Claude sender ─────────────────────────────────────────────────────────
    function sendToClaude(output) {
        // ProseMirror editor — Claude ka input box
        let editor = document.querySelector('.ProseMirror');
        if (!editor) {
            console.log('❌ Claude editor not found');
            isRunning = false;
            sendToAI('❌ Claude editor nahi mila (ProseMirror). Page reload karo.');
            return;
        }

        try {
            // 1) Editor ko focus karo (pehle click, phir focus)
            editor.click();
            editor.focus();

            // 2) Editor ke andar hi select karo — poori page nahi
            let range = document.createRange();
            range.selectNodeContents(editor);
            let sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            // 3) Clear karo (delete selection)
            document.execCommand('delete', false, null);

            // 4) Content daalo — pehle paste event, phir execCommand fallback
            let inserted = false;
            try {
                let dt = new DataTransfer();
                dt.setData('text/plain', output);
                let pasteEvt = new ClipboardEvent('paste', {
                    bubbles: true,
                    cancelable: true,
                    clipboardData: dt
                });
                editor.dispatchEvent(pasteEvt);
                inserted = true;
            } catch (err) {
                inserted = false;
            }

            if (!inserted) {
                // Fallback: execCommand insertText (deprecated but broad support)
                document.execCommand('insertText', false, output);
            }

            // 5) Input event bhejo — ProseMirror state sync
            editor.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true}));
        } catch (err) {
            console.log('❌ Claude insert error:', err);
            sendToAI('❌ Claude mein text insert nahi hua: ' + err.message);
            isRunning = false;
            return;
        }

        setTimeout(() => {
            // Send button — aria-label se (pehle wala working selector)
            let sendBtn = document.querySelector('button[aria-label="Send message"]');

            if (sendBtn) {
                sendBtn.click();
                console.log('✅ Claude ko send kiya!');
            } else {
                console.log('❌ Claude send button nahi mila');
                sendToAI('❌ Claude send button nahi mila.');
            }

            setTimeout(() => { isRunning = false; }, 2000);
        }, 1000);
    }

    // ── DeepSeek sender ───────────────────────────────────────────────────────
    function sendToDeepSeek(output) {
        const textarea = document.querySelector('textarea[placeholder="Message DeepSeek"]');
        if (!textarea) { isRunning = false; return; }

        valueSetter.call(textarea, output);
        textarea.dispatchEvent(new InputEvent('input', {bubbles: true}));

        setTimeout(() => {
            // BUG 5 fix: multiple fallback selectors — pehla jo mile wahi click
            let clicked = false;

            // Fallback 1: aria-label (modern)
            let btn1 = document.querySelector('button[aria-label*="Send"]')
                    || document.querySelector('button[aria-label*="send"]')
                    || document.querySelector('div[role="button"][aria-label*="Send"]');
            if (btn1 && !btn1.disabled) { btn1.click(); clicked = true; }

            // Fallback 2: data-testid
            if (!clicked) {
                let btn2 = document.querySelector('[data-testid*="send" i]')
                        || document.querySelector('[data-testid*="submit" i]');
                if (btn2) { btn2.click(); clicked = true; }
            }

            // Fallback 3: type="submit" button
            if (!clicked) {
                let btn3 = document.querySelector('button[type="submit"]');
                if (btn3 && !btn3.disabled) { btn3.click(); clicked = true; }
            }

            // Fallback 4 (PURANA LOGIC — jaisa tha waisa hi rakha): svg path d match
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

            setTimeout(() => { isRunning = false; }, 2000);
        }, 1500);
    }

    // ── Edit File ─────────────────────────────────────────────────────────────
    function editFile(path, oldStr, newStr) {
        isRunning = true;
        createTerminal();
        appendOutput(`✏️ Editing: ${path}\n`);

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:5000/edit',
            headers: {'Content-Type': 'application/json'},
            data: JSON.stringify({path: path, old_str: oldStr, new_str: newStr}),
            onload: function(r) {
                try {
                    let data = JSON.parse(r.responseText);
                    setStatus(data.status === 'ok' ? '✅ Done' : '❌ Error',
                              data.status === 'ok' ? '#00ff88' : '#ff4444');
                    appendOutput(data.output + '\n');
                    closeTerminal();
                    setTimeout(() => { sendToAI(data.output); }, 500);
                } catch(e) {
                    sendToAI('❌ Edit parse error');
                }
                isRunning = false;
            },
            onerror: function() {
                sendToAI('❌ Edit request failed');
                isRunning = false;
            }
        });
    }

    // ── Write File ────────────────────────────────────────────────────────────
    function writeFile(path, content) {
        isRunning = true;
        createTerminal();
        appendOutput(`📝 Writing: ${path}\n`);

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:5000/write',
            headers: {'Content-Type': 'application/json'},
            data: JSON.stringify({path: path, content: content}),
            onload: function(r) {
                try {
                    let data = JSON.parse(r.responseText);
                    setStatus(data.status === 'ok' ? '✅ Done' : '❌ Error',
                              data.status === 'ok' ? '#00ff88' : '#ff4444');
                    appendOutput(data.output + '\n');
                    closeTerminal();
                    setTimeout(() => { sendToAI(data.output); }, 500);
                } catch(e) {
                    sendToAI('❌ Write parse error');
                }
                isRunning = false;
            },
            onerror: function() {
                sendToAI('❌ Write request failed');
                isRunning = false;
            }
        });
    }

    // ── Run Command ───────────────────────────────────────────────────────────
    function runCommand(cmd) {
        isRunning    = true;
        inputPending = false;
        createTerminal();
        appendOutput(`$ ${cmd}\n`);

        // FIX: purana leaked timer clear — warna pichhli command ka timer
        // is command ke window mein fire hoke jhootha timeout deta tha
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
                        // Server ne turant reply diya (busy/blacklist/empty) — timer + flag clear
                        if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
                        isRunning = false;
                        sendToAI(data.output || '❌ Error');
                    }
                } catch(e) {
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

        runTimeout = setTimeout(() => {
            runTimeout = null;
            if (isRunning) {
                if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
                isRunning = false;
                sendToAI('❌ Timeout: command 40s se zyada chal gayi (ya server ne done nahi bheja).');
            }
        }, 40000);
    }

    // ── AI Message Detection ──────────────────────────────────────────────────
    function getLastAIMessage() {
        if (IS_CLAUDE) {
            // Pehle wali working logic — .group.relative.relative
            let msgs = document.querySelectorAll('.group.relative.relative');
            if (!msgs.length) return null;
            return msgs[msgs.length - 1];
        } else {
            // DeepSeek
            let msgs = document.querySelectorAll('.ds-markdown.ds-assistant-message-main-content');
            if (!msgs.length) return null;
            return msgs[msgs.length - 1];
        }
    }

    function extractAction(el) {
        let pres = el.querySelectorAll('pre');
        // BUG 2 fix: newest <pre> block pehle — streaming ke dauraan latest action prefer
        for (let i = pres.length - 1; i >= 0; i--) {
            let text = pres[i].innerText.trim();
            if (!text) continue;

            // EDIT_FILE (c: \n>>>\s*$ anchor — content ke andar wala >>> match na tode)
            let editMatch = text.match(
                /EDIT_FILE:\s*(.+?)\nOLD_STR\n<<<\n([\s\S]*?)\n>>>\nNEW_STR\n<<<\n([\s\S]*?)\n>>>\s*$/
            );
            if (editMatch) {
                return {type: 'edit', path: editMatch[1].trim(), oldStr: editMatch[2], newStr: editMatch[3], fp: text};
            }

            // WRITE_FILE (c: \n>>>\s*$ anchor)
            let writeMatch = text.match(/WRITE_FILE:\s*(.+?)\n<<<\n([\s\S]*?)\n>>>\s*$/);
            if (writeMatch) {
                return {type: 'write', path: writeMatch[1].trim(), content: writeMatch[2], fp: text};
            }

            // Multi-line command
            let multiMatch = text.match(/RUN_CMD_START\n([\s\S]*?)\nRUN_CMD_END/);
            if (multiMatch) return {type: 'cmd', cmd: multiMatch[1].trim(), fp: text};

            // Single-line command
            let match = text.match(/RUN_CMD:\s*(.+)/);
            if (match) return {type: 'cmd', cmd: match[1].trim(), fp: text};
        }
        return null;
    }

    // ── Main Loop ─────────────────────────────────────────────────────────────
    setInterval(() => {
        if (isRunning) return;
        let el = getLastAIMessage();
        if (!el) return;
        let text = el.innerText;

        // BUG 2 fix: streaming settle — 2 baar same text mile tabhi process karo
        if (text !== lastTextSeen) {
            lastTextSeen = text;
            return;
        }
        if (text === lastProcessed) return;

        let action = extractAction(el);
        if (!action) return;

        // BUG 2 fix: fingerprint (extracted <pre> content) track karo — repeated execution rok
        if (action.fp === lastProcessed) return;

        lastProcessed = action.fp;
        if (action.type === 'cmd')   runCommand(action.cmd);
        if (action.type === 'edit')  editFile(action.path, action.oldStr, action.newStr);
        if (action.type === 'write') writeFile(action.path, action.content);
    }, 2000);

    console.log(`✅ Termux Agent loaded on ${IS_CLAUDE ? 'Claude.ai' : 'DeepSeek'}`);

})();