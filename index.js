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
    autoHide: false,
    apiEndpoint: "",
    apiKey: "",
    model: "",
    lastSummarizedIndex: 0,
    savedSummaries: [],
    extractRules: [],
    useExtraction: false
};

function saveCredentialsLocal(endpoint, key) {
    localStorage.setItem(localStorageKey, JSON.stringify({ apiEndpoint: endpoint, apiKey: key }));
}

function loadCredentialsLocal() {
    try { return JSON.parse(localStorage.getItem(localStorageKey)) || null; }
    catch (e) { return null; }
}

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (var key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }
    var creds = loadCredentialsLocal();
    if (creds && creds.apiEndpoint) extension_settings[extensionName].apiEndpoint = creds.apiEndpoint;
    if (creds && creds.apiKey) extension_settings[extensionName].apiKey = creds.apiKey;
}

function getSettings() { return extension_settings[extensionName]; }

function saveSettings() {
    var s = getSettings();
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

async function fetchModels() {
    var settings = getSettings();
    if (!settings.apiEndpoint || !settings.apiKey) throw new Error("填写API配置");
    var res = await fetch(getModelsUrl(settings.apiEndpoint), {
        method: "GET",
        headers: { "Authorization": "Bearer " + settings.apiKey }
    });
    if (!res.ok) throw new Error(String(res.status));
    var data = await res.json();
    return data.data || data.models || [];
}

async function testConnection() {
    var settings = getSettings();
    var status = document.getElementById("summarizer-status");
    status.textContent = "测试中...";
    status.style.color = "orange";

    try {
        if (!settings.apiEndpoint || !settings.apiKey || !settings.model) throw new Error("配置不完整");
        var res = await fetch(getCompletionsUrl(settings.apiEndpoint), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + settings.apiKey
            },
            body: JSON.stringify({
                model: settings.model,
                messages: [{ role: "user", content: "hi" }],
                max_tokens: 5
            })
        });
        if (!res.ok) throw new Error(String(res.status));
        var data = await res.json();
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
    var sel = document.getElementById("summarizer-model-select");
    var status = document.getElementById("summarizer-status");
    sel.innerHTML = "<option>加载中...</option>";
    status.textContent = "获取模型...";
    status.style.color = "orange";

    try {
        var models = await fetchModels();
        sel.innerHTML = "<option value=''>-- 选择 --</option>";
        for (var i = 0; i < models.length; i++) {
            var m = models[i];
            var id = m.id || m.name || m;
            var opt = document.createElement("option");
            opt.value = id;
            opt.textContent = id;
            sel.appendChild(opt);
        }
        var settings = getSettings();
        if (settings.model) sel.value = settings.model;
        status.textContent = "✓ " + models.length + " 模型";
        status.style.color = "lime";
    } catch (e) {
        sel.innerHTML = "<option>失败</option>";
        status.textContent = "✗ " + e.message;
        status.style.color = "red";
    }
}

function applyExtractionRules(text) {
    var settings = getSettings();
    if (!settings.useExtraction || settings.extractRules.length === 0) {
        return text;
    }

    var processedText = text;
    var extractedParts = [];

    var excludeRules = settings.extractRules.filter(function(r) {
        return r.type === "exclude" || r.type === "regex-exclude";
    });

    for (var i = 0; i < excludeRules.length; i++) {
        var rule = excludeRules[i];
        if (rule.type === "exclude") {
            var tagRegex = new RegExp("<" + rule.value + "[^>]*>[\\s\\S]*?</" + rule.value + ">", "gi");
            processedText = processedText.replace(tagRegex, "");
        } else if (rule.type === "regex-exclude") {
            try {
                var regex = new RegExp(rule.value, "gi");
                processedText = processedText.replace(regex, "");
            } catch (e) {
                console.error("正则排除规则错误:", e);
            }
        }
    }

    var includeRules = settings.extractRules.filter(function(r) {
        return r.type === "include" || r.type === "regex-include";
    });

    if (includeRules.length > 0) {
        for (var j = 0; j < includeRules.length; j++) {
            var incRule = includeRules[j];
            if (incRule.type === "include") {
                var incTagRegex = new RegExp("<" + incRule.value + "[^>]*>([\\s\\S]*?)</" + incRule.value + ">", "gi");
                var match;
                while ((match = incTagRegex.exec(processedText)) !== null) {
                    extractedParts.push(match[1].trim());
                }
            } else if (incRule.type === "regex-include") {
                try {
                    var incRegex = new RegExp(incRule.value, "gi");
                    var incMatch;
                    while ((incMatch = incRegex.exec(processedText)) !== null) {
                        if (incMatch[1]) {
                            extractedParts.push(incMatch[1].trim());
                        } else {
                            extractedParts.push(incMatch[0].trim());
                        }
                    }
                } catch (e) {
                    console.error("正则包含规则错误:", e);
                }
            }
        }
        return extractedParts.join("\n\n");
    }

    return processedText;
}

