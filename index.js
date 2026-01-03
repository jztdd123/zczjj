import { getContext, extension_settings } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";

const extensionName = "st-summarizer";
const localStorageKey = "summarizer_credentials";

const defaultSettings = {
    summaryPrompt: "请用简洁的中文总结以上对话的主要内容，保留关键信息和角色行为。",
    maxMessages: 20,
    autoSummarize: false,
    triggerInterval: 20,
    keepVisible: 10,
    autoHide: true,
    apiEndpoint: "",
    apiKey: "",
    model: "",
    lastSummarizedIndex: 0,
    savedSummaries: [],
    extractionRules: [],
    blacklist: ""
};

// ==================== 凭证存储 ====================
function saveCredentialsLocal(endpoint, key) {
    localStorage.setItem(localStorageKey, JSON.stringify({ apiEndpoint: endpoint, apiKey: key }));
}

function loadCredentialsLocal() {
    try { return JSON.parse(localStorage.getItem(localStorageKey)) || null; }
    catch { return null; }
}

// ==================== 设置管理 ====================
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

// ==================== 标签提取系统 ====================
function applyExtractionRules(text) {
    const settings = getSettings();
    const rules = settings.extractionRules || [];

    if (rules.length === 0) return text;

    let processedText = text;

    // 第一步：应用所有排除规则
    const excludeRules = rules.filter(r => r.type === 'exclude');
    const regexExcludeRules = rules.filter(r => r.type === 'regex-exclude');

    for (const rule of excludeRules) {
        const tagName = rule.value.trim();
        if (!tagName) continue;
        const regex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?</${tagName}[^><\\/${tagName}>`, 'gi');
        processedText = processedText.replace(regex, '');
    }

    for (const rule of regexExcludeRules) {
        try {
            const regex = new RegExp(rule.value, 'gi');
            processedText = processedText.replace(regex, '');
        } catch (e) {
            console.error("正则排除错误:", e);
        }
    }

    // 第二步：应用所有包含规则
    const includeRules = rules.filter(r => r.type === 'include');
    const regexIncludeRules = rules.filter(r => r.type === 'regex-include');

    if (includeRules.length === 0 && regexIncludeRules.length === 0) {
        // 没有包含规则，返回排除后的全部内容
        return applyBlacklist(processedText);
    }

    let extractedParts = [];

    // 标签包含
    for (const rule of includeRules) {
        const tagName = rule.value.trim();
        if (!tagName) continue;</\\>
        const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}[^><\\/${tagName}>`, 'gi');
        let match;
        while ((match = regex.exec(processedText)) !== null) {
            extractedParts.push(match[1]);
        }
    }

    // 正则包含（提取第一个捕获组）
    for (const rule of regexIncludeRules) {
        try {
            const regex = new RegExp(rule.value, 'gi');
            let match;
            while ((match = regex.exec(processedText)) !== null) {
                if (match[1]) {
                    extractedParts.push(match[1]);
                } else {
                    extractedParts.push(match[0]);
                }
            }
        } catch (e) {
            console.error("正则包含错误:", e);
        }
    }

    const result = extractedParts.join('\n\n');
    return applyBlacklist(result);
}

function applyBlacklist(text) {
    const settings = getSettings();
    const blacklist = settings.blacklist?.trim();
    if (!blacklist) return text;

    const words = blacklist.split('\n').map(w => w.trim()).filter(w => w);
    let result = text;
    for (const word of words) {
        result = result.split(word).join('');
    }
    return result;
}

