import { getContext, extension_settings, saveSettingsDebounced } from "../../../extensions.js";

const extensionName = "st-summarizer";

const defaultSettings = {
    summaryPrompt: "请用简洁的中文总结以上对话的主要内容，保留关键信息和角色行为。不超过500字。",
    autoInterval: 20,
    autoEnabled: false,
    customApiUrl: "",
    customApiKey: "",
    customModel: "",
    summaries: []
};

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
}

function getSettings() {
    return extension_settings[extensionName];
}

function saveSettings() {
    saveSettingsDebounced();
}

function getChatRange(startIndex, endIndex) {
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

async function callCustomApi(prompt) {
    const settings = getSettings();

    if (!settings.customApiUrl) {
        throw new Error("未配置自定义API地址");
    }

    const requestBody = {
        model: settings.customModel || "gpt-3.5-turbo",
        messages: [
            { role: "user", content: prompt }
        ],
        max_tokens: 1000,
        temperature: 0.7
    };

    const headers = {
        "Content-Type": "application/json"
    };

    if (settings.customApiKey) {
        headers["Authorization"] = `Bearer ${settings.customApiKey}`;
    }

    const response = await fetch(settings.customApiUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API请求失败: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.choices && data.choices[0]) {
        return data.choices[0].message?.content || data.choices[0].text || "";
    }
    if (data.response) return data.response;
    if (data.content) return data.content;
    if (data.text) return data.text;

    return JSON.stringify(data);
}

let lastSummarizedIndex = 0;

async function doSummarize(startIndex, endIndex, isAuto = false) {
    const settings = getSettings();
    const outputDiv = document.getElementById("summarizer-output");
    const btn = document.getElementById("summarizer-btn");

    const statusText = isAuto ? "自动总结中..." : "正在生成总结...";
    if (outputDiv) outputDiv.textContent = statusText;
    if (btn) btn.disabled = true;

    try {
        const context = getContext();
        const chat = context.chat;

        if (startIndex === undefined) {
            endIndex = chat.length;
            startIndex = Math.max(0, endIndex - settings.autoInterval);
        }

        const chatContent = getChatRange(startIndex, endIndex);

        if (!chatContent) {
            if (outputDiv) outputDiv.textContent = "没有找到聊天记录。";
            if (btn) btn.disabled = false;
            return null;
        }

        const prompt = `${chatContent}\n\n---\n${settings.summaryPrompt}`;

        let summary;
        if (settings.customApiUrl) {
            summary = await callCustomApi(prompt);
        } else {
            if (outputDiv) outputDiv.textContent = "请先配置自定义API地址";
            if (btn) btn.disabled = false;
            return null;
        }

        if (summary) {
            const summaryRecord = {
                timestamp: Date.now(),
                startIndex: startIndex,
                endIndex: endIndex,
                content: summary
            };
            settings.summaries.push(summaryRecord);
            saveSettings();

            if (outputDiv) {
                outputDiv.textContent = `[${new Date().toLocaleString()}]\n范围: 第${startIndex + 1}条 - 第${endIndex}条\n\n${summary}`;
            }

            console.log(`痔疮总结机: 已总结第${startIndex + 1}-${endIndex}条消息`);
            return summary;
        } else {
            if (outputDiv) outputDiv.textContent = "总结生成失败。";
            return null;
        }
    } catch (error) {
        console.error("Summarizer error:", error);
        if (outputDiv) outputDiv.textContent = "发生错误: " + error.message;
        return null;
    } finally {
        if (btn) btn.disabled = false;
    }
}

function checkAutoSummarize() {
    const settings = getSettings();
    if (!settings.autoEnabled) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat) return;

    const currentLength = chat.length;
    const interval = settings.autoInterval;

    const nextTrigger = Math.floor(lastSummarizedIndex / interval) * interval + interval;

    if (currentLength >= nextTrigger && lastSummarizedIndex < nextTrigger) {
        const startIndex = nextTrigger - interval;
        const endIndex = nextTrigger;
        console.log(`痔疮总结机: 触发自动总结 (${startIndex + 1}-${endIndex})`);
        doSummarize(startIndex, endIndex, true);
        lastSummarizedIndex = endIndex;
    }
}