var presetRules = {
    "game-loadall": {
        name: "game.loadAll格式",
        rules: [
            { type: "regex-include", value: "`\\)\\s*game\\.loadAll\\(`([\\s\\S]*?)`\\)" }
        ]
    },
    "html-comment": {
        name: "HTML注释(小CoT)",
        rules: [
            { type: "regex-exclude", value: "" }
        ]
    },
    "details-summary": {
        name: "details摘要块",
        rules: [</!--[\\s\\S]*?-->
            { type: "regex-include", value: "<details><summary>摘要</summary>([\\s\\S]*?)</details>" }
        ]
    },
    "content-tag": {
        name: "content标签",
        rules: [
            { type: "include", value: "content" }
        ]
    }
};

function addPresetRule(presetKey) {
    var settings = getSettings();
    var preset = presetRules[presetKey];
    if (!preset) return;

    for (var i = 0; i < preset.rules.length; i++) {
        var rule = preset.rules[i];
        var exists = false;
        for (var j = 0; j < settings.extractRules.length; j++) {
            if (settings.extractRules[j].type === rule.type && settings.extractRules[j].value === rule.value) {
                exists = true;
                break;
            }
        }
        if (!exists) {
            settings.extractRules.push({ type: rule.type, value: rule.value });
        }
    }

    saveSettings();
    renderRulesList();
}

function addCustomRule(type, value) {
    var settings = getSettings();
    if (!value.trim()) return;
    settings.extractRules.push({ type: type, value: value.trim() });
    saveSettings();
    renderRulesList();
}

function removeRule(index) {
    var settings = getSettings();
    settings.extractRules.splice(index, 1);
    saveSettings();
    renderRulesList();
}

function clearAllRules() {
    var settings = getSettings();
    settings.extractRules = [];
    saveSettings();
    renderRulesList();
}

function escapeHtml(str) {
    return str.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
}

function renderRulesList() {
    var container = document.getElementById("summarizer-rules-list");
    var settings = getSettings();

    if (settings.extractRules.length === 0) {
        container.innerHTML = "<div style='color:#666;font-size:12px;'>无规则 (将提取全部内容)</div>";
        return;
    }

    var typeLabels = {
        "include": "包含",
        "exclude": "排除",
        "regex-include": "正则包含",
        "regex-exclude": "正则排除"
    };

    var typeColors = {
        "include": "#4a9",
        "exclude": "#c66",
        "regex-include": "#69c",
        "regex-exclude": "#c69"
    };

    var html = "";
    for (var i = 0; i < settings.extractRules.length; i++) {
        var rule = settings.extractRules[i];
        html += "<div style='display:flex;align-items:center;gap:5px;margin:3px 0;padding:4px;background:rgba(255,255,255,0.05);border-radius:3px;'>";
        html += "<span style='background:" + typeColors[rule.type] + ";color:#fff;padding:2px 6px;border-radius:3px;font-size:11px;'>" + typeLabels[rule.type] + "</span>";
        html += "<code style='flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'>" + escapeHtml(rule.value) + "</code>";
        html += "<button class='menu_button summarizer-remove-rule' data-index='" + i + "' style='padding:2px 8px;font-size:11px;'>×</button>";
        html += "</div>";
    }
    container.innerHTML = html;

    var btns = container.querySelectorAll(".summarizer-remove-rule");
    for (var k = 0; k < btns.length; k++) {
        btns[k].addEventListener("click", function() {
            removeRule(parseInt(this.getAttribute("data-index")));
        });
    }
}

