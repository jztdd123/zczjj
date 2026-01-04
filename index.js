import { getContext, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced, saveChatConditional, chat_metadata } from "../../../../script.js";

const extensionName = "st-summarizer";
const localStorageKey = "summarizer_credentials";

const defaultSettings = {
    summaryPrompt: "请用简洁的中文总结以上对话的主要内容，保留关键信息和角色行为。",
    maxMessages: 20,
    autoSummarize: false,
    triggerInterval: 20,
    keepVisible: 10,
    autoHide: true,
    autoWorldInfo: true,
    apiEndpoint: "",
    apiKey: "",
    model: "",
    lastSummarizedIndex: 0,
    savedSummaries: [],
    currentWorldBook: "",
    currentEntryUid: null,
    currentEntryName: "",
    currentChatId: null
};

function saveCredentialsLocal(endpoint, key) {
    localStorage.setItem(localStorageKey, JSON.stringify({ apiEndpoint: endpoint, apiKey: key }));
}

function loadCredentialsLocal() {
    try { return JSON.parse(localStorage.getItem(localStorageKey)) || null; }
    catch { return null; }
}

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }
    const creds = loadCredentialsLocal();
    if (creds?.apiEndpoint) extension_settings[extensionName].apiEndpoint = creds.apiEndpoint;
    if (creds?.apiKey) extension_settings[extensionName].apiKey = creds.apiKey;
}

function getSettings() { return extension_settings[extensionName]; }

function saveSettings() {
    const s = getSettings();
    saveCredentialsLocal(s.apiEndpoint, s.apiKey);
    saveSettingsDebounced();
}

function getCompletionsUrl(base) {
    base = base.trim().replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) return base;
    if (base.endsWith("/v1")) return base + "/chat/completions";
    return base + "/v1/chat/completions";
}

function getModelsUrl(base) {
    base = base.trim().replace(/\/+$/, "");
    if (base.endsWith("/models")) return base;
    if (base.includes("/chat/completions")) return base.replace("/chat/completions", "/models");
    if (base.endsWith("/v1")) return base + "/models";
    return base + "/v1/models";
}

function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const sec = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}@${hour}h${min}m${sec}s`;
}

function getCharacterName() {
    const context = getContext();
    return context.name2 || context.characterId || "Unknown";
}

function getChatId() {
    const context = getContext();
    return context.chatId || null;
}

// ============ 隐藏功能 ============

async function hideMessages(startIdx, endIdx) {
    const context = getContext();
    const chat = context.chat;
    if (!chat) return 0;

    const start = Math.max(0, startIdx);
    const end = Math.min(chat.length, endIdx);

    if (start >= end) return 0;

    let count = 0;
    for (let i = start; i < end; i++) {
        if (!chat[i].is_system) {
            chat[i].is_system = true;
            count++;

            const messageBlock = $(`#chat .mes[mesid="${i}"]`);
            if (messageBlock.length) {
                messageBlock.attr('is_system', 'true');
            }
        }
    }

    if (count > 0) {
        await saveChatConditional();
        console.log(`痔疮总结机: 隐藏了 ${start + 1}-${end} 楼 (${count}条)`);
    }

    return count;
}

async function unhideAll() {
    const context = getContext();
    const chat = context.chat;
    if (!chat) return;

    let count = 0;
    for (let i = 0; i < chat.length; i++) {
        if (chat[i].is_system && chat[i].mes) {
            chat[i].is_system = false;
            count++;

            const messageBlock = $(`#chat .mes[mesid="${i}"]`);
            if (messageBlock.length) {
                messageBlock.attr('is_system', 'false');
            }
        }
    }

    if (count > 0) {
        await saveChatConditional();
    }

    updateHideStatus();
    document.getElementById("summarizer-output").textContent = `已取消隐藏 ${count} 条消息`;
}

async function checkContinuousHide() {
    const settings = getSettings();
    if (!settings.autoHide) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const hideUntil = chat.length - settings.keepVisible;

    if (hideUntil > 0) {
        let count = 0;
        for (let i = 0; i < hideUntil; i++) {
            if (!chat[i].is_system) {
                chat[i].is_system = true;
                count++;

                const messageBlock = $(`#chat .mes[mesid="${i}"]`);
                if (messageBlock.length) {
                    messageBlock.attr('is_system', 'true');
                }
            }
        }

        if (count > 0) {
            await saveChatConditional();
            updateHideStatus();
        }
    }
}

