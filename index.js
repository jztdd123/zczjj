import { getContext, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";
import { world_info, getWorldInfoPrompt } from "../../../world-info.js";

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
    worldInfoEntryUid: null,
    currentChatId: null,
    apiEndpoint: "",
    apiKey: "",
    model: "",
    lastSummarizedIndex: 0,
    savedSummaries: []
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

// 生成条目名称
function generateEntryName() {
    const context = getContext();
    const charName = context.name2 || "Assistant";
    const now = new Date();
    const timestamp = now.getFullYear() + "-" +
        String(now.getMonth() + 1).padStart(2, "0") + "-" +
        String(now.getDate()).padStart(2, "0") + "@" +
        String(now.getHours()).padStart(2, "0") + "h" +
        String(now.getMinutes()).padStart(2, "0") + "m" +
        String(now.getSeconds()).padStart(2, "0") + "s";
    return `${charName} - ${timestamp}`;
}

// 获取聊天世界书名称
function getChatWorldInfoName() {
    const context = getContext();
    // 聊天世界书存在 chatMetadata 中
    if (context.chatMetadata?.world_info) {
        return context.chatMetadata.world_info;
    }
    return null;
}

// 获取或创建世界书条目
async function getOrCreateWorldInfoEntry() {
    const settings = getSettings();
    const context = getContext();

    // 获取聊天世界书
    let worldName = getChatWorldInfoName();

    if (!worldName) {
        updateWorldInfoStatus("未绑定聊天世界书");
        return null;
    }

    // 检查是否切换了聊天
    const currentChatId = context.chatId;
    if (settings.currentChatId !== currentChatId) {
        // 新聊天，重置条目
        settings.worldInfoEntryUid = null;
        settings.currentChatId = currentChatId;
        saveSettings();
    }

    // 已有条目直接返回
    if (settings.worldInfoEntryUid) {
        return { bookName: worldName, uid: settings.worldInfoEntryUid };
    }

    // 创建新条目
    const entryName = generateEntryName();

    try {
        const response = await fetch("/api/worldinfo/create-entry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: worldName,
                entry: {
                    key: [entryName],
                    keysecondary: [],
                    content: "",
                    comment: entryName,
                    constant: true,
                    depth: 2,
                    position: 4,
                    disable: false,
                    excludeRecursion: false,
                    preventRecursion: false,
                    selectiveLogic: 0,
                    order: 100
                }
            })
        });

        if (response.ok) {
            const data = await response.json();
            settings.worldInfoEntryUid = data.uid;
            saveSettings();
            console.log(`痔疮总结机: 创建条目 "${entryName}" in ${worldName}`);
            updateWorldInfoStatus(`已绑定: ${worldName}`);
            return { bookName: worldName, uid: data.uid, isNew: true };
        } else {
            throw new Error(`HTTP ${response.status}`);
        }
    } catch (e) {
        console.error("创建条目失败", e);
        updateWorldInfoStatus("创建失败: " + e.message);
    }

    return null;
}

// 追加总结到世界书条目
async function appendToWorldInfo(summary, range) {
    const settings = getSettings();
    if (!settings.autoWorldInfo) return;

    const entryInfo = await getOrCreateWorldInfoEntry();
    if (!entryInfo) return;

    try {
        // 获取现有条目
        const getResponse = await fetch(`/api/worldinfo/get?name=${encodeURIComponent(entryInfo.bookName)}`);
        if (!getResponse.ok) throw new Error("获取世界书失败");

        const worldData = await getResponse.json();
        const entries = worldData.entries || {};
        const entry = entries[entryInfo.uid];

        if (!entry) throw new Error("条目不存在");

        // 追加内容
        const timestamp = new Date().toLocaleString();
        const newContent = entry.content
            ? `${entry.content}\n\n---\n【${timestamp}】消息 ${range}\n${summary}`
            : `【${timestamp}】消息 ${range}\n${summary}`;

        // 更新条目
        await fetch("/api/worldinfo/edit-entry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: entryInfo.bookName,
                uid: entryInfo.uid,
                entry: { ...entry, content: newContent }
            })
        });

        console.log("痔疮总结机: 已追加到世界书");
        updateWorldInfoStatus(`已写入: ${entryInfo.bookName}`);

    } catch (e) {
        console.error("写入失败", e);
        updateWorldInfoStatus("写入失败: " + e.message);
    }
}

