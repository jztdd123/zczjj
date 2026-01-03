import { getContext, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";

const extensionName = "st-summarizer";
const localStorageKey = "summarizer_credentials";

const defaultSettings = {
    summaryPrompt: "请用简洁的中文总结以上对话的主要内容，保留关键信息和角色行为。",
    maxMessages: 20,
    autoSummarize: true,
    triggerInterval: 20,
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
    try {
        const data = localStorage.getItem(localStorageKey);
        return data ? JSON.parse(data) : null;
    } catch { return null; }
}

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }
    const localCreds = loadCredentialsLocal();
    if (localCreds) {
        if (localCreds.apiEndpoint) extension_settings[extensionName].apiEndpoint = localCreds.apiEndpoint;
        if (localCreds.apiKey) extension_settings[extensionName].apiKey = localCreds.apiKey;
    }
}

function getSettings() { return extension_settings[extensionName]; }

function saveSettings() {
    const settings = getSettings();
    saveCredentialsLocal(settings.apiEndpoint, settings.apiKey);
    saveSettingsDebounced();
}

// 通过ST后端代理请求，避免CORS
async function proxyFetch(url, options) {
    // 尝试使用ST的代理端点
    const proxyUrl = "/api/extensions/fetch";

    try {
        const response = await fetch(proxyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: url,
                method: options.method || "GET",
                headers: options.headers || {},
                body: options.body || null
            })
        });
        return response;
    } catch {
        // fallback: 直接请求（可能遇到CORS）
        return fetch(url, options);
    }
}

// 直接fetch，增加错误处理
async function directFetch(url, options) {
    return fetch(url, options);
}

async function fetchModels() {
    const settings = getSettings();
    if (!settings.apiEndpoint || !settings.apiKey) {
        throw new Error("请先填写API地址和密钥");
    }

    let modelsUrl = settings.apiEndpoint;
    if (modelsUrl.includes("/chat/completions")) {
        modelsUrl = modelsUrl.replace("/chat/completions", "/models");
    } else if (modelsUrl.endsWith("/v1")) {
        modelsUrl = modelsUrl + "/models";
    } else if (!modelsUrl.includes("/models")) {
        const base = modelsUrl.replace(/\/+$/, "");
        modelsUrl = base + "/models";
    }

    const response = await fetch(modelsUrl, {
        method: "GET",
        headers: { "Authorization": `Bearer ${settings.apiKey}` }
    });

    if (!response.ok) throw new Error(`获取模型失败: ${response.status}`);
    const data = await response.json();
    return data.data || data.models || [];
}

