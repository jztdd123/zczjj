import { getContext, extension_settings, renderExtensionTemplateAsync } from "../../../extensions.js";
import { generateQuietPrompt } from "../../../../script.js";

const extensionName = "st-summarizer";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const defaultSettings = {
    summaryPrompt: "请用简洁的中文总结以上对话的主要内容，保留关键信息和角色行为。",
    maxMessages: 20
};

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
}

function getRecentChat(count) {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return null;

    const recentMessages = chat.slice(-count);
    let chatText = "";
    for (const msg of recentMessages) {
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

async function doSummarize() {
    const settings = extension_settings[extensionName];
    const outputDiv = document.getElementById("summarizer-output");
    const btn = document.getElementById("summarizer-btn");

    outputDiv.textContent = "正在生成总结...";
    btn.disabled = true;

    try {
        const chatContent = getRecentChat(settings.maxMessages);
        if (!chatContent) {
            outputDiv.textContent = "没有找到聊天记录。";
            btn.disabled = false;
            return;
        }
        const prompt = `${chatContent}\n\n---\n${settings.summaryPrompt}`;
        const summary = await generateQuietPrompt(prompt, false, false);
        outputDiv.textContent = summary || "总结生成失败。";
    } catch (error) {
        console.error("Summarizer error:", error);
        outputDiv.textContent = "发生错误: " + error.message;
    }
    btn.disabled = false;
}

jQuery(async () => {
    loadSettings();

    const settingsHtml = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>痔疮总结机</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
            <label for="summarizer-max-msgs">总结最近消息数量:</label>
            <input type="number" id="summarizer-max-msgs" class="text_pole" min="5" max="100" value="20"></input>
            <label for="summarizer-prompt">总结提示词:</label>
            <textarea id="summarizer-prompt" class="text_pole" rows="3"></textarea>
            <button id="summarizer-btn" class="menu_button">生成总结</button>
            <div id="summarizer-output">点击上方按钮生成对话总结</div>
        </div>
    </div>`;

    $("#extensions_settings2").append(settingsHtml);

    const settings = extension_settings[extensionName];
    $("#summarizer-max-msgs").val(settings.maxMessages);
    $("#summarizer-prompt").val(settings.summaryPrompt);

    $("#summarizer-max-msgs").on("change", function() {
        settings.maxMessages = parseInt($(this).val()) || 20;
    });
    $("#summarizer-prompt").on("change", function() {
        settings.summaryPrompt = $(this).val();
    });
    $("#summarizer-btn").on("click", doSummarize);

    console.log("痔疮总结机 loaded.");
});