// ==================== 规则UI管理 ====================
function renderRulesList() {
    const settings = getSettings();
    const container = document.getElementById("summarizer-rules-list");
    container.innerHTML = "";

    if (settings.extractionRules.length === 0) {</\\>
        container.innerHTML = '<div style="color:#888;font-size:12px;">暂无规则（将处理全部内容）</div>';
        return;
    }

    settings.extractionRules.forEach((rule, index) => {
        const typeLabels = {
            'include': '包含',
            'exclude': '排除',
            'regex-include': '正则包含',
            'regex-exclude': '正则排除'
        };
        const typeColors = {
            'include': '#4CAF50',
            'exclude': '#f44336',
            'regex-include': '#2196F3',
            'regex-exclude': '#FF9800'
        };

        const ruleEl = document.createElement("div");
        ruleEl.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px;background:rgba(255,255,255,0.05);border-radius:4px;margin-bottom:4px;";
        ruleEl.innerHTML = `
            <span style="background:${typeColors[rule.type]};color:#fff;padding:2px 6px;border-radius:3px;font-size:11px;">${typeLabels[rule.type]}</span>
            <code style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${rule.value}</code>
            <button class="menu_button" data-index="${index}" style="padding:2px 8px;">删</button>
        `;
        container.appendChild(ruleEl);
    });

    // 绑定删除按钮
    container.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", function() {
            const idx = parseInt(this.dataset.index);
            settings.extractionRules.splice(idx, 1);
            saveSettings();
            renderRulesList();
        });
    });
}

function addRule() {
    const settings = getSettings();
    const typeEl = document.getElementById("summarizer-rule-type");
    const valueEl = document.getElementById("summarizer-rule-value");

    const type = typeEl.value;
    const value = valueEl.value.trim();

    if (!value) {
        alert("请输入规则内容");
        return;
    }

    // 验证正则
    if (type.includes('regex')) {
        try {
            new RegExp(value);
        } catch (e) {
            alert("正则表达式格式错误: " + e.message);
            return;
        }
    }

    settings.extractionRules.push({ type, value });
    saveSettings();
    renderRulesList();
    valueEl.value = "";
}

function addPresetRule(type, value) {
    const settings = getSettings();
    settings.extractionRules.push({ type, value });
    saveSettings();
    renderRulesList();
}

function clearAllRules() {
    const settings = getSettings();
    settings.extractionRules = [];
    saveSettings();
    renderRulesList();
}

// ==================== API相关 ====================
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

// ==================== 消息隐藏 ====================
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