function updateHideStatus() {
    const context = getContext();
    const chat = context.chat;
    if (!chat) return;

    let hidden = 0;
    let visible = 0;
    for (const m of chat) {
        if (m.is_system) {
            hidden++;
        } else {
            visible++;
        }
    }

    const statusEl = document.getElementById("summarizer-hide-status");
    if (statusEl) statusEl.textContent = `显示: ${visible} | 隐藏: ${hidden} | 总: ${chat.length}`;
}

// ============ 世界书功能 ============

async function loadWorldInfo(worldName) {
    try {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: worldName })
        });
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        console.error("加载世界书失败:", e);
        return null;
    }
}

async function saveWorldInfo(worldName, data) {
    try {
        const response = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: worldName, data: data })
        });
        return response.ok;
    } catch (e) {
        console.error("保存世界书失败:", e);
        return false;
    }
}

async function createWorldInfo(worldName) {
    try {
        const response = await fetch('/api/worldinfo/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: worldName })
        });
        return response.ok;
    } catch (e) {
        console.error("创建世界书失败:", e);
        return false;
    }
}

async function getWorldInfoList() {
    try {
        const response = await fetch('/api/worldinfo/list', { method: 'GET' });
        if (!response.ok) return [];
        const data = await response.json();
        return data.entries || data || [];
    } catch (e) {
        console.error("获取世界书列表失败:", e);
        return [];
    }
}

async function bindWorldInfoToChat(worldName) {
    try {
        // 直接操作全局 chat_metadata
        if (typeof chat_metadata !== 'undefined' && chat_metadata) {
            if (!chat_metadata.world_info) chat_metadata.world_info = [];

            if (!chat_metadata.world_info.includes(worldName)) {
                chat_metadata.world_info.push(worldName);
                await saveChatConditional();
                console.log(`世界书 ${worldName} 已绑定到当前聊天`);
            }
        } else {
            // 备用方案
            const context = getContext();
            if (!context.chatMetadata) context.chatMetadata = {};
            if (!context.chatMetadata.world_info) context.chatMetadata.world_info = [];

            if (!context.chatMetadata.world_info.includes(worldName)) {
                context.chatMetadata.world_info.push(worldName);
                await saveChatConditional();
                console.log(`世界书 ${worldName} 已绑定到当前聊天`);
            }
        }
        return true;
    } catch (e) {
        console.error("绑定世界书失败:", e);
        return false;
    }
}

async function writeSummaryToWorldInfo(summary, range) {
    const settings = getSettings();
    if (!settings.autoWorldInfo) return null;

    const charName = getCharacterName();
    const worldBookName = `${charName}_Summaries`;

    try {
        const worldList = await getWorldInfoList();
        const exists = worldList.some(w => (typeof w === 'string' ? w : w.name) === worldBookName);

        if (!exists) {
            await createWorldInfo(worldBookName);
            console.log(`创建世界书: ${worldBookName}`);
        }

        let worldData = await loadWorldInfo(worldBookName);
        if (!worldData) worldData = { entries: {} };
        if (!worldData.entries) worldData.entries = {};

        let entryUid = settings.currentEntryUid;
        let entryName = settings.currentEntryName;
        const chatId = getChatId();

        if (!entryUid || !worldData.entries[entryUid] || settings.currentChatId !== chatId) {
            const timestamp = getTimestamp();
            entryName = `${charName} - ${timestamp}`;

            const existingUids = Object.keys(worldData.entries).map(Number).filter(n => !isNaN(n));
            entryUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 0;

            worldData.entries[entryUid] = {
                uid: entryUid,
                key: [],
                keysecondary: [],
                comment: entryName,
                content: "",
                constant: true,
                vectorized: false,
                selective: false,
                selectiveLogic: 0,
                addMemo: true,
                order: 100,
                position: 4,
                depth: 2,
                disable: false,
                excludeRecursion: false,
                preventRecursion: false,
                probability: 100,
                useProbability: true,
                group: "",
                groupOverride: false,
                groupWeight: 100,
                scanDepth: null,
                caseSensitive: null,
                matchWholeWords: null,
                automationId: "",
                role: null,
                sticky: null,
                cooldown: null,
                delay: null
            };

            settings.currentEntryUid = entryUid;
            settings.currentEntryName = entryName;
            settings.currentChatId = chatId;
            console.log(`创建新条目: ${entryName} (UID: ${entryUid})`);
        }

        const entry = worldData.entries[entryUid];
        const newContent = `\n\n【${getTimestamp()}】消息 ${range}:\n${summary}`;

        if (entry.content) {
            entry.content += newContent;
        } else {
            entry.content = `# ${entryName} 对话总结${newContent}`;
        }

        await saveWorldInfo(worldBookName, worldData);
        await bindWorldInfoToChat(worldBookName);
        saveSettings();

        return { worldBookName, entryName };

    } catch (e) {
        console.error("写入世界书失败:", e);
        return null;
    }
}