function updateWorldInfoStatus(text) {
    const el = document.getElementById("summarizer-worldinfo-status");
    if (el) el.textContent = text;
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

function hideMessages(startIdx, endIdx) {
    const context = getContext();
    const chat = context.chat;
    if (!chat) return 0;

    let hiddenCount = 0;
    for (let i = startIdx; i < endIdx && i < chat.length; i++) {
        if (!chat[i].is_system && !chat[i].is_hidden) {
            chat[i].is_hidden = true;
            hiddenCount++;
        }
    }
    if (hiddenCount > 0 && typeof context.saveChat === 'function') context.saveChat();
    return hiddenCount;
}

function checkContinuousHide() {
    const settings = getSettings();
    if (!settings.autoHide) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat?.length) return;

    const hideUntil = chat.length - settings.keepVisible;
    if (hideUntil > 0) {
        let count = 0;
        for (let i = 0; i < hideUntil; i++) {
            if (!chat[i].is_system && !chat[i].is_hidden) {
                chat[i].is_hidden = true;
                count++;
            }
        }
        if (count > 0 && typeof context.saveChat === 'function') {
            context.saveChat();
            updateHideStatus();
        }
    }
}

function updateHideStatus() {
    const chat = getContext().chat;
    if (!chat) return;
    const visible = chat.filter(m => !m.is_hidden && !m.is_system).length;
    const hidden = chat.filter(m => m.is_hidden && !m.is_system).length;
    const el = document.getElementById("summarizer-hide-status");
    if (el) el.textContent = `显示:${visible} 隐藏:${hidden} 总:${chat.filter(m => !m.is_system).length}`;
}

function unhideAll() {
    const context = getContext();
    const chat = context.chat;
    if (!chat) return;

    let count = 0;
    chat.forEach(m => { if (m.is_hidden) { m.is_hidden = false; count++; } });
    if (count > 0 && typeof context.saveChat === 'function') context.saveChat();

    updateHideStatus();
    document.getElementById("summarizer-output").textContent = `已取消隐藏 ${count} 条`;
}

function resetWorldInfoBinding() {
    const settings = getSettings();
    settings.worldInfoEntryUid = null;
    saveSettings();
    updateWorldInfoStatus("已重置，下次总结创建新条目");
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

        settings.savedSummaries.push({ time: new Date().toLocaleString(), range, content: summary });

        if (settings.autoWorldInfo) await appendToWorldInfo(summary, range);

        if (settings.autoHide) {
            const hideUntil = len - settings.keepVisible;
            if (hideUntil > 0) {
                hideMessages(0, hideUntil);
                out.textContent = `[隐藏1-${hideUntil}楼]\n\n${summary}`;
            } else out.textContent = summary;
        } else out.textContent = summary;

        settings.lastSummarizedIndex = len;
        saveSettings();
        updateHideStatus();

    } catch (e) { out.textContent = "错误: " + e.message; }
    btn.disabled = false;
}

async function checkAuto() {
    const settings = getSettings();
    if (settings.autoHide) checkContinuousHide();
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

            settings.savedSummaries.push({ time: new Date().toLocaleString(), range, content: summary, auto: true });
            if (settings.autoWorldInfo) await appendToWorldInfo(summary, range);
            if (settings.autoHide) {
                const hideUntil = len - settings.keepVisible;
                if (hideUntil > 0) hideMessages(0, hideUntil);
            }

            settings.lastSummarizedIndex = len;
            saveSettings();
            updateHideStatus();
            out.textContent = `[自动完成]\n${summary}`;
        } catch (e) { out.textContent = "自动失败: " + e.message; }
    }
}

