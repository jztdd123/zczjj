import { getContext, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";
import { world_info, createWorldInfoEntry, saveWorldInfo, setWIOriginalDataValue } from "../../../world-info.js";

const extensionName = "st-summarizer";
const localStorageKey = "summarizer_credentials";

const defaultSettings = {
    summaryPrompt: "请用简洁的中文总结以上对话的主要内容，保留关键信息和角色行为。",
    maxMessages: 20,
    autoSummarize: false,
    triggerInterval: 20,
    keepVisible: 10,
    autoHide: true,
    autoWorldBook: true,
    apiEndpoint: "",
    apiKey: "",
    model: "",
    lastSummarizedIndex: 0,
    savedSummaries: [],
    worldBookEntryUid: null,
    worldBookName: null
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

// 生成时间戳名称
function generateEntryName() {
    const context = getContext();
    const charName = context.name2 || "Unknown";
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}@${String(now.getHours()).padStart(2, '0')}h${String(now.getMinutes()).padStart(2, '0')}m${String(now.getSeconds()).padStart(2, '0')}s`;
    return `${charName} - ${timestamp}`;
}

// 创建或获取世界书
async function getOrCreateWorldBook() {
    const settings = getSettings();
    const context = getContext();

    // 检查是否已有绑定的世界书
    if (settings.worldBookName) {
        const existingBook = world_info.charLore?.find(w => w.name === settings.worldBookName);
        if (existingBook) {
            return settings.worldBookName;
        }
    }

    // 创建新世界书名称
    const charName = context.name2 || "Summary";
    const bookName = `${charName}_Summaries`;

    // 通过API创建世界书
    try {
        const response = await fetch('/api/worldinfo/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: bookName })
        });

        if (!response.ok) {
            // 可能已存在，继续使用
            console.log("世界书可能已存在:", bookName);
        }

        settings.worldBookName = bookName;
        saveSettings();

        return bookName;
    } catch (e) {
        console.error("创建世界书失败:", e);
        throw e;
    }
}

// 绑定世界书到角色聊天
async function bindWorldBookToChat(bookName) {
    const context = getContext();

    try {
        // 设置聊天世界书
        const response = await fetch('/api/worldinfo/bind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: bookName,
                avatar: context.characterId,
                bind_type: 'chat' // 绑定到聊天而非角色
            })
        });

        if (response.ok) {
            console.log("已绑定世界书到聊天:", bookName);
        }
    } catch (e) {
        console.error("绑定世界书失败:", e);
    }
}

// 添加总结到世界书条目
async function addSummaryToWorldBook(summary, range) {
    const settings = getSettings();

    try {
        const bookName = await getOrCreateWorldBook();

        // 获取世界书数据
        const response = await fetch(`/api/worldinfo/get?name=${encodeURIComponent(bookName)}`);
        const worldData = await response.json();

        const now = new Date();
        const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}@${String(now.getHours()).padStart(2, '0')}h${String(now.getMinutes()).padStart(2, '0')}m${String(now.getSeconds()).padStart(2, '0')}s`;

        // 检查是否已有条目
        let entryUid = settings.worldBookEntryUid;
        let existingEntry = null;

        if (entryUid !== null && worldData.entries) {
            existingEntry = worldData.entries[entryUid];
        }

        const newSummaryBlock = `\n\n【${timeStr} | 消息 ${range}】\n${summary}`;

        if (existingEntry) {
            // 追加到现有条目
            const updatedContent = existingEntry.content + newSummaryBlock;

            await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: bookName,
                    uid: entryUid,
                    field: 'content',
                    value: updatedContent
                })
            });

            console.log("已追加总结到世界书条目");

        } else {
            // 创建新条目
            const entryName = generateEntryName();

            const newEntry = {
                key: ["总结", "summary", "记忆"],
                keysecondary: [],
                comment: entryName,
                content: `【对话总结记录】\n${newSummaryBlock}`,
                constant: true,           // 蓝灯 - 常驻
                selective: false,
                order: 100,
                position: 0,
                depth: 2,                  // D2
                disable: false,
                excludeRecursion: false,
                probability: 100,
                useProbability: false,
                group: "",
                scanDepth: null,
                caseSensitive: false,
                matchWholeWords: false,
                automationId: "",
                vectorized: false
            };

            const createResponse = await fetch('/api/worldinfo/create-entry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: bookName,
                    entry: newEntry
                })
            });

            if (createResponse.ok) {
                const result = await createResponse.json();
                settings.worldBookEntryUid = result.uid;
                saveSettings();
                console.log("已创建世界书条目:", entryName, "UID:", result.uid);
            }

            // 绑定到聊天
            await bindWorldBookToChat(bookName);
        }

        return true;

    } catch (e) {
        console.error("添加总结到世界书失败:", e);
        return false;
    }
}