function testExtraction() {
    var context = getContext();
    var chat = context.chat;

    if (!chat || chat.length === 0) {
        document.getElementById("summarizer-output").textContent = "无聊天记录";
        return;
    }

    var lastMsg = chat[chat.length - 1];
    var original = lastMsg.mes || "";
    var extracted = applyExtractionRules(original);

    var output = "=== 原文 (" + original.length + "字) ===\n";
    output += original.slice(0, 500) + (original.length > 500 ? "..." : "") + "\n\n";
    output += "=== 提取后 (" + extracted.length + "字) ===\n";
    output += extracted.slice(0, 500) + (extracted.length > 500 ? "..." : "");

    document.getElementById("summarizer-output").textContent = output;
}

function hideMessages(startIdx, endIdx) {
    var context = getContext();
    var chat = context.chat;
    if (!chat) return 0;

    var hiddenCount = 0;
    for (var i = startIdx; i < endIdx && i < chat.length; i++) {
        if (!chat[i].is_system && !chat[i].is_hidden) {
            chat[i].is_hidden = true;
            hiddenCount++;
        }
    }

    if (hiddenCount > 0 && typeof context.saveChat === "function") {
        context.saveChat();
    }
    return hiddenCount;
}

function checkContinuousHide() {
    var settings = getSettings();
    if (!settings.autoHide) return;

    var context = getContext();
    var chat = context.chat;
    if (!chat || chat.length === 0) return;

    var hideUntil = chat.length - settings.keepVisible;

    if (hideUntil > 0) {
        var hiddenCount = 0;
        for (var i = 0; i < hideUntil; i++) {
            if (!chat[i].is_system && !chat[i].is_hidden) {
                chat[i].is_hidden = true;
                hiddenCount++;
            }
        }

        if (hiddenCount > 0 && typeof context.saveChat === "function") {
            context.saveChat();
            updateHideStatus();
        }
    }
}

function updateHideStatus() {
    var context = getContext();
    var chat = context.chat;
    if (!chat) return;

    var visible = 0, hidden = 0, total = 0;
    for (var i = 0; i < chat.length; i++) {
        if (!chat[i].is_system) {
            total++;
            if (chat[i].is_hidden) hidden++;
            else visible++;
        }
    }

    var statusEl = document.getElementById("summarizer-hide-status");
    if (statusEl) {
        statusEl.textContent = "显示: " + visible + " | 隐藏: " + hidden + " | 总计: " + total;
    }
}

function unhideAll() {
    var context = getContext();
    var chat = context.chat;
    if (!chat) return;

    var count = 0;
    for (var i = 0; i < chat.length; i++) {
        if (chat[i].is_hidden) {
            chat[i].is_hidden = false;
            count++;
        }
    }

    if (count > 0 && typeof context.saveChat === "function") {
        context.saveChat();
    }

    updateHideStatus();
    document.getElementById("summarizer-output").textContent = "已取消隐藏 " + count + " 条消息";
}

function getRecentChat(start, end) {
    var context = getContext();
    var chat = context.chat;
    if (!chat || chat.length === 0) return null;

    var settings = getSettings();
    var text = "";

    for (var i = start; i < end && i < chat.length; i++) {
        var m = chat[i];
        if (m.is_system) continue;

        var content = m.mes || "";

        if (settings.useExtraction && settings.extractRules.length > 0) {
            content = applyExtractionRules(content);
        }

        if (content.trim()) {
            var name = m.is_user ? "用户" : m.name;
            text += name + ": " + content + "\n\n";
        }
    }

    return text;
}