async function testConnection() {
    const settings = getSettings();
    const statusDiv = document.getElementById("summarizer-status");
    statusDiv.textContent = "测试中...";
    statusDiv.style.color = "orange";

    try {
        if (!settings.apiEndpoint || !settings.apiKey || !settings.model) {
            throw new Error("请填写完整配置");
        }

        // 使用ST的代理接口
        const response = await fetch("/api/backends/chat-completions/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: settings.apiEndpoint,
                key: settings.apiKey,
                model: settings.model,
                messages: [{ role: "user", content: "test" }],
                max_tokens: 5
            })
        });

        // 如果ST代理不可用，直接请求
        if (response.status === 404) {
            const directResponse = await fetch(settings.apiEndpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${settings.apiKey}`
                },
                body: JSON.stringify({
                    model: settings.model,
                    messages: [{ role: "user", content: "Hi" }],
                    max_tokens: 5
                })
            });

            if (!directResponse.ok) {
                const errText = await directResponse.text();
                throw new Error(`${directResponse.status}: ${errText.slice(0, 80)}`);
            }
            const data = await directResponse.json();
            if (data.choices) {
                statusDiv.textContent = "✓ 连接成功";
                statusDiv.style.color = "lime";
                return;
            }
        }

        if (response.ok) {
            statusDiv.textContent = "✓ 连接成功";
            statusDiv.style.color = "lime";
        } else {
            throw new Error(`${response.status}`);
        }

    } catch (error) {
        statusDiv.textContent = "✗ " + error.message;
        statusDiv.style.color = "red";
    }
}

async function refreshModelList() {
    const selectEl = document.getElementById("summarizer-model-select");
    const statusDiv = document.getElementById("summarizer-status");
    selectEl.innerHTML = '<option value="">加载中...</option>';
    statusDiv.textContent = "获取模型...";
    statusDiv.style.color = "orange";

    try {
        const models = await fetchModels();
        selectEl.innerHTML = '<option value="">-- 选择 --</option>';
        models.forEach(m => {
            const modelId = m.id || m.name || m;
            const opt = document.createElement("option");
            opt.value = modelId;
            opt.textContent = modelId;
            selectEl.appendChild(opt);
        });
        const settings = getSettings();
        if (settings.model) selectEl.value = settings.model;
        statusDiv.textContent = `✓ ${models.length} 个模型`;
        statusDiv.style.color = "lime";
    } catch (error) {
        selectEl.innerHTML = '<option value="">失败</option>';
        statusDiv.textContent = "✗ " + error.message;
        statusDiv.style.color = "red";
    }
}

function getRecentChat(startIndex, endIndex) {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return null;
    const messages = chat.slice(startIndex, endIndex);
    let chatText = "";
    for (const msg of messages) {
        if (msg.is_user) chatText += `用户: ${msg.mes}\n\n`;
        else if (msg.is_system) continue;
        else chatText += `${msg.name}: ${msg.mes}\n\n`;
    }
    return chatText;
}

async function callCustomAPI(prompt) {
    const settings = getSettings();
    if (!settings.apiEndpoint || !settings.apiKey) throw new Error("请先配置API");

    const response = await fetch(settings.apiEndpoint, {
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

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API失败: ${response.status}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "总结失败";
}

async function doManualSummarize() {
    const settings = getSettings();
    const outputDiv = document.getElementById("summarizer-output");
    const btn = document.getElementById("summarizer-btn");
    outputDiv.textContent = "生成中...";
    btn.disabled = true;

    try {
        const context = getContext();
        const chatLength = context.chat?.length || 0;
        const startIndex = Math.max(0, chatLength - settings.maxMessages);
        const chatContent = getRecentChat(startIndex, chatLength);
        if (!chatContent) { outputDiv.textContent = "无聊天记录"; btn.disabled = false; return; }

        const prompt = `${chatContent}\n\n---\n${settings.summaryPrompt}`;
        const summary = await callCustomAPI(prompt);
        outputDiv.textContent = summary;

        settings.savedSummaries.push({
            time: new Date().toLocaleString(),
            range: `${startIndex + 1}-${chatLength}`,
            content: summary
        });
        saveSettings();
    } catch (error) {
        outputDiv.textContent = "错误: " + error.message;
    }
    btn.disabled = false;
}

async function checkAutoSummarize() {
    const settings = getSettings();
    if (!settings.autoSummarize) return;
    const context = getContext();
    const chatLength = context.chat?.length || 0;
    const diff = chatLength - settings.lastSummarizedIndex;

    if (diff >= settings.triggerInterval) {
        try {
            const chatContent = getRecentChat(settings.lastSummarizedIndex, chatLength);
            if (!chatContent) return;
            const prompt = `${chatContent}\n\n---\n${settings.summaryPrompt}`;
            const summary = await callCustomAPI(prompt);

            settings.savedSummaries.push({
                time: new Date().toLocaleString(),
                range: `${settings.lastSummarizedIndex + 1}-${chatLength}`,
                content: summary,
                auto: true
            });
            settings.lastSummarizedIndex = chatLength;
            saveSettings();

            const outputDiv = document.getElementById("summarizer-output");
            if (outputDiv) outputDiv.textContent = `[自动]\n${summary}`;
        } catch (e) { console.error("自动总结失败", e); }
    }
}

function showHistory() {
    const settings = getSettings();
    const outputDiv = document.getElementById("summarizer-output");
    if (settings.savedSummaries.length === 0) { outputDiv.textContent = "无历史"; return; }
    let text = "=== 历史 ===\n\n";
    for (let i = settings.savedSummaries.length - 1; i >= 0; i--) {
        const s = settings.savedSummaries[i];
        text += `【${s.time}】${s.range} ${s.auto ? "(自动)" : ""}\n${s.content}\n\n---\n\n`;
    }
    outputDiv.textContent = text;
}

function clearHistory() {
    const settings = getSettings();
    settings.savedSummaries = [];
    settings.lastSummarizedIndex = 0;
    saveSettings();
    document.getElementById("summarizer-output").textContent = "已清空";
}

jQuery(async () => {
    loadSettings();
    const settings = getSettings();

    const settingsHtml = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>痔疮总结机</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                <div>
                    <label>API地址:</label>
                    <input type="text" id="summarizer-api-endpoint" class="text_pole" placeholder="https://..."></input>
                </div>
                <div>
                    <label>API密钥:</label>
                    <input type="password" id="summarizer-api-key" class="text_pole" placeholder="sk-..."></input>
                </div>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr auto auto; gap:10px; margin-top:8px; align-items:end;">
                <div>
                    <label>选择模型:</label>
                    <select id="summarizer-model-select" class="text_pole">
                        <option value="">--</option>
                    </select>
                </div>
                <div>
                    <label>手动输入:</label>
                    <input type="text" id="summarizer-model-manual" class="text_pole" placeholder="model-name"></input>
                </div>
                <button id="summarizer-fetch-models" class="menu_button" style="height:35px;">获取模型</button>
                <button id="summarizer-test-btn" class="menu_button" style="height:35px;">测试</button>
            </div>

            <div id="summarizer-status" style="font-size:12px; color:gray; margin:5px 0;">未连接</div>

            <hr>
</hr>
            <div style="display:grid; grid-template-columns:2fr 1fr 1fr; gap:10px;">
                <div>
                    <label>总结提示词:</label>
                    <textarea id="summarizer-prompt" class="text_pole" rows="2" style="resize:vertical;"></textarea>
                </div>
                <div>
                    <label>手动总结条数:</label>
                    <input type="number" id="summarizer-max-msgs" class="text_pole" min="5" max="200"></input>
                </div>
                <div>
                    <label>自动间隔:</label>
                    <input type="number" id="summarizer-trigger-interval" class="text_pole" min="10" max="200"></input>
                </div>
            </div>

            <div style="display:flex; gap:10px; margin-top:10px; align-items:center;">
                <label class="checkbox_label" style="margin:0;">
                    <input type="checkbox" id="summarizer-auto-enabled"> 自动总结</input>
                </label>
                <button id="summarizer-btn" class="menu_button">手动总结</button>
                <button id="summarizer-history-btn" class="menu_button">历史</button>
                <button id="summarizer-clear-btn" class="menu_button">清空</button>
            </div>

            <div id="summarizer-output" style="margin-top:10px; padding:10px; background:var(--SmartThemeBlurTintColor); border-radius:5px; max-height:200px; overflow-y:auto; white-space:pre-wrap; font-size:13px;">就绪</div>
        </div>
    </div>`;

    $("#extensions_settings2").append(settingsHtml);

    $("#summarizer-api-endpoint").val(settings.apiEndpoint);
    $("#summarizer-api-key").val(settings.apiKey);
    $("#summarizer-model-manual").val(settings.model);
    $("#summarizer-prompt").val(settings.summaryPrompt);
    $("#summarizer-max-msgs").val(settings.maxMessages);
    $("#summarizer-trigger-interval").val(settings.triggerInterval);
    $("#summarizer-auto-enabled").prop("checked", settings.autoSummarize);

    $("#summarizer-api-endpoint").on("change", function() { settings.apiEndpoint = $(this).val().trim(); saveSettings(); });
    $("#summarizer-api-key").on("change", function() { settings.apiKey = $(this).val().trim(); saveSettings(); });
    $("#summarizer-model-select").on("change", function() {
        const v = $(this).val();
        if (v) { settings.model = v; $("#summarizer-model-manual").val(v); saveSettings(); }
    });
    $("#summarizer-model-manual").on("change", function() { settings.model = $(this).val().trim(); saveSettings(); });
    $("#summarizer-prompt").on("change", function() { settings.summaryPrompt = $(this).val(); saveSettings(); });
    $("#summarizer-max-msgs").on("change", function() { settings.maxMessages = parseInt($(this).val()) || 20; saveSettings(); });
    $("#summarizer-trigger-interval").on("change", function() { settings.triggerInterval = parseInt($(this).val()) || 20; saveSettings(); });
    $("#summarizer-auto-enabled").on("change", function() { settings.autoSummarize = $(this).is(":checked"); saveSettings(); });

    $("#summarizer-fetch-models").on("click", refreshModelList);
    $("#summarizer-test-btn").on("click", testConnection);
    $("#summarizer-btn").on("click", doManualSummarize);
    $("#summarizer-history-btn").on("click", showHistory);
    $("#summarizer-clear-btn").on("click", clearHistory);

    eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(checkAutoSummarize, 1000));
    eventSource.on(event_types.MESSAGE_SENT, () => setTimeout(checkAutoSummarize, 1000));

    console.log("痔疮总结机 loaded.");
});