function showHistory() {
    const s = getSettings();
    const out = document.getElementById("summarizer-output");
    if (!s.savedSummaries.length) { out.textContent = "无历史"; return; }
    out.textContent = s.savedSummaries.slice().reverse().map(x =>
        `【${x.time}】${x.range}${x.auto ? "(自动)" : ""}\n${x.content}`
    ).join("\n\n---\n\n");
}

function clearHistory() {
    const s = getSettings();
    s.savedSummaries = [];
    s.lastSummarizedIndex = 0;
    saveSettings();
    document.getElementById("summarizer-output").textContent = "已清空";
}

function refreshChatWorldInfo() {
    const worldName = getChatWorldInfoName();
    if (worldName) {
        updateWorldInfoStatus(`聊天世界书: ${worldName}`);
    } else {
        updateWorldInfoStatus("未绑定聊天世界书");
    }
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
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                <div><label>API地址:</label><input type="text" id="summarizer-api-endpoint" class="text_pole" placeholder="https://xxx/v1"></input></div>
                <div><label>API密钥:</label><input type="password" id="summarizer-api-key" class="text_pole"></input></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr auto auto;gap:8px;align-items:end;margin-bottom:8px;">
                <div><label>模型:</label><select id="summarizer-model-select" class="text_pole"><option>--</option></select></div>
                <div><label>手动输入:</label><input type="text" id="summarizer-model-manual" class="text_pole"></input></div>
                <button id="summarizer-fetch-models" class="menu_button">获取</button>
                <button id="summarizer-test-btn" class="menu_button">测试</button>
            </div>
            <div id="summarizer-status" style="font-size:12px;color:gray;margin-bottom:8px;">未连接</div>
            <hr></hr>
            <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;margin:8px 0;">
                <div><label>总结提示词:</label><textarea id="summarizer-prompt" class="text_pole" rows="2"></textarea></div>
                <div><label>总结条数:</label><input type="number" id="summarizer-max-msgs" class="text_pole" min="5" max="200"></input></div>
                <div><label>自动间隔:</label><input type="number" id="summarizer-trigger-interval" class="text_pole" min="10" max="200"></input></div>
                <div><label>保留显示:</label><input type="number" id="summarizer-keep-visible" class="text_pole" min="1" max="100"></input></div>
            </div>
            <div style="display:flex;gap:15px;align-items:center;margin:8px 0;">
                <label class="checkbox_label"><input type="checkbox" id="summarizer-auto-enabled"> 自动总结</input></label>
                <label class="checkbox_label"><input type="checkbox" id="summarizer-auto-hide"> 自动隐藏</input></label>
                <label class="checkbox_label"><input type="checkbox" id="summarizer-auto-worldinfo"> 写入世界书</input></label>
            </div>
            <div style="display:flex;gap:15px;font-size:12px;color:#888;margin:5px 0;">
                <span id="summarizer-hide-status">显示:- 隐藏:- 总:-</span>
                <span id="summarizer-worldinfo-status">世界书: 检测中...</span>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px;">
                <button id="summarizer-btn" class="menu_button">总结</button>
                <button id="summarizer-history-btn" class="menu_button">历史</button>
                <button id="summarizer-clear-btn" class="menu_button">清空</button>
                <button id="summarizer-unhide-btn" class="menu_button">取消隐藏</button>
                <button id="summarizer-reset-worldinfo" class="menu_button">重置条目</button>
                <button id="summarizer-refresh-worldinfo" class="menu_button">刷新世界书</button>
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
    $("#summarizer-reset-worldinfo").on("click", resetWorldInfoBinding);
    $("#summarizer-refresh-worldinfo").on("click", refreshChatWorldInfo);

    eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(checkAuto, 1000));
    eventSource.on(event_types.MESSAGE_SENT, () => setTimeout(checkAuto, 1000));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            refreshChatWorldInfo();
            updateHideStatus();
        }, 500);
    });

    setTimeout(() => {
        updateHideStatus();
        refreshChatWorldInfo();
    }, 500);

    console.log("痔疮总结机 loaded");
});