async function callAPI(prompt) {
    var settings = getSettings();
    if (!settings.apiEndpoint || !settings.apiKey || !settings.model) throw new Error("配置不完整");

    var res = await fetch(getCompletionsUrl(settings.apiEndpoint), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + settings.apiKey
        },
        body: JSON.stringify({
            model: settings.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 2000
        })
    });

    if (!res.ok) throw new Error("API " + res.status);
    var data = await res.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content || "失败";
    }
    return "失败";
}

async function doSummarize() {
    var settings = getSettings();
    var out = document.getElementById("summarizer-output");
    var btn = document.getElementById("summarizer-btn");
    out.textContent = "生成中...";
    btn.disabled = true;

    try {
        var context = getContext();
        var len = context.chat ? context.chat.length : 0;
        var start = Math.max(0, len - settings.maxMessages);
        var chat = getRecentChat(start, len);

        if (!chat || !chat.trim()) {
            out.textContent = "无可用内容 (检查提取规则)";
            btn.disabled = false;
            return;
        }

        var summary = await callAPI(chat + "\n---\n" + settings.summaryPrompt);
        out.textContent = summary;

        settings.savedSummaries.push({
            time: new Date().toLocaleString(),
            range: (start + 1) + "-" + len,
            content: summary
        });

        if (settings.autoHide) {
            var hideUntil = len - settings.keepVisible;
            if (hideUntil > 0) {
                hideMessages(0, hideUntil);
                out.textContent = "[已隐藏 1-" + hideUntil + " 楼]\n\n" + summary;
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
    var settings = getSettings();

    if (settings.autoHide) {
        checkContinuousHide();
    }

    if (!settings.autoSummarize) return;

    var context = getContext();
    var len = context.chat ? context.chat.length : 0;

    if (len - settings.lastSummarizedIndex >= settings.triggerInterval) {
        var out = document.getElementById("summarizer-output");

        try {
            var start = settings.lastSummarizedIndex;
            var chat = getRecentChat(start, len);
            if (!chat || !chat.trim()) return;

            out.textContent = "[自动总结中...]";

            var summary = await callAPI(chat + "\n---\n" + settings.summaryPrompt);

            settings.savedSummaries.push({
                time: new Date().toLocaleString(),
                range: (start + 1) + "-" + len,
                content: summary,
                auto: true
            });

            if (settings.autoHide) {
                var hideUntil = len - settings.keepVisible;
                if (hideUntil > 0) {
                    hideMessages(0, hideUntil);
                }
            }

            settings.lastSummarizedIndex = len;
            saveSettings();
            updateHideStatus();

            out.textContent = "[自动总结完成]\n" + summary;

        } catch (e) {
            console.error("自动总结失败", e);
            out.textContent = "自动总结失败: " + e.message;
        }
    }
}

function showHistory() {
    var s = getSettings();
    var out = document.getElementById("summarizer-output");
    if (!s.savedSummaries.length) {
        out.textContent = "无历史";
        return;
    }
    var text = "";
    for (var i = s.savedSummaries.length - 1; i >= 0; i--) {
        var x = s.savedSummaries[i];
        text += "【" + x.time + "】" + x.range + (x.auto ? " (自动)" : "") + "\n" + x.content + "\n\n---\n\n";
    }
    out.textContent = text;
}

function clearHistory() {
    var s = getSettings();
    s.savedSummaries = [];
    s.lastSummarizedIndex = 0;
    saveSettings();
    document.getElementById("summarizer-output").textContent = "已清空";
}

jQuery(function() {
    loadSettings();
    var s = getSettings();

    var html = '<div class="inline-drawer">' +
        '<div class="inline-drawer-toggle inline-drawer-header">' +
        '<b>痔疮总结机</b>' +
        '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>' +
        '</div>' +
        '<div class="inline-drawer-content">' +

        '<div style="display:flex;gap:10px;margin-bottom:8px;">' +
        '<div style="flex:1;"><label>API地址:</label><input type="text" id="summarizer-api-endpoint" class="text_pole" placeholder="https://xxx/v1"></div>' +</input>
        '<div style="flex:1;"><label>API密钥:</label><input type="password" id="summarizer-api-key" class="text_pole"></div>' +</input>
        '</div>' +

        '<div style="display:flex;gap:10px;align-items:end;margin-bottom:8px;">' +
        '<div style="flex:1;"><label>模型:</label><select id="summarizer-model-select" class="text_pole"><option>--</option></select></div>' +
        '<div style="flex:1;"><label>手动:</label><input type="text" id="summarizer-model-manual" class="text_pole"></div>' +</input>
        '<button id="summarizer-fetch-models" class="menu_button">获取</button>' +
        '<button id="summarizer-test-btn" class="menu_button">测试</button>' +
        '</div>' +

        '<div id="summarizer-status" style="font-size:12px;color:gray;margin-bottom:8px;">未连接</div>' +

        '<hr>' +
</hr>
        '<details style="margin:8px 0;">' +
        '<summary style="cursor:pointer;font-weight:bold;">📋 内容提取规则</summary>' +
        '<div style="padding:8px;background:rgba(0,0,0,0.2);border-radius:5px;margin-top:5px;">' +

        '<label class="checkbox_label" style="margin-bottom:8px;">' +
        '<input type="checkbox" id="summarizer-use-extraction"> 启用提取规则' +</input>
        '</label>' +

        '<div style="margin-bottom:8px;">' +
        '<label>预设规则:</label>' +
        '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:3px;">' +
        '<button class="menu_button" style="font-size:11px;" id="preset-game-loadall">game.loadAll</button>' +
        '<button class="menu_button" style="font-size:11px;" id="preset-html-comment">去小CoT</button>' +
        '<button class="menu_button" style="font-size:11px;" id="preset-content-tag">content标签</button>' +
        '<button class="menu_button" style="font-size:11px;" id="preset-details-summary">details摘要</button>' +
        '</div>' +
        '</div>' +

        '<div style="margin-bottom:8px;">' +
        '<label>自定义规则:</label>' +
        '<div style="display:flex;gap:5px;margin-top:3px;">' +
        '<select id="summarizer-rule-type" class="text_pole" style="width:100px;">' +
        '<option value="include">包含</option>' +
        '<option value="exclude">排除</option>' +
        '<option value="regex-include">正则包含</option>' +
        '<option value="regex-exclude">正则排除</option>' +
        '</select>' +
        '<input type="text" id="summarizer-rule-value" class="text_pole" style="flex:1;" placeholder="标签名或正则表达式">' +</input>
        '<button class="menu_button" id="summarizer-add-rule">添加</button>' +
        '</div>' +
        '</div>' +

        '<div style="margin-bottom:8px;">' +
        '<label>当前规则:</label>' +
        '<div id="summarizer-rules-list" style="margin-top:3px;max-height:120px;overflow-y:auto;"></div>' +
        '</div>' +

        '<div style="display:flex;gap:5px;">' +
        '<button class="menu_button" id="summarizer-test-extract">测试提取</button>' +
        '<button class="menu_button" id="summarizer-clear-rules">清空规则</button>' +
        '</div>' +

        '</div>' +
        '</details>' +

        '<hr>' +

        '<div style="display:flex;gap:10px;margin:8px 0;">' +
        '<div style="flex:2;"><label>提示词:</label><textarea id="summarizer-prompt" class="text_pole" rows="2"></textarea></div>' +
        '<div style="flex:1;"><label>总结条数:</label><input type="number" id="summarizer-max-msgs" class="text_pole" min="5" max="200"></div>' +</input>
        '</div>' +

        '<div style="display:flex;gap:10px;margin:8px 0;">' +
        '<div style="flex:1;"><label>自动间隔:</label><input type="number" id="summarizer-trigger-interval" class="text_pole" min="10" max="200"></div>' +</input>
        '<div style="flex:1;"><label>保留显示:</label><input type="number" id="summarizer-keep-visible" class="text_pole" min="1" max="100"></div>' +</input>
        '</div>' +

        '<div style="display:flex;gap:15px;align-items:center;margin:8px 0;">' +
        '<label class="checkbox_label"><input type="checkbox" id="summarizer-auto-enabled"> 自动总结</input></label>' +
        '<label class="checkbox_label"><input type="checkbox" id="summarizer-auto-hide"> 自动隐藏</label>' +
        '</div>' +

        '<div id="summarizer-hide-status" style="font-size:12px;color:#888;margin:5px 0;">显示: - | 隐藏: - | 总计: -</div>' +

        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">' +
        '<button id="summarizer-btn" class="menu_button">总结</button>' +
        '<button id="summarizer-history-btn" class="menu_button">历史</button>' +
        '<button id="summarizer-clear-btn" class="menu_button">清空</button>' +
        '<button id="summarizer-unhide-btn" class="menu_button">取消隐藏</button>' +
        '</div>' +

        '<div id="summarizer-output" style="margin-top:10px;padding:10px;background:var(--SmartThemeBlurTintColor);border-radius:5px;max-height:200px;overflow-y:auto;white-space:pre-wrap;">就绪</div>' +

        '</div>' +
        '</div>';

    $("#extensions_settings2").append(html);

    $("#summarizer-api-endpoint").val(s.apiEndpoint).on("change", function() { s.apiEndpoint = this.value.trim(); saveSettings(); });
    $("#summarizer-api-key").val(s.apiKey).on("change", function() { s.apiKey = this.value.trim(); saveSettings(); });
    $("#summarizer-model-manual").val(s.model).on("change", function() { s.model = this.value.trim(); saveSettings(); });
    $("#summarizer-model-select").on("change", function() {
        if (this.value) {
            s.model = this.value;
            $("#summarizer-model-manual").val(this.value);
            saveSettings();
        }
    });
    $("#summarizer-prompt").val(s.summaryPrompt).on("change", function() { s.summaryPrompt = this.value; saveSettings(); });
    $("#summarizer-max-msgs").val(s.maxMessages).on("change", function() { s.maxMessages = parseInt(this.value) || 20; saveSettings(); });
    $("#summarizer-trigger-interval").val(s.triggerInterval).on("change", function() { s.triggerInterval = parseInt(this.value) || 20; saveSettings(); });
    $("#summarizer-keep-visible").val(s.keepVisible).on("change", function() { s.keepVisible = parseInt(this.value) || 10; saveSettings(); });
    $("#summarizer-auto-enabled").prop("checked", s.autoSummarize).on("change", function() { s.autoSummarize = this.checked; saveSettings(); });
    $("#summarizer-auto-hide").prop("checked", s.autoHide).on("change", function() { s.autoHide = this.checked; saveSettings(); });
    $("#summarizer-use-extraction").prop("checked", s.useExtraction).on("change", function() { s.useExtraction = this.checked; saveSettings(); });

    $("#summarizer-fetch-models").on("click", refreshModelList);
    $("#summarizer-test-btn").on("click", testConnection);
    $("#summarizer-btn").on("click", doSummarize);
    $("#summarizer-history-btn").on("click", showHistory);
    $("#summarizer-clear-btn").on("click", clearHistory);
    $("#summarizer-unhide-btn").on("click", unhideAll);

    $("#preset-game-loadall").on("click", function() { addPresetRule("game-loadall"); });
    $("#preset-html-comment").on("click", function() { addPresetRule("html-comment"); });
    $("#preset-content-tag").on("click", function() { addPresetRule("content-tag"); });
    $("#preset-details-summary").on("click", function() { addPresetRule("details-summary"); });

    $("#summarizer-add-rule").on("click", function() {
        var type = $("#summarizer-rule-type").val();
        var value = $("#summarizer-rule-value").val();
        addCustomRule(type, value);
        $("#summarizer-rule-value").val("");
    });

    $("#summarizer-test-extract").on("click", testExtraction);
    $("#summarizer-clear-rules").on("click", clearAllRules);

    renderRulesList();

    eventSource.on(event_types.MESSAGE_RECEIVED, function() { setTimeout(checkAuto, 1000); });
    eventSource.on(event_types.MESSAGE_SENT, function() { setTimeout(checkAuto, 1000); });

    setTimeout(updateHideStatus, 500);

    console.log("痔疮总结机 loaded");
});