// ============ API功能 ============

async function fetchModels() {
    const settings = getSettings();
    if (!settings.apiEndpoint || !settings.apiKey) throw new Error("填写API配置");
    const res = await fetch(getModelsUrl(settings.apiEndpoint), {
        method: "GET",
        headers: { "Authorization": `Bearer ${settings.apiKey}` }
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return data.data || data.models || [];
}

async function testConnection() {
    const settings = getSettings();
    const status = document.getElementById("summarizer-status");
    status.textContent = "测试中...";
    status.style.color = "orange";

    try {
        if (!settings.apiEndpoint || !settings.apiKey || !settings.model) throw new Error("配置不完整");
        const res = await fetch(getCompletionsUrl(settings.apiEndpoint), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                model: settings.model,
                messages: [{ role: "user", content: "hi" }],
                max_tokens: 5
            })
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        if (data.choices) {
            status.textContent = "✓ 成功";
            status.style.color = "lime";
        } else throw new Error("响应异常");
    } catch (e) {
        status.textContent = "✗ " + e.message;
        status.style.color = "red";
    }
}

async function refreshModelList() {
    const sel = document.getElementById("summarizer-model-select");
    const status = document.getElementById("summarizer-status");
    sel.innerHTML = '<option>加载中...</option>';
    status.textContent = "获取模型...";
    status.style.color = "orange";

    try {
        const models = await fetchModels();
        sel.innerHTML = '<option value="">-- 选择 --</option>';
        models.forEach(m => {
            const id = m.id || m.name || m;
            sel.innerHTML += `<option value="${id}">${id}</option>`;
        });
        const settings = getSettings();
        if (settings.model) sel.value = settings.model;
        status.textContent = `✓ ${models.length} 模型`;
        status.style.color = "lime";
    } catch (e) {
        sel.innerHTML = '<option>失败</option>';
        status.textContent = "✗ " + e.message;
        status.style.color = "red";
    }
}

function getRecentChat(start, end) {
    const chat = getContext().chat;
    if (!chat?.length) return null;
    let text = "";
    chat.slice(start, end).forEach(m => {
        if (m.is_system) return;
        text += `${m.is_user ? "用户" : m.name}: ${m.mes}\n\n`;
    });
    return text;
}

async function callAPI(prompt) {
    const settings = getSettings();
    if (!settings.apiEndpoint || !settings.apiKey || !settings.model) throw new Error("配置不完整");

    const res = await fetch(getCompletionsUrl(settings.apiEndpoint), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify({
            model: settings.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 2000
        })
    });

    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "失败";
}

async function doSummarize() {
    const settings = getSettings();
    const out = document.getElementById("summarizer-output");
    const btn = document.getElementById("summarizer-btn");
    out.textContent = "生成中...";
    btn.disabled = true;

    try {
        const context = getContext();
        const len = context.chat?.length || 0;
        const start = Math.max(0, len - settings.maxMessages);
        const chat = getRecentChat(start, len);
        if (!chat) { out.textContent = "无记录"; btn.disabled = false; return; }

        const summary = await callAPI(`${chat}\n---\n${settings.summaryPrompt}`);
        const range = `${start + 1}-${len}`;

        settings.savedSummaries.push({
            time: new Date().toLocaleString(),
            range: range,
            content: summary
        });

        let worldResult = null;
        if (settings.autoWorldInfo) {
            worldResult = await writeSummaryToWorldInfo(summary, range);
        }

        if (settings.autoHide) {
            const hideUntil = len - settings.keepVisible;
            if (hideUntil > 0) {
                await hideMessages(0, hideUntil);
            }
        }

        settings.lastSummarizedIndex = len;
        saveSettings();
        updateHideStatus();

        let resultText = summary;
        if (worldResult) {
            resultText = `[已写入世界书: ${worldResult.worldBookName}]\n[条目: ${worldResult.entryName}]\n\n${summary}`;
        }
        if (settings.autoHide) {
            const hideUntil = len - settings.keepVisible;
            if (hideUntil > 0) {
                resultText = `[已隐藏 1-${hideUntil} 楼]\n` + resultText;
            }
        }
        out.textContent = resultText;

    } catch (e) {
        out.textContent = "错误: " + e.message;
        console.error(e);
    }
    btn.disabled = false;
}