// 使用SillyTavern内置API的备用方法
async function addSummaryToWorldBookFallback(summary, range) {
    const settings = getSettings();
    const context = getContext();

    try {
        const charName = context.name2 || "Unknown";
        const now = new Date();
        const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}@${String(now.getHours()).padStart(2, '0')}h${String(now.getMinutes()).padStart(2, '0')}m${String(now.getSeconds()).padStart(2, '0')}s`;

        // 使用jQuery触发世界书创建
        const bookName = `${charName}_Summaries`;
        const entryName = `${charName} - ${timeStr}`;

        const summaryContent = `【${timeStr} | 消息 ${range}】\n${summary}`;

        // 检查chat_metadata中是否有世界书
        if (!context.chatMetadata) {
            context.chatMetadata = {};
        }

        // 存储到chat metadata作为备用
        if (!context.chatMetadata.summaries) {
            context.chatMetadata.summaries = [];
        }
        context.chatMetadata.summaries.push({
            time: timeStr,
            range: range,
            content: summary
        });

        // 尝试通过全局world_info对象
        if (typeof world_info !== 'undefined' && world_info.data) {
            // 查找或创建条目
            let foundEntry = null;
            let foundUid = null;

            for (const [uid, entry] of Object.entries(world_info.data.entries || {})) {
                if (entry.comment && entry.comment.startsWith(charName + " - ") && entry.constant) {
                    foundEntry = entry;
                    foundUid = uid;
                    break;
                }
            }

            if (foundEntry) {
                // 追加内容
                foundEntry.content += `\n\n${summaryContent}`;
                await saveWorldInfo(world_info.name, world_info.data);
            } else {
                // 创建新条目
                const newUid = await createWorldInfoEntry(world_info.name, world_info.data);
                if (newUid !== null) {
                    const entry = world_info.data.entries[newUid];
                    entry.comment = entryName;
                    entry.content = `【对话总结记录】\n\n${summaryContent}`;
                    entry.constant = true;
                    entry.depth = 2;
                    entry.key = ["总结", "summary"];
                    await saveWorldInfo(world_info.name, world_info.data);
                    settings.worldBookEntryUid = newUid;
                    saveSettings();
                }
            }
        }

        console.log("总结已保存");
        return true;

    } catch (e) {
        console.error("保存总结失败:", e);
        return false;
    }
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
    if (!chat) return;

    let hiddenCount = 0;
    for (let i = startIdx; i < endIdx && i < chat.length; i++) {
        if (!chat[i].is_system && !chat[i].is_hidden) {
            chat[i].is_hidden = true;
            hiddenCount++;
        }
    }

    if (hiddenCount > 0 && typeof context.saveChat === 'function') {
        context.saveChat();
    }

    return hiddenCount;
}

function checkContinuousHide() {
    const settings = getSettings();
    if (!settings.autoHide) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const hideUntil = chat.length - settings.keepVisible;

    if (hideUntil > 0) {
        let hiddenCount = 0;
        for (let i = 0; i < hideUntil; i++) {
            if (!chat[i].is_system && !chat[i].is_hidden) {
                chat[i].is_hidden = true;
                hiddenCount++;
            }
        }

        if (hiddenCount > 0 && typeof context.saveChat === 'function') {
            context.saveChat();
            updateHideStatus();
        }
    }
}

function updateHideStatus() {
    const context = getContext();
    const chat = context.chat;
    if (!chat) return;

    const visible = chat.filter(m => !m.is_hidden && !m.is_system).length;
    const hidden = chat.filter(m => m.is_hidden && !m.is_system).length;
    const total = chat.filter(m => !m.is_system).length;

    const statusEl = document.getElementById("summarizer-hide-status");
    if (statusEl) {
        statusEl.textContent = `显示: ${visible} | 隐藏: ${hidden} | 总计: ${total}`;
    }
}

function unhideAll() {
    const context = getContext();
    const chat = context.chat;
    if (!chat) return;

    let count = 0;
    for (const msg of chat) {
        if (msg.is_hidden) {
            msg.is_hidden = false;
            count++;
        }
    }

    if (count > 0 && typeof context.saveChat === 'function') {
        context.saveChat();
    }

    updateHideStatus();
    document.getElementById("summarizer-output").textContent = `已取消隐藏 ${count} 条消息`;
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

        // 保存到历史
        settings.savedSummaries.push({
            time: new Date().toLocaleString(),
            range: range,
            content: summary
        });

        // 保存到世界书
        if (settings.autoWorldBook) {
            out.textContent = "写入世界书...";
            const wbResult = await addSummaryToWorldBookFallback(summary, range);
            if (wbResult) {
                out.textContent = `[已写入世界书]\n\n${summary}`;
            } else {
                out.textContent = `[世界书写入失败]\n\n${summary}`;
            }
        } else {
            out.textContent = summary;
        }

        // 自动隐藏
        if (settings.autoHide) {
            const hideUntil = len - settings.keepVisible;
            if (hideUntil > 0) {
                hideMessages(0, hideUntil);
                out.textContent = `[已隐藏 1-${hideUntil} 楼]\n\n` + out.textContent;
            }
        }

        settings.lastSummarizedIndex = len;
        saveSettings();
        updateHideStatus();

    } catch (e) {
        out.textContent = "错误: " + e.message;
    }
    btn.disabled = false;
}

async function checkAuto() {
    const settings = getSettings();

    if (settings.autoHide) {
        checkContinuousHide();
    }

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

            // 写入世界书
            if (settings.autoWorldBook) {
                await addSummaryToWorldBookFallback(summary, range);
            }

            if (settings.autoHide) {
                const hideUntil = len - settings.keepVisible;
                if (hideUntil > 0) {
                    hideMessages(0, hideUntil);
                }
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
    s.worldBookEntryUid = null;
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
                <label class="checkbox_label"><input type="checkbox" id="summarizer-auto-worldbook"> 写入世界书</input></label>
            </div>
            <div id="summarizer-hide-status" style="font-size:12px;color:#888;margin:5px 0;">显示: - | 隐藏: - | 总计: -</div>
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
    $("#summarizer-auto-worldbook").prop("checked", s.autoWorldBook).on("change", function() { s.autoWorldBook = this.checked; saveSettings(); });

    $("#summarizer-fetch-models").on("click", refreshModelList);
    $("#summarizer-test-btn").on("click", testConnection);
    $("#summarizer-btn").on("click", doSummarize);
    $("#summarizer-history-btn").on("click", showHistory);
    $("#summarizer-clear-btn").on("click", clearHistory);
    $("#summarizer-unhide-btn").on("click", unhideAll);

    eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(checkAuto, 1000));
    eventSource.on(event_types.MESSAGE_SENT, () => setTimeout(checkAuto, 1000));

    setTimeout(updateHideStatus, 500);

    console.log("痔疮总结机 loaded");
});