// ==================== 聊天获取与处理 ====================
function getRecentChat(start, end) {
    const chat = getContext().chat;
    if (!chat?.length) return null;
    let text = "";
    chat.slice(start, end).forEach(m => {
        if (m.is_system) return;
        const content = applyExtractionRules(m.mes);
        if (content.trim()) {
            text += `${m.is_user ? "用户" : m.name}: ${content}\n\n`;
        }
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

// ==================== 总结功能 ====================
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
        out.textContent = summary;

        settings.savedSummaries.push({
            time: new Date().toLocaleString(),
            range: `${start + 1}-${len}`,
            content: summary
        });

        if (settings.autoHide) {
            const hideUntil = len - settings.keepVisible;
            if (hideUntil > 0) {
                hideMessages(0, hideUntil);
                out.textContent = `[已隐藏 1-${hideUntil} 楼]\n\n${summary}`;
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

            settings.savedSummaries.push({
                time: new Date().toLocaleString(),
                range: `${start + 1}-${len}`,
                content: summary,
                auto: true
            });

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
    saveSettings();
    document.getElementById("summarizer-output").textContent = "已清空";
}

// 测试提取规则
function testExtraction() {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) {
        document.getElementById("summarizer-output").textContent = "无聊天记录";
        return;
    }

    // 取最后一条非系统消息测试
    const lastMsg = [...chat].reverse().find(m => !m.is_system);
    if (!lastMsg) {
        document.getElementById("summarizer-output").textContent = "无有效消息";
        return;
    }

    const original = lastMsg.mes;
    const processed = applyExtractionRules(original);

    document.getElementById("summarizer-output").textContent =
        `=== 原文 ===\n${original.slice(0, 500)}${original.length > 500 ? '...' : ''}\n\n=== 处理后 ===\n${processed.slice(0, 500)}${processed.length > 500 ? '...' : ''}`;
}

// ==================== 初始化 ====================
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
            </!-->
            <h4 style="margin:5px 0;">API 配置</h4>
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

            <hr style="border-color:#444;margin:10px 0;"></hr>

            </!-->
            <h4 style="margin:5px 0;">标签提取规则</h4>
            <div style="display:flex;gap:8px;margin-bottom:8px;">
                <select id="summarizer-rule-type" class="text_pole" style="width:120px;">
                    <option value="include">包含</option>
                    <option value="exclude">排除</option>
                    <option value="regex-include">正则包含</option>
                    <option value="regex-exclude">正则排除</option>
                </select>
                <input type="text" id="summarizer-rule-value" class="text_pole" placeholder="标签名或正则表达式" style="flex:1;"></input>
                <button id="summarizer-add-rule" class="menu_button">添加</button>
            </div>
            <div style="display:flex;gap:5px;margin-bottom:8px;flex-wrap:wrap;">
                <button id="summarizer-preset-cot" class="menu_button" style="font-size:11px;">去除小CoT</button>
                <button id="summarizer-preset-thinking" class="menu_button" style="font-size:11px;">排除thinking</button>
                <button id="summarizer-preset-content" class="menu_button" style="font-size:11px;">只含content</button>
                <button id="summarizer-clear-rules" class="menu_button" style="font-size:11px;">清空规则</button>
                <button id="summarizer-test-extract" class="menu_button" style="font-size:11px;">测试规则</button>
            </div>
            <div id="summarizer-rules-list" style="max-height:120px;overflow-y:auto;margin-bottom:8px;"></div>

            <label>黑名单（每行一个词）:</label>
            <textarea id="summarizer-blacklist" class="text_pole" rows="2" placeholder="要过滤的词..."></textarea>

            <hr style="border-color:#444;margin:10px 0;"></hr>

            </!-->
            <h4 style="margin:5px 0;">总结设置</h4>
            <div style="display:flex;gap:10px;margin:8px 0;">
                <div style="flex:2;"><label>提示词:</label><textarea id="summarizer-prompt" class="text_pole" rows="2"></textarea></div>
                <div style="flex:1;"><label>总结条数:</label><input type="number" id="summarizer-max-msgs" class="text_pole" min="5" max="200"></input></div>
            </div>
            <div style="display:flex;gap:10px;margin:8px 0;">
                <div style="flex:1;"><label>自动间隔:</label><input type="number" id="summarizer-trigger-interval" class="text_pole" min="10" max="200"></input></div>
                <div style="flex:1;"><label>保留显示:</label><input type="number" id="summarizer-keep-visible" class="text_pole" min="1" max="100"></input></div>
            </div>
            <div style="display:flex;gap:15px;align-items:center;margin:8px 0;">
                <label class="checkbox_label"><input type="checkbox" id="summarizer-auto-enabled"> 自动总结</input></label>
                <label class="checkbox_label"><input type="checkbox" id="summarizer-auto-hide"> 自动隐藏</input></label>
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

    // 填充值
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
    $("#summarizer-blacklist").val(s.blacklist).on("change", function() { s.blacklist = this.value; saveSettings(); });

    // API按钮
    $("#summarizer-fetch-models").on("click", refreshModelList);
    $("#summarizer-test-btn").on("click", testConnection);

    // 规则按钮
    $("#summarizer-add-rule").on("click", addRule);
    $("#summarizer-clear-rules").on("click", clearAllRules);
    $("#summarizer-test-extract").on("click", testExtraction);
    $("#summarizer-preset-cot").on("click", () => addPresetRule('regex-exclude', ''));
    $("#summarizer-preset-thinking").on("click", () => addPresetRule('exclude', 'thinking'));
    $("#summarizer-preset-content").on("click", () => addPresetRule('include', 'content'));

    // 总结按钮
    $("#summarizer-btn").on("click", doSummarize);
    $("#summarizer-history-btn").on("click", showHistory);
    $("#summarizer-clear-btn").on("click", clearHistory);
    $("#summarizer-unhide-btn").on("click", unhideAll);

    // 监听消息事件
    eventSource.on(event_types.MESSAGE_RECEIVED, () => setTimeout(checkAuto, 1000));
    eventSource.on(event_types.MESSAGE_SENT, () => setTimeout(checkAuto, 1000));

    // 初始化
    setTimeout(() => {
        updateHideStatus();
        renderRulesList();
    }, 500);

    console.log("痔疮总结机 loaded");
});