async function checkAuto() {
    const settings = getSettings();

    if (settings.autoHide) await checkContinuousHide();

    if (!settings.autoSummarize) return;

    const len = getContext().chat?.length || 0;
    if (len - settings.lastSummarizedIndex >= settings.triggerInterval) {
        const out = document.getElementById("summarizer-output");

        try {
            const start = settings.lastSummarizedIndex;
            const chat = getRecentChat(start, len);
            if (!chat) return;

            out.textContent = "[自动总结中...]";

            const summary = await callAPI(`${chat}\n---\n${settings.summaryPrompt}`);
            const range = `${start + 1}-${len}`;

            settings.savedSummaries.push({
                time: new Date().toLocaleString(),
                range: range,
                content: summary,
                auto: true
            });

            if (settings.autoWorldInfo) {
                await writeSummaryToWorldInfo(summary, range);
            }

            if (settings.autoHide) {
                const hideUntil = len - settings.keepVisible;
                if (hideUntil > 0) await hideMessages(0, hideUntil);
            }

            settings.lastSummarizedIndex = len;
            saveSettings();
            updateHideStatus();

            out.textContent = `[自动总结完成]\n${summary}`;

        } catch (e) {
            console.error("自动总结失败", e);
            out.textContent = "自动总结失败: " + e.message;
        }
    }
}

function showHistory() {
    const s = getSettings();
    const out = document.getElementById("summarizer-output");
    if (!s.savedSummaries.length) { out.textContent = "无历史"; return; }
    out.textContent = s.savedSummaries.slice().reverse().map(x =>
        `【${x.time}】${x.range}${x.auto ? " (自动)" : ""}\n${x.content}`
    ).join("\n\n---\n\n");
}

function clearHistory() {
    const s = getSettings();
    s.savedSummaries = [];
    s.lastSummarizedIndex = 0;
    s.currentEntryUid = null;
    s.currentEntryName = "";
    s.currentChatId = null;
    saveSettings();
    document.getElementById("summarizer-output").textContent = "已清空";
}