function showSummaryHistory() {
    const settings = getSettings();
    const outputDiv = document.getElementById("summarizer-output");

    if (!settings.summaries || settings.summaries.length === 0) {
        outputDiv.textContent = "暂无总结历史";
        return;
    }

    let historyText = "=== 总结历史 ===\n\n";
    for (const record of settings.summaries) {
        const time = new Date(record.timestamp).toLocaleString();
        historyText += `[${time}] 第${record.startIndex + 1}-${record.endIndex}条:\n${record.content}\n\n---\n\n`;
    }

    outputDiv.textContent = historyText;
}

function clearHistory() {
    const settings = getSettings();
    settings.summaries = [];
    lastSummarizedIndex = 0;
    saveSettings();
    document.getElementById("summarizer-output").textContent = "历史已清空";
}

jQuery(async () => {
    try {
        loadSettings();
        const settings = getSettings();

        const settingsHtml = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>痔疮总结机</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
            <div class="inline-drawer-content">
                <h4>自定义API设置</h4>
                <label for="summarizer-api-url">API地址:</label>
                <input type="text" id="summarizer-api-url" class="text_pole" placeholder="https://api.example.com/v1/chat/completions"></input>
                <label for="summarizer-api-key">API Key:</label>
                <input type="password" id="summarizer-api-key" class="text_pole" placeholder="sk-xxx"></input>
                <label for="summarizer-model">模型名称:</label>
                <input type="text" id="summarizer-model" class="text_pole" placeholder="gpt-3.5-turbo"></input>
                <hr></hr>
                <h4>自动总结</h4>
                <label class="checkbox_label">
                    <input type="checkbox" id="summarizer-auto-enabled">
                    启用自动总结</input>
                </label>
                <label for="summarizer-interval">每隔多少条消息总结:</label>
                <input type="number" id="summarizer-interval" class="text_pole" min="5" max="200" value="20">
                <hr>
                <h4>总结提示词</h4>
                <textarea id="summarizer-prompt" class="text_pole" rows="3"></textarea>
                <div style="display:flex; gap:5px; margin-top:10px;">
                    <button id="summarizer-btn" class="menu_button">手动总结</button>
                    <button id="summarizer-history-btn" class="menu_button">查看历史</button>
                    <button id="summarizer-clear-btn" class="menu_button">清空历史</button>
                </div>
                <div id="summarizer-output" style="margin-top:10px; padding:10px; background:rgba(0,0,0,0.3); border-radius:5px; white-space:pre-wrap; max-height:300px; overflow-y:auto;">点击按钮生成对话总结</div>
            </div>
        </div>`;

        $("#extensions_settings2").append(settingsHtml);

        $("#summarizer-api-url").val(settings.customApiUrl);
        $("#summarizer-api-key").val(settings.customApiKey);
        $("#summarizer-model").val(settings.customModel);
        $("#summarizer-auto-enabled").prop("checked", settings.autoEnabled);
        $("#summarizer-interval").val(settings.autoInterval);
        $("#summarizer-prompt").val(settings.summaryPrompt);

        $("#summarizer-api-url").on("change", function() {
            settings.customApiUrl = $(this).val();
            saveSettings();
        });

        $("#summarizer-api-key").on("change", function() {
            settings.customApiKey = $(this).val();
            saveSettings();
        });

        $("#summarizer-model").on("change", function() {
            settings.customModel = $(this).val();
            saveSettings();
        });

        $("#summarizer-auto-enabled").on("change", function() {
            settings.autoEnabled = $(this).prop("checked");
            saveSettings();
        });

        $("#summarizer-interval").on("change", function() {
            settings.autoInterval = parseInt($(this).val()) || 20;
            saveSettings();
        });

        $("#summarizer-prompt").on("change", function() {
            settings.summaryPrompt = $(this).val();
            saveSettings();
        });

        $("#summarizer-btn").on("click", () => doSummarize());
        $("#summarizer-history-btn").on("click", showSummaryHistory);
        $("#summarizer-clear-btn").on("click", clearHistory);

        // 用轮询代替事件监听，更稳定
        let lastChatLength = 0;
        setInterval(() => {
            const context = getContext();
            if (context.chat && context.chat.length !== lastChatLength) {
                lastChatLength = context.chat.length;
                checkAutoSummarize();
            }
        }, 2000);

        console.log("痔疮总结机 loaded.");

    } catch (err) {
        console.error("痔疮总结机加载失败:", err);
    }
});
