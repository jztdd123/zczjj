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

// 本地存储凭证
function saveCredentialsLocal(endpoint, key) {
    const data = { apiEndpoint: endpoint, apiKey: key };
    localStorage.setItem(localStorageKey, JSON.stringify(data));
}

function loadCredentialsLocal() {
    try {
        const data = localStorage.getItem(localStorageKey);
        return data ? JSON.parse(data) : null;
    } catch {
        return null;
    }
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

    // 从本地存储加载凭证（优先级高于extension_settings）
    const localCreds = loadCredentialsLocal();
    if (localCreds) {
        if (localCreds.apiEndpoint) extension_settings[extensionName].apiEndpoint = localCreds.apiEndpoint;
        if (localCreds.apiKey) extension_settings[extensionName].apiKey = localCreds.apiKey;
    }
}

function getSettings() {
    return extension_settings[extensionName];
}

function saveSettings() {
    const settings = getSettings();
    saveCredentialsLocal(settings.apiEndpoint, settings.apiKey);
    saveSettingsDebounced();
}

// 获取模型列表
async function fetchModels() {
    const settings = getSettings();
    if (!settings.apiEndpoint || !settings.apiKey) {
        throw new Error("请先填写API地址和密钥");
    }

    // 构建models端点
    let modelsUrl = settings.apiEndpoint;
    if (modelsUrl.endsWith("/chat/completions")) {
        modelsUrl = modelsUrl.replace("/chat/completions", "/models");
    } else if (modelsUrl.endsWith("/v1")) {
        modelsUrl = modelsUrl + "/models";
    } else if (!modelsUrl.endsWith("/models")) {
        modelsUrl = modelsUrl.replace(/\/?$/, "/models");
    }

    const response = await fetch(modelsUrl, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${settings.apiKey}`
        }
    });

    if (!response.ok) {
        throw new Error(`获取模型列表失败: ${response.status}`);
    }

    const data = await response.json();
    return data.data || data.models || [];
}

// 测试API连接
async function testConnection() {
    const settings = getSettings();
    const statusDiv = document.getElementById("summarizer-status");

    statusDiv.textContent = "测试连接中...";
    statusDiv.style.color = "orange";

    try {
        if (!settings.apiEndpoint || !settings.apiKey || !settings.model) {
            throw new Error("请填写完整的API配置");
        }

        const requestBody = {
            model: settings.model,
            messages: [{ role: "user", content: "Hi" }],
            max_tokens: 5
        };

        const response = await fetch(settings.apiEndpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`${response.status} - ${errText.slice(0, 100)}`);
        }

        const data = await response.json();
        if (data.choices && data.choices.length > 0) {
            statusDiv.textContent = "✓ 连接成功";
            statusDiv.style.color = "lime";
        } else {
            throw new Error("响应格式异常");
        }
    } catch (error) {
        statusDiv.textContent = "✗ " + error.message;
        statusDiv.style.color = "red";
    }
}

// 刷新模型列表UI
async function refreshModelList() {
    const selectEl = document.getElementById("summarizer-model-select");
    const statusDiv = document.getElementById("summarizer-status");

    selectEl.innerHTML = '<option value="">加载中...</option>';
    statusDiv.textContent = "获取模型列表...";
    statusDiv.style.color = "orange";

    try {
        const models = await fetchModels();

        selectEl.innerHTML = '<option value="">-- 选择模型 --</option>';

        models.forEach(m => {
            const modelId = m.id || m.name || m;
            const option = document.createElement("option");
            option.value = modelId;
            option.textContent = modelId;
            selectEl.appendChild(option);
        });

        // 选中已保存的模型
        const settings = getSettings();
        if (settings.model) {
            selectEl.value = settings.model;
        }

        statusDiv.textContent = `✓ 获取到 ${models.length} 个模型`;
        statusDiv.style.color = "lime";

    } catch (error) {
        selectEl.innerHTML = '<option value="">获取失败</option>';
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
        if (msg.is_user) {
            chatText += `用户: ${msg.mes}\n\n`;
        } else if (msg.is_system) {
            continue;
        } else {
            chatText += `${msg.name}: ${msg.mes}\n\n`;
        }
    }
    return chatText;
}

async function callCustomAPI(prompt) {
    const settings = getSettings();

    if (!settings.apiEndpoint || !settings.apiKey) {
        throw new Error("请先配置API地址和密钥");
    }

    const requestBody = {
        model: settings.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 2000
    };

    const response = await fetch(settings.apiEndpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${settings.apiKey}`
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API请求失败: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "总结生成失败";
}

async function doManualSummarize() {
    const settings = getSettings();
    const outputDiv = document.getElementById("summarizer-output");
    const btn = document.getElementById("summarizer-btn");

    outputDiv.textContent = "正在生成总结...";
    btn.disabled = true;

    try {
        const context = getContext();
        const chatLength = context.chat?.length || 0;
        const startIndex = Math.max(0, chatLength - settings.maxMessages);

        const chatContent = getRecentChat(startIndex, chatLength);
        if (!chatContent) {
            outputDiv.textContent = "没有找到聊天记录。";
            btn.disabled = false;
            return;
        }

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
        console.error("Summarizer error:", error);
        outputDiv.textContent = "发生错误: " + error.message;
    }
    btn.disabled = false;
}

async function checkAutoSummarize() {
    const settings = getSettings();
    if (!settings.autoSummarize) return;

    const context = getContext();
    const chatLength = context.chat?.length || 0;
    const messagesSinceLastSummary = chatLength - settings.lastSummarizedIndex;

    if (messagesSinceLastSummary >= settings.triggerInterval) {
        console.log(`痔疮总结机: 触发自动总结`);

        try {
            const startIndex = settings.lastSummarizedIndex;
            const endIndex = chatLength;

            const chatContent = getRecentChat(startIndex, endIndex);
            if (!chatContent) return;

            const prompt = `${chatContent}\n\n---\n${settings.summaryPrompt}`;
            const summary = await callCustomAPI(prompt);

            settings.savedSummaries.push({
                time: new Date().toLocaleString(),
                range: `${startIndex + 1}-${endIndex}`,
                content: summary,
                auto: true
            });

            settings.lastSummarizedIndex = chatLength;
            saveSettings();

            const outputDiv = document.getElementById("summarizer-output");
            if (outputDiv) {
                outputDiv.textContent = `[自动总结完成]\n${summary}`;
            }

        } catch (error) {
            console.error("痔疮总结机 自动总结失败:", error);
        }
    }
}

function showSummaryHistory() {
    const settings = getSettings();
    const outputDiv = document.getElementById("summarizer-output");

    if (settings.savedSummaries.length === 0) {
        outputDiv.textContent = "暂无历史总结";
        return;
    }

    let historyText = "=== 历史总结 ===\n\n";
    for (let i = settings.savedSummaries.length - 1; i >= 0; i--) {
        const s = settings.savedSummaries[i];
        historyText += `【${s.time}】消息 ${s.range} ${s.auto ? "(自动)" : "(手动)"}\n${s.content}\n\n---\n\n`;
    }
    outputDiv.textContent = historyText;
}

function clearHistory() {
    const settings = getSettings();
    settings.savedSummaries = [];
    settings.lastSummarizedIndex = 0;
    saveSettings();
    document.getElementById("summarizer-output").textContent = "历史已清空";
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

            <h4>API 配置</h4>
            <label>API地址 (completions端点):</label>
            <input type="text" id="summarizer-api-endpoint" class="text_pole" placeholder="https://api.openai.com/v1/chat/completions">
</input>
            <label>API密钥:</label>
            <input type="password" id="summarizer-api-key" class="text_pole" placeholder="sk-...">
</input>
            <div style="display:flex; gap:5px; margin:8px 0;">
                <button id="summarizer-fetch-models" class="menu_button">获取模型</button>
                <button id="summarizer-test-btn" class="menu_button">测试连接</button>
            </div>

            <label>选择模型:</label>
            <select id="summarizer-model-select" class="text_pole">
                <option value="">-- 先获取模型列表 --</option>
            </select>

            <label>或手动输入模型名:</label>
            <input type="text" id="summarizer-model-manual" class="text_pole" placeholder="gpt-4o-mini">
</input>
            <div id="summarizer-status" style="padding:5px; margin:5px 0; font-size:12px; color:gray;">未连接</div>

            <hr></hr>
            <h4>总结设置</h4>

            <label>总结提示词:</label>
            <textarea id="summarizer-prompt" class="text_pole" rows="3"></textarea>

            <label>手动总结消息数:</label>
            <input type="number" id="summarizer-max-msgs" class="text_pole" min="5" max="200" value="20">
</input>
            <hr></hr>
            <h4>自动总结</h4>

            <label class="checkbox_label">
                <input type="checkbox" id="summarizer-auto-enabled">
                启用自动总结</input>
            </label>

            <label>每隔N条消息自动总结:</label>
            <input type="number" id="summarizer-trigger-interval" class="text_pole" min="10" max="200" value="20">
</input>
            <hr></hr>
            <div style="display:flex; gap:5px; flex-wrap:wrap;">
                <button id="summarizer-btn" class="menu_button">手动总结</button>
                <button id="summarizer-history-btn" class="menu_button">查看历史</button>
                <button id="summarizer-clear-btn" class="menu_button">清空历史</button>
            </div>

            <div id="summarizer-output" style="margin-top:10px; padding:10px; background:var(--SmartThemeBlurTintColor); border-radius:5px; max-height:300px; overflow-y:auto; white-space:pre-wrap;">点击按钮生成对话总结</div>
        </div>
    </div>`;

    $("#extensions_settings2").append(settingsHtml);

    // 填充设置
    $("#summarizer-api-endpoint").val(settings.apiEndpoint);
    $("#summarizer-api-key").val(settings.apiKey);
    $("#summarizer-model-manual").val(settings.model);
    $("#summarizer-prompt").val(settings.summaryPrompt);
    $("#summarizer-max-msgs").val(settings.maxMessages);
    $("#summarizer-auto-enabled").prop("checked", settings.autoSummarize);
    $("#summarizer-trigger-interval").val(settings.triggerInterval);

    // 事件绑定
    $("#summarizer-api-endpoint").on("change", function() {
        settings.apiEndpoint = $(this).val().trim();
        saveSettings();
    });

    $("#summarizer-api-key").on("change", function() {
        settings.apiKey = $(this).val().trim();
        saveSettings();
    });

    $("#summarizer-model-select").on("change", function() {
        const val = $(this).val();
        if (val) {
            settings.model = val;
            $("#summarizer-model-manual").val(val);
            saveSettings();
        }
    });

    $("#summarizer-model-manual").on("change", function() {
        settings.model = $(this).val().trim();
        saveSettings();
    });

    $("#summarizer-prompt").on("change", function() {
        settings.summaryPrompt = $(this).val();
        saveSettings();
    });

    $("#summarizer-max-msgs").on("change", function() {
        settings.maxMessages = parseInt($(this).val()) || 20;
        saveSettings();
    });

    $("#summarizer-auto-enabled").on("change", function() {
        settings.autoSummarize = $(this).is(":checked");
        saveSettings();
    });

    $("#summarizer-trigger-interval").on("change", function() {
        settings.triggerInterval = parseInt($(this).val()) || 20;
        saveSettings();
    });

    $("#summarizer-fetch-models").on("click", refreshModelList);
    $("#summarizer-test-btn").on("click", testConnection);
    $("#summarizer-btn").on("click", doManualSummarize);
    $("#summarizer-history-btn").on("click", showSummaryHistory);
    $("#summarizer-clear-btn").on("click", clearHistory);

    // 监听消息事件
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        setTimeout(checkAutoSummarize, 1000);
    });
    eventSource.on(event_types.MESSAGE_SENT, () => {
        setTimeout(checkAutoSummarize, 1000);
    });

    console.log("痔疮总结机 loaded.");
});
