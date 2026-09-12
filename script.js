// ==UserScript==
// @name         Termux AI Agent+ (DeepSeek + Claude + ChatGPT)
// @namespace    termux-agent
// @version      15.1
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

    let processedFps   = new Set();  // "msgCount::fp" format — per-message scoped
    let lastAIMsgCount = -1;
    let lastTextSeen   = '';
    let stableCount    = 0;
    let isRunning      = false;
    let pollInterval   = null;
    let inputPending   = false;
    let runTimeout     = null;
    let execCounter    = 0;  // FIX P1: same message mein same command ka unique counter

    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
    ).set;

    // ── Terminal Box ──────────────────────────────────────────────────────────
    // BUG 1 FIX: `return;` hataya — createTerminal() ab actually terminal banata hai
    function createTerminal() {
        let existing = document.getElementById('termux-box');
        if (existing) return; // already exist karta hai — dobara mat banao

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
                <span>⚡ Termux Agent ${IS_CLAUDE ? '(Claude)' : IS_GEMINI ? '(Gemini)' : '(DeepSeek)'}</span>
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

    // BUG 1 FIX: closeTerminal() ka `return;` bhi hataya — ab properly close hoga
    function closeTerminal() {
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
                    // BUG 2 FIX: silent catch hata ke proper error logging daala
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
                            if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
                            let stalePopup = document.getElementById('termux-input');
                            if (stalePopup) stalePopup.remove();
                            setStatus('✅ Done', '#00ff88');
                            closeTerminal();
                            sendToAI(data.final_output);
                        }
                    } catch(e) {
                        // BUG 2 FIX: error ab visible hai — debug ho sakta hai
                        console.error('❌ Poll response parse error:', e, '| Raw:', r.responseText);
                    }
                },
                // BUG 5 FIX: poll network error pe bhi pollInterval clear karo
                onerror: function() {
                    console.error('❌ Poll request failed — server unreachable');
                    clearInterval(pollInterval);
                    pollInterval = null;
                    if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
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

    // ── BUG 7 FIX: execCommand wrapper — modern Clipboard API fallback + lastresort ──
    // Ye function contenteditable ya ProseMirror editor mein text insert karta hai
    // execCommand deprecated hai, isliye pehle nativeInputValueSetter try karte hain,
    // phir clipboard paste event, aur finally direct textContent set.
    function insertTextIntoEditor(editor, text) {
        // Method 1: execCommand (still works in most userscript environments)
        try {
            editor.focus();
            // Pehle select-all karo
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

        // Method 2: dispatchEvent with InputEvent (works with some React/Angular setups)
        try {
            editor.focus();
            // innerHTML clear karo
            editor.innerHTML = '';
            const inputEvent = new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                data: text,
                inputType: 'insertText'
            });
            // DataTransfer se text set karna
            Object.defineProperty(inputEvent, 'target', { writable: false, value: editor });
            editor.textContent = text;
            editor.dispatchEvent(inputEvent);
            editor.dispatchEvent(new Event('change', { bubbles: true }));
            if (editor.textContent.trim()) return true;
        } catch(e) {
            console.warn('InputEvent fallback failed:', e);
        }

        // Method 3: last resort — direct set (React/Angular detect nahi kar sakta but text aata hai)
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
            console.log('❌ Claude editor not found');
            isRunning = false;
            // BUG 3 FIX: sendToAI() call hata diya — infinite recursion rok
            // Sirf console log aur isRunning reset karo
            console.error('❌ Claude ProseMirror editor nahi mila. Page reload karo.');
            return;
        }

        // BUG 7 FIX: insertTextIntoEditor helper use karo — proper fallback chain ke saath
        let success = insertTextIntoEditor(editor, output);

        if (!success) {
            console.error('❌ Claude editor mein text insert nahi hua');
            isRunning = false;
            return;
        }

        // ProseMirror state sync
        editor.dispatchEvent(new InputEvent('input', {bubbles: true, cancelable: true}));

        setTimeout(() => {
            let sendBtn = document.querySelector('button[aria-label="Send message"]');

            if (sendBtn) {
                sendBtn.click();
                console.log('✅ Claude ko send kiya!');
            } else {
                console.log('❌ Claude send button nahi mila');
                // BUG 3 FIX: sendToAI() yahan bhi nahi call karte — infinite loop ka risk
                // Sirf log karo, isRunning reset karo
                isRunning = false;
                return;
            }

            // BUG 4 FIX: isRunning reset ke liye reasonable delay (3s) diya —
            // 2s mein Claude respond kar deta tha jisse race condition hoti thi
            setTimeout(() => { isRunning = false; }, 3000);
        }, 1000);
    }

    // ── Gemini sender ─────────────────────────────────────────────────────────
    function sendToGemini(output) {
        // BUG 8 FIX: broad 'div[contenteditable="true"]' hataya —
        // ab Gemini ke specific input selectors use karo
        let editor = document.querySelector('rich-textarea div[contenteditable="true"]')
                  || document.querySelector('.ql-editor[contenteditable="true"]')
                  || document.querySelector('div[contenteditable="true"][role="textbox"]')
                  || document.querySelector('div[contenteditable="true"]'); // last resort fallback

        if (!editor) {
            console.log('❌ Gemini editor not found');
            isRunning = false;
            return;
        }

        // BUG 7 FIX: insertTextIntoEditor helper use karo
        let success = insertTextIntoEditor(editor, output);

        if (!success) {
            console.error('❌ Gemini editor mein text insert nahi hua');
            isRunning = false;
            return;
        }

        // Angular ke liye extra events
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
            // BUG 4 FIX: 3s delay — 2s race condition fix
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

            // BUG 4 FIX: 3s delay — 2s race condition fix
            setTimeout(() => { isRunning = false; }, 3000);
        }, 1500);
    }

    // ── ChatGPT Sender ────────────────────────────────────────────────────────
    function sendToChatGPT(output) {
        const editor = document.querySelector('div#prompt-textarea[contenteditable="true"]');
        if (!editor) { isRunning = false; return; }

        // BUG 7 FIX: insertTextIntoEditor helper use karo with fallback
        let success = insertTextIntoEditor(editor, output);
        if (!success) {
            // Last resort for ChatGPT
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

            // BUG 4 FIX: 3s delay
            setTimeout(() => { isRunning = false; }, 3000);
        }, 1000);
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
                    // isRunning = false PEHLE karo, phir sendToAI — warna sendToAI
                    // ke andar jo 1s + 3s delay hai, uske dauraan main loop re-trigger
                    // ho sakta tha (isRunning false tha callback ke bahar).
                    // Ab sendToAI ke sender functions (sendToClaude etc.) khud
                    // isRunning ko manage karte hain — yahan false karna sahi hai.
                    isRunning = false;
                    setTimeout(() => { sendToAI(data.output); }, 500);
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
                    // Same fix as editFile — isRunning false pehle,
                    // sendToAI ke sender apna isRunning manage karte hain
                    isRunning = false;
                    setTimeout(() => { sendToAI(data.output); }, 500);
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

    // ── Run Command ───────────────────────────────────────────────────────────
    function runCommand(cmd) {
        isRunning    = true;
        inputPending = false;
        createTerminal();
        appendOutput(`$ ${cmd}\n`);

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
                    // BUG 2 FIX: error log karo
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

        runTimeout = setTimeout(() => {
            runTimeout = null;
            if (isRunning) {
                // BUG 5 FIX: timeout pe pollInterval bhi clear karo
                if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
                isRunning = false;
                sendToAI('❌ Timeout: command 40s se zyada chal gayi (ya server ne done nahi bheja).');
            }
        }, 40000);
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

            // Fallback
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
            // DeepSeek
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

            let multiMatch = text.match(/RUN_CMD_START\s*\n([\s\S]*?)\nRUN_CMD_END/);
            if (multiMatch) return {type: 'cmd', cmd: multiMatch[1].trim(), fp: text};

            let match = text.match(/RUN_CMD:\s*(.+)/);
            if (match) return {type: 'cmd', cmd: match[1].trim(), fp: text};
        }
        return null;
    }

    // ── Scroll Guard ──────────────────────────────────────────────────────────
    // FIX P2: Check karo ki element viewport ke bottom-half mein hai ya nahi.
    // Agar user upar scroll karke chhod deta hai, toh purane messages trigger
    // nahi honge — sirf wo elements trigger honge jo visible bottom area mein hain.
    function isNearBottom(el) {
        const rect = el.getBoundingClientRect();
        const vh   = window.innerHeight;
        // Element ka top viewport height ke 120% se upar hai — matlab user
        // is element ke paas hai. 120% buffer isliye ki thoda upar scroll
        // karna allowed hai, lekin bahut purane messages block honge.
        return rect.top < vh * 1.2;
    }

    // ── DOM Execution Marker ──────────────────────────────────────────────────
    // FIX P2: Executed pre/code block pe ek data attribute lagao.
    // Scroll pe React DOM virtualize karta hai — element unmount/remount hota hai
    // aur attribute reset ho jaata hai. Isliye hum DONO check karte hain:
    // (1) DOM attribute  — fast path, scroll protection
    // (2) processedFps   — memory-based dedup, virtualization safe
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

        // FIX P2 (SCROLL GUARD): Last AI message viewport ke paas hona chahiye.
        // Agar user bahut upar scroll kar gaya hai, toh getLastAIMessage() galat
        // element return kar sakta hai (jo actually visible nahi hai).
        // rect.bottom < 0 matlab element screen ke upar chala gaya — ignore karo.
        const elRect = el.getBoundingClientRect();
        if (elRect.bottom < 0) return;  // element screen ke upar hai — skip

        let msgCount = getAssistantMsgCount();
        if (msgCount !== lastAIMsgCount) {
            lastAIMsgCount = msgCount;
            // FIX P1: processedFps clear mat karo puri — sirf purane msgCount ke
            // entries hatao. Naya message aaya toh execCounter reset karo.
            // processedFps mein format: "msgCount::fp"
            // Purane entries automatically stale ho jaate hain kyunki prefix alag hoga.
            processedFps.clear();  // New message = fresh slate (same-msg dedup ke liye)
            execCounter  = 0;      // FIX P1: naye message ke liye counter reset
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
            return;
        }

        if (!preText) return;

        // FIX P2: DOM attribute check — agar ye specific pre element pehle execute
        // ho chuka hai (attribute lagaa hai), toh skip karo.
        // Ye scroll pe remount hone wale elements bhi handle karta hai —
        // remount pe attribute chala jaata hai, lekin processedFps backup hai.
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

        // FIX P1: fp ko msgCount ke saath prefix karo.
        // Iska matlab: "ls -la" command ek hi message mein 2 baar aane pe
        // dono alag fp banenge: "3::RUN_CMD: ls -la" (first), phir naya
        // message aane pe "4::RUN_CMD: ls -la" — dono chalenge.
        // Lekin SAME message mein same exact pre block dobara trigger nahi hoga
        // kyunki DOM attribute mark kar diya hai.
        const scopedFp = `${msgCount}::${action.fp}`;
        if (processedFps.has(scopedFp)) return;
        processedFps.add(scopedFp);

        // FIX P2: DOM element pe mark lagao — scroll protection ke liye
        markExecuted(lastPre);

        // stableCount reset — next action ke liye
        stableCount  = 0;
        lastTextSeen = '';

        execCounter++;
        console.log(`🚀 [msg:${msgCount} exec:#${execCounter}] Action: ${action.type}`, action);

        if (action.type === 'cmd')   runCommand(action.cmd);
        if (action.type === 'edit')  editFile(action.path, action.oldStr, action.newStr);
        if (action.type === 'write') writeFile(action.path, action.content);
    }, 600);

    console.log(`✅ Termux Agent v15.1 loaded on ${IS_CLAUDE ? 'Claude.ai' : IS_GEMINI ? 'Gemini' : IS_CHATGPT ? 'ChatGPT' : 'DeepSeek'}`);

})();