jQuery(() => {
    loadSettings();
    const s = getSettings();

    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>痔疮总结机</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
            <div style="display:flex;gap:10px;margin-bottom:8px;">
                <div style="flex:1;"><label>API地址:</label><input type="text" id="summarizer-api-endpoint" class="text_pole" placeholder="https://xxx/v1"></input></div>
                <div style="flex:1;"><label>API密钥:</label><input type="password" id="summarizer-api-key" class="text_pole"></input></div>
            </div>
            <div style="display:flex;gap:10px;align-items:end;margin-bottom:8px;">
                <div style="flex:1;"><label>模型:</label><select id="summarizer-model-select" class="text_pole"><option>--</option></select></div>
                <div style="flex:1;"><label>手动:</label><input type="text" id="summarizer-model-manual" class="text_pole"></input></div>
                <button id="summarizer-fetch-models" class="menu_button">获取</button>
                <button id="summarizer-test-btn" class="menu_button">测试</button>
            </div>
            <div id="summarizer-status" style="font-size:12px;color:gray;margin-bottom:8px;">未连接</div>
            <hr></hr>
            <div style="display:flex;gap:10px;margin:8px 0;">
                <div style="flex:2;"><label>提示词:</label><textarea id="summarizer-prompt" class="text_pole" rows="2"></textarea></div>
                <div style="flex:1;"><label>总结条数:</label><input type="number" id="summarizer-max-msgs" class="text_pole" min="5" max="200"></input></div>
            </div>
            <div style="display:flex;gap:10px;margin:8px 0;">
                <div style="flex:1;"><label>自动间隔:</label><input type="number" id="summarizer-trigger-interval" class="text_pole" min="10" max="200"></input></div>
                <div style="flex:1;"><label>保留显示:</label><input type="number" id="summarizer-keep-visible" class="text_pole" min="1" max="100"></input></div>
            </div>
            <div style="display:flex;gap:15px;align-items:center;margin:8px 0;flex-wrap:wrap;">
                <label class="checkbox_label"><input type="checkbox" id="summarizer-auto-enabled"> 自动总结</input></label>
                <label class="checkbox_label"><input type="checkbox" id="summarizer-auto-hide"> 自动隐藏</input></label>
                <label class="checkbox_label"><input type="checkbox" id="summarizer-auto-worldinfo"> 写入世界书</input></label>
            </div>
            <div id="summarizer-hide-status" style="font-size:12px;color:#888;margin:5px 0;">显示: - | 隐藏: - | 总: -</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
                <button id="summarizer-btn" class="menu_button">总结</button>
                <button id="summarizer-history-btn" class="menu_button">历史</button>
                <button id="summarizer-clear-btn" class="menu_button">清空</button>
                <button id="summarizer-unhide-btn" class="menu_button">取消隐藏</button>
            </div>
            <div id="summarizer-output" style="margin-top:10px;padding:10px;background:var(--SmartThemeBlurTintColor);border-radius:5px;max-height:200px;overflow-y:auto;white-space:pre-wrap;">就绪</div>
        </div>
    </div>`;

    $("#extensions_settings2").append(html);

    $("#summarizer-api-endpoint").val(s.apiEndpoint).on("change", function() { s.apiEndpoint = this.value.trim(); saveSettings(); });
    $("#summarizer-api-key").val(s.apiKey).on("change", function() { s.apiKey = this.value.trim(); saveSettings(); });
    $("#summarizer-model-manual").val(s.model).on("change", function() { s.model = this.value.trim(); saveSettings(); });
    $("#summarizer-model-select").on("change", function() { if (this.value) { s.model = this.value; $("#summarizer-model-manual").val(this.value); saveSettings(); } });
    $("#summarizer-prompt").val(s.summaryPrompt).on("change", function() { s.summaryPrompt = this.value; saveSettings(); });
    $("#summarizer-max-msgs").val(s.maxMessages).on("change", function() { s.maxMessages = +this.value || 20; saveSettings(); });
    $("#summarizer-trigger-interval").val(s.triggerInterval).on("change", function() { s.triggerInterval = +this.value || 20; saveSettings(); });
    $("#summarizer-keep-visible").val(s.keepVisible).on("change", function() { s.keepVisible = +this.value || 10; saveSettings(); });
    $("#summarizer-auto-enabled").prop("checked", s.autoSummarize).on("change", function() { s.autoSummarize = this.checked; saveSettings(); });
    $("#summarizer-auto-hide").prop("checked", s.autoHide).on("change", function() { s.autoHide = this.checked; saveSettings(); });
    $("#summarizer-auto-worldinfo").prop("checked", s.autoWorldInfo).on("change", function() { s.autoWorldInfo = this.checked; saveSettings(); });

    $("#summarizer-fetch-models").on("click", refreshModelList);
    $("#summarizer-test-btn").on("click", testConnection);
    $("#summarizer-btn").on("click", doSummarize);
    $("#summarizer-history-btn").on("click", showHistory);
    $("#summarizer-clear-btn").on("click", clearHistory);
    $("#summarizer-unhide-btn").on("click", unhideAll);

    eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(checkAuto, 1000));
    eventSource.on(event_types.MESSAGE_SENT, () => setTimeout(checkAuto, 1000));

    setTimeout(updateHideStatus, 500);

    // 自动获取模型列表
    setTimeout(() => {
        const settings = getSettings();
        if (settings.apiEndpoint && settings.apiKey) {
            console.log("痔疮总结机: 自动获取模型列表...");
            refreshModelList().catch(e => {
                console.log("痔疮总结机: 自动获取模型失败");
            });
        }
    }, 1500);

    console.log("痔疮总结机 loaded");
});
