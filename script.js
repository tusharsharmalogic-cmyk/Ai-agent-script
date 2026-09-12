// ==UserScript==
// @name         Termux AI Agent+ (DeepSeek + Claude + ChatGPT)
// @namespace    termux-agent
// @version      16.3
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

    // ── Status Pill ──────────────────────────────────────────────────────────
    let pillEl = null;
    let cmdCount = 0;

    function showPill(cmd, status) {
        if (!pillEl) {
            pillEl = document.createElement('div');
            pillEl.id = 'termux-pill';
            pillEl.style.cssText = `
                position: fixed;
                top: 10px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(13,17,23,0.92);
                color: #00ff88;
                font-family: monospace;
                font-size: 12px;
                padding: 6px 16px;
                border-radius: 999px;
                border: 1px solid #00ff88;
                z-index: 999999;
                display: flex;
                align-items: center;
                gap: 10px;
                backdrop-filter: blur(6px);
                box-shadow: 0 2px 12px rgba(0,255,136,0.15);
                transition: opacity 0.3s ease;
            `;
            document.body.appendChild(pillEl);
        }
        pillEl.style.opacity = '1';
        pillEl.style.display = 'flex';
        let icon = status === 'running' ? '⚡' : status === 'done' ? '✅' : '❌';
        let color = status === 'running' ? '#00ff88' : status === 'done' ? '#00ff88' : '#ff4444';
        pillEl.style.borderColor = color;
        pillEl.style.color = color;
        pillEl.innerHTML = `${icon} <span style="opacity:0.6;flex-shrink:0">#${cmdCount}</span> <span style="overflow-x:auto;white-space:nowrap;max-width:60vw;display:inline-block;vertical-align:middle;">${cmd}</span>`;
    }

    let hideTimer = null;
    function hidePill() {
        if (!pillEl) return;
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (pillEl) {
                pillEl.style.opacity = '0';
                setTimeout(() => { if (pillEl) pillEl.style.display = 'none'; }, 300);
            }
        }, 2000);
    }

    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
    ).set;

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

                        if (data.input_needed && !inputPending) {
                            inputPending = true;
                            // Input popup removed — just log to console
                            console.warn('⌨️ Input needed:', data.input_context);
                        }

                        if (data.done) {
                            clearInterval(pollInterval);
                            pollInterval  = null;
                            inputPending  = false;
                            if (runTimeout) { clearTimeout(runTimeout); runTimeout = null; }
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

    // ── Edit File ─────────────────────────────────────────────────────────────
    function editFile(path, oldStr, newStr) {
        cmdCount++;
        showPill("✏️ " + path, "running");
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
                    showPill("✅ Edit done", "done"); hidePill();
                    setTimeout(() => { sendToAI(data.output || '❌ No output received'); }, 500);
                } catch(e) {
                    console.error('❌ Edit parse error:', e, '| Raw:', r.responseText);
                    isRunning = false;
                    showPill("✏️ error", "error"); hidePill();
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
        cmdCount++;
        showPill("📝 " + path, "running");
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
                    showPill("✅ Write done", "done"); hidePill();
                    setTimeout(() => { sendToAI(data.output || '❌ No output received'); }, 500);
                } catch(e) {
                    console.error('❌ Write parse error:', e, '| Raw:', r.responseText);
                    isRunning = false;
                    showPill("📝 error", "error"); hidePill();
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
        cmdCount++;
        showPill(cmd, 'running');
        isRunning    = true;
        inputPending = false;
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
                        showPill("✅ " + cmd, "done"); hidePill();
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

        runTimeout = setTimeout(() => {
            runTimeout = null;
            if (isRunning) {
                if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
                inputPending = false;
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
            return;
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

        if (action.type === 'cmd')   runCommand(action.cmd);
        if (action.type === 'edit')  editFile(action.path, action.oldStr, action.newStr);
        if (action.type === 'write') writeFile(action.path, action.content);
    }, 600);

    console.log(`✅ Termux Agent v16.3 loaded on ${IS_CLAUDE ? 'Claude.ai' : IS_GEMINI ? 'Gemini' : IS_CHATGPT ? 'ChatGPT' : 'DeepSeek'}`);

})();