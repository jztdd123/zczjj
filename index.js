import { getContext, extension_settings, saveSettingsDebounced } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";

const extensionName = "st-summarizer";

const defaultSettings = {
    summaryPrompt: "请用简洁的中文总结以上对话的主要内容，保留关键信息和角色行为。",
    maxMessages: 20,
    autoSummarize: true,
    triggerInterval: 20,
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: "",
    model: "gpt-4o-mini",
    lastSummarizedIndex: 0,
    savedSummaries: []
};

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
    // 补全缺失字段
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

// 使用自定义API调用
async function callCustomAPI(prompt) {
    const settings = getSettings();

    if (!settings.apiEndpoint || !settings.apiKey) {
        throw new Error("请先配置API地址和密钥");
    }

    const requestBody = {
        model: settings.model,
        messages: [
            {
                role: "user",
                content: prompt
            }
        ],
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

// 手动总结
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

        // 保存总结
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

// 自动总结检查
async function checkAutoSummarize() {
    const settings = getSettings();
    if (!settings.autoSummarize) return;

    const context = getContext();
    const chatLength = context.chat?.length || 0;

    // 检查是否达到触发条件
    const messagesSinceLastSummary = chatLength - settings.lastSummarizedIndex;

    if (messagesSinceLastSummary >= settings.triggerInterval) {
        console.log(`痔疮总结机: 触发自动总结，当前${chatLength}条，上次总结在${settings.lastSummarizedIndex}条`);

        try {
            const startIndex = settings.lastSummarizedIndex;
            const endIndex = chatLength;

            const chatContent = getRecentChat(startIndex, endIndex);
            if (!chatContent) return;

            const prompt = `${chatContent}\n\n---\n${settings.summaryPrompt}`;
            const summary = await callCustomAPI(prompt);

            // 保存总结
            settings.savedSummaries.push({
                time: new Date().toLocaleString(),
                range: `${startIndex + 1}-${endIndex}`,
                content: summary,
                auto: true
            });

            settings.lastSummarizedIndex = chatLength;
            saveSettings();

            // 更新UI
            const outputDiv = document.getElementById("summarizer-output");
            if (outputDiv) {
                outputDiv.textContent = `[自动总结完成]\n${summary}`;
            }

            console.log("痔疮总结机: 自动总结完成");

        } catch (error) {
            console.error("痔疮总结机 自动总结失败:", error);
        }
    }
}

// 查看历史总结
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

// 清空历史
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
            <label for="summarizer-api-endpoint">API地址:</label>
            <input type="text" id="summarizer-api-endpoint" class="text_pole" placeholder="https://api.openai.com/v1/chat/completions">
</input>
            <label for="summarizer-api-key">API密钥:</label>
            <input type="password" id="summarizer-api-key" class="text_pole" placeholder="sk-...">
</input>
            <label for="summarizer-model">模型名称:</label>
            <input type="text" id="summarizer-model" class="text_pole" placeholder="gpt-4o-mini">
</input>
            <hr></hr>
            <h4>总结设置</h4>

            <label for="summarizer-prompt">总结提示词:</label>
            <textarea id="summarizer-prompt" class="text_pole" rows="3"></textarea>

            <label for="summarizer-max-msgs">手动总结消息数:</label>
            <input type="number" id="summarizer-max-msgs" class="text_pole" min="5" max="200" value="20">
</input>
            <hr></hr>
            <h4>自动总结</h4>

            <label class="checkbox_label">
                <input type="checkbox" id="summarizer-auto-enabled">
                启用自动总结</input>
            </label>

            <label for="summarizer-trigger-interval">每隔N条消息自动总结:</label>
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

    // 填充现有设置
    $("#summarizer-api-endpoint").val(settings.apiEndpoint);
    $("#summarizer-api-key").val(settings.apiKey);
    $("#summarizer-model").val(settings.model);
    $("#summarizer-prompt").val(settings.summaryPrompt);
    $("#summarizer-max-msgs").val(settings.maxMessages);
    $("#summarizer-auto-enabled").prop("checked", settings.autoSummarize);
    $("#summarizer-trigger-interval").val(settings.triggerInterval);

    // 绑定事件
    $("#summarizer-api-endpoint").on("change", function() {
        settings.apiEndpoint = $(this).val();
        saveSettings();
    });
    $("#summarizer-api-key").on("change", function() {
        settings.apiKey = $(this).val();
        saveSettings();
    });
    $("#summarizer-model").on("change", function() {
        settings.model = $(this).val();
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

    $("#summarizer-btn").on("click", doManualSummarize);
    $("#summarizer-history-btn").on("click", showSummaryHistory);
    $("#summarizer-clear-btn").on("click", clearHistory);

    // 监听消息事件，触发自动总结
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        setTimeout(checkAutoSummarize, 1000);
    });
    eventSource.on(event_types.MESSAGE_SENT, () => {
        setTimeout(checkAutoSummarize, 1000);
    });

    console.log("痔疮总结机 loaded.");
});
