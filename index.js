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
    extractionRules: [],
    blacklist: ""
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

function applyExtractionRules(text) {
    var settings = getSettings();
    var rules = settings.extractionRules || [];
    if (rules.length === 0) return text;

    var processedText = text;
    var i, rule, tagName, regex, match;

    var excludeRules = rules.filter(function(r) { return r.type === "exclude"; });
    var regexExcludeRules = rules.filter(function(r) { return r.type === "regex-exclude"; });

    for (i = 0; i < excludeRules.length; i++) {
        rule = excludeRules[i];
        tagName = rule.value.trim();
        if (!tagName) continue;
        try {
            regex = new RegExp("<" + tagName + "[^>]*>[\\s\\S]*?</" + tagName + ">", "gi");
            processedText = processedText.replace(regex, "");
        } catch (e) { console.error("排除规则错误:", e); }
    }

    for (i = 0; i < regexExcludeRules.length; i++) {
        rule = regexExcludeRules[i];
        try {
            regex = new RegExp(rule.value, "gi");
            processedText = processedText.replace(regex, "");
        } catch (e) { console.error("正则排除错误:", e); }
    }

    var includeRules = rules.filter(function(r) { return r.type === "include"; });
    var regexIncludeRules = rules.filter(function(r) { return r.type === "regex-include"; });

    if (includeRules.length === 0 && regexIncludeRules.length === 0) {
        return applyBlacklist(processedText);
    }

    var extractedParts = [];

    for (i = 0; i < includeRules.length; i++) {
        rule = includeRules[i];
        tagName = rule.value.trim();
        if (!tagName) continue;
        try {
            regex = new RegExp("<" + tagName + "[^>]*>([\\s\\S]*?)</" + tagName + ">", "gi");
            while ((match = regex.exec(processedText)) !== null) {
                extractedParts.push(match[1]);
            }
        } catch (e) { console.error("包含规则错误:", e); }
    }

    for (i = 0; i < regexIncludeRules.length; i++) {
        rule = regexIncludeRules[i];
        try {
            regex = new RegExp(rule.value, "gi");
            while ((match = regex.exec(processedText)) !== null) {
                extractedParts.push(match[1] || match[0]);
            }
        } catch (e) { console.error("正则包含错误:", e); }
    }

    return applyBlacklist(extractedParts.join("\n\n"));
}

function applyBlacklist(text) {
    var settings = getSettings();
    var blacklist = settings.blacklist ? settings.blacklist.trim() : "";
    if (!blacklist) return text;

    var words = blacklist.split("\n");
    var result = text;
    for (var i = 0; i < words.length; i++) {
        var word = words[i].trim();
        if (word) result = result.split(word).join("");
    }
    return result;
}

function renderRulesList() {
    var settings = getSettings();
    var container = document.getElementById("summarizer-rules-list");
    if (!container) return;
    container.innerHTML = "";

    if (settings.extractionRules.length === 0) {
        container.innerHTML = "<div style=\"color:#888;font-size:12px;\">暂无规则</div>";
        return;
    }

    var typeLabels = { "include": "包含", "exclude": "排除", "regex-include": "正则包含", "regex-exclude": "正则排除" };
    var typeColors = { "include": "#4CAF50", "exclude": "#f44336", "regex-include": "#2196F3", "regex-exclude": "#FF9800" };

    for (var i = 0; i < settings.extractionRules.length; i++) {
        var rule = settings.extractionRules[i];
        var div = document.createElement("div");
        div.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px;background:rgba(255,255,255,0.05);border-radius:4px;margin-bottom:4px;";
        div.innerHTML = "<span style=\"background:" + typeColors[rule.type] + ";color:#fff;padding:2px 6px;border-radius:3px;font-size:11px;\">" + typeLabels[rule.type] + "</span>" +
            "<code style=\"flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;\">" + rule.value + "</code>" +
            "<button class=\"menu_button summarizer-del-rule\" data-idx=\"" + i + "\" style=\"padding:2px 8px;\">删</button>";
        container.appendChild(div);
    }

    var btns = container.querySelectorAll(".summarizer-del-rule");
    for (var j = 0; j < btns.length; j++) {
        btns[j].addEventListener("click", function() {
            settings.extractionRules.splice(parseInt(this.dataset.idx), 1);
            saveSettings();
            renderRulesList();
        });
    }
}

function addRule() {
    var settings = getSettings();
    var type = document.getElementById("summarizer-rule-type").value;
    var value = document.getElementById("summarizer-rule-value").value.trim();
    if (!value) return;

    if (type.indexOf("regex") !== -1) {
        try { new RegExp(value); }
        catch (e) { alert("正则错误: " + e.message); return; }
    }

    settings.extractionRules.push({ type: type, value: value });
    saveSettings();
    renderRulesList();
    document.getElementById("summarizer-rule-value").value = "";
}

function addPresetRule(type, value) {
    var settings = getSettings();
    settings.extractionRules.push({ type: type, value: value });
    saveSettings();
    renderRulesList();
}

function getCompletionsUrl(base) {
    base = base.trim().replace(/\/+$/, "");
    if (base.indexOf("/chat/completions") !== -1) return base;
    if (base.indexOf("/v1") === base.length - 3) return base + "/chat/completions";
    return base + "/v1/chat/completions";
}

function getModelsUrl(base) {
    base = base.trim().replace(/\/+$/, "");
    if (base.indexOf("/models") !== -1) return base;
    if (base.indexOf("/chat/completions") !== -1) return base.replace("/chat/completions", "/models");
    if (base.indexOf("/v1") === base.length - 3) return base + "/models";
    return base + "/v1/models";
}

function fetchModels() {
    var settings = getSettings();
    if (!settings.apiEndpoint || !settings.apiKey) return Promise.reject(new Error("填写API配置"));
    return fetch(getModelsUrl(settings.apiEndpoint), {
        method: "GET",
        headers: { "Authorization": "Bearer " + settings.apiKey }
    }).then(function(res) {
        if (!res.ok) throw new Error("" + res.status);
        return res.json();
    }).then(function(data) {
        return data.data || data.models || [];
    });
}

function testConnection() {
    var settings = getSettings();
    var status = document.getElementById("summarizer-status");
    status.textContent = "测试中...";
    status.style.color = "orange";

    if (!settings.apiEndpoint || !settings.apiKey || !settings.model) {
        status.textContent = "✗ 配置不完整";
        status.style.color = "red";
        return;
    }

    fetch(getCompletionsUrl(settings.apiEndpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + settings.apiKey },
        body: JSON.stringify({ model: settings.model, messages: [{ role: "user", content: "hi" }], max_tokens: 5 })
    }).then(function(res) {
        if (!res.ok) throw new Error("" + res.status);
        return res.json();
    }).then(function(data) {
        if (data.choices) {
            status.textContent = "✓ 成功";
            status.style.color = "lime";
        } else {
            throw new Error("响应异常");
        }
    }).catch(function(e) {
        status.textContent = "✗ " + e.message;
        status.style.color = "red";
    });
}

function refreshModelList() {
    var sel = document.getElementById("summarizer-model-select");
    var status = document.getElementById("summarizer-status");
    sel.innerHTML = "<option>加载中...</option>";
    status.textContent = "获取模型...";
    status.style.color = "orange";

    fetchModels().then(function(models) {
        sel.innerHTML = "<option value=\"\">-- 选择 --</option>";
        for (var i = 0; i < models.length; i++) {
            var id = models[i].id || models[i].name || models[i];
            sel.innerHTML += "<option value=\"" + id + "\">" + id + "</option>";
        }
        var settings = getSettings();
        if (settings.model) sel.value = settings.model;
        status.textContent = "✓ " + models.length + " 模型";
        status.style.color = "lime";
    }).catch(function(e) {
        sel.innerHTML = "<option>失败</option>";
        status.textContent = "✗ " + e.message;
        status.style.color = "red";
    });
}

function hideMessages(startIdx, endIdx) {
    var context = getContext();
    var chat = context.chat;
    if (!chat) return 0;

    var count = 0;
    for (var i = startIdx; i < endIdx && i < chat.length; i++) {
        if (!chat[i].is_system && !chat[i].is_hidden) {
            chat[i].is_hidden = true;
            count++;
        }
    }
    if (count > 0 && typeof context.saveChat === "function") context.saveChat();
    return count;
}

function checkContinuousHide() {
    var settings = getSettings();
    if (!settings.autoHide) return;

    var context = getContext();
    var chat = context.chat;
    if (!chat || chat.length === 0) return;

    var hideUntil = chat.length - settings.keepVisible;
    if (hideUntil > 0) {
        var count = 0;
        for (var i = 0; i < hideUntil; i++) {
            if (!chat[i].is_system && !chat[i].is_hidden) {
                chat[i].is_hidden = true;
                count++;
            }
        }
        if (count > 0 && typeof context.saveChat === "function") {
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
        if (chat[i].is_system) continue;
        total++;
        if (chat[i].is_hidden) hidden++;
        else visible++;
    }

    var el = document.getElementById("summarizer-hide-status");
    if (el) el.textContent = "显示: " + visible + " | 隐藏: " + hidden + " | 总计: " + total;
}

function unhideAll() {
    var context = getContext();
    var chat = context.chat;
    if (!chat) return;

    var count = 0;
    for (var i = 0; i < chat.length; i++) {
        if (chat[i].is_hidden) { chat[i].is_hidden = false; count++; }
    }
    if (count > 0 && typeof context.saveChat === "function") context.saveChat();
    updateHideStatus();
    document.getElementById("summarizer-output").textContent = "已取消隐藏 " + count + " 条";
}

function getRecentChat(start, end) {
    var context = getContext();
    var chat = context.chat;
    if (!chat || chat.length === 0) return null;
    var text = "";
    for (var i = start; i < end && i < chat.length; i++) {
        var m = chat[i];
        if (m.is_system) continue;
        var content = applyExtractionRules(m.mes);
        if (content.trim()) {
            text += (m.is_user ? "用户" : m.name) + ": " + content + "\n\n";
        }
    }
    return text;
}

function callAPI(prompt) {
    var settings = getSettings();
    if (!settings.apiEndpoint || !settings.apiKey || !settings.model) {
        return Promise.reject(new Error("配置不完整"));
    }

    return fetch(getCompletionsUrl(settings.apiEndpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + settings.apiKey },
        body: JSON.stringify({
            model: settings.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 2000
        })
    }).then(function(res) {
        if (!res.ok) throw new Error("API " + res.status);
        return res.json();
    }).then(function(data) {
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content;
        }
        return "失败";
    });
}

function doSummarize() {
    var settings = getSettings();
    var out = document.getElementById("summarizer-output");
    var btn = document.getElementById("summarizer-btn");
    out.textContent = "生成中...";
    btn.disabled = true;

    var context = getContext();
    var len = context.chat ? context.chat.length : 0;
    var start = Math.max(0, len - settings.maxMessages);
    var chat = getRecentChat(start, len);

    if (!chat) {
        out.textContent = "无记录";
        btn.disabled = false;
        return;
    }

    callAPI(chat + "\n---\n" + settings.summaryPrompt).then(function(summary) {
        out.textContent = summary;
        settings.savedSummaries.push({ time: new Date().toLocaleString(), range: (start + 1) + "-" + len, content: summary });

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
        btn.disabled = false;
    }).catch(function(e) {
        out.textContent = "错误: " + e.message;
        btn.disabled = false;
    });
}

function checkAuto() {
    var settings = getSettings();
    if (settings.autoHide) checkContinuousHide();
    if (!settings.autoSummarize) return;

    var context = getContext();
    var len = context.chat ? context.chat.length : 0;
    if (len - settings.lastSummarizedIndex < settings.triggerInterval) return;

    var out = document.getElementById("summarizer-output");
    var start = settings.lastSummarizedIndex;
    var chat = getRecentChat(start, len);
    if (!chat) return;

    out.textContent = "[自动总结中...]";

    callAPI(chat + "\n---\n" + settings.summaryPrompt).then(function(summary) {
        settings.savedSummaries.push({ time: new Date().toLocaleString(), range: (start + 1) + "-" + len, content: summary, auto: true });

        if (settings.autoHide) {
            var hideUntil = len - settings.keepVisible;
            if (hideUntil > 0) hideMessages(0, hideUntil);
        }

        settings.lastSummarizedIndex = len;
        saveSettings();
        updateHideStatus();
        out.textContent = "[自动总结完成]\n" + summary;
    }).catch(function(e) {
        console.error("自动总结失败", e);
        out.textContent = "自动总结失败: " + e.message;
    });
}

function showHistory() {
    var s = getSettings();
    var out = document.getElementById("summarizer-output");
    if (!s.savedSummaries.length) { out.textContent = "无历史"; return; }
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

function testExtraction() {
    var context = getContext();
    var chat = context.chat;
    if (!chat || chat.length === 0) {
        document.getElementById("summarizer-output").textContent = "无聊天记录";
        return;
    }
    var lastMsg = null;
    for (var i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_system) { lastMsg = chat[i]; break; }
    }
    if (!lastMsg) {
        document.getElementById("summarizer-output").textContent = "无有效消息";
        return;
    }
    var original = lastMsg.mes;
    var processed = applyExtractionRules(original);
    document.getElementById("summarizer-output").textContent =
        "=== 原文 ===\n" + original.slice(0, 500) + (original.length > 500 ? "..." : "") +
        "\n\n=== 处理后 ===\n" + processed.slice(0, 500) + (processed.length > 500 ? "..." : "");
}

jQuery(function() {
    loadSettings();
    var s = getSettings();

    var html = "";
    html += "<div class=\"inline-drawer\">";
    html += "<div class=\"inline-drawer-toggle inline-drawer-header\">";
    html += "<b>痔疮总结机</b>";
    html += "<div class=\"inline-drawer-icon fa-solid fa-circle-chevron-down\"></div>";
    html += "</div>";
    html += "<div class=\"inline-drawer-content\">";

    html += "<h4 style=\"margin:5px 0;\">API 配置</h4>";
    html += "<div style=\"display:flex;gap:10px;margin-bottom:8px;\">";
    html += "<div style=\"flex:1;\"><label>API地址:</label><input type=\"text\" id=\"summarizer-api-endpoint\" class=\"text_pole\" placeholder=\"https://xxx/v1\"></div>";</input>
    html += "<div style=\"flex:1;\"><label>API密钥:</label><input type=\"password\" id=\"summarizer-api-key\" class=\"text_pole\"></div>";</input>
    html += "</div>";
    html += "<div style=\"display:flex;gap:10px;align-items:end;margin-bottom:8px;\">";
    html += "<div style=\"flex:1;\"><label>模型:</label><select id=\"summarizer-model-select\" class=\"text_pole\"><option>--</option></select></div>";
    html += "<div style=\"flex:1;\"><label>手动:</label><input type=\"text\" id=\"summarizer-model-manual\" class=\"text_pole\"></div>";</input>
    html += "<button id=\"summarizer-fetch-models\" class=\"menu_button\">获取</button>";
    html += "<button id=\"summarizer-test-btn\" class=\"menu_button\">测试</button>";
    html += "</div>";
    html += "<div id=\"summarizer-status\" style=\"font-size:12px;color:gray;margin-bottom:8px;\">未连接</div>";

    html += "<hr style=\"border-color:#444;margin:10px 0;\">";</hr>
    html += "<h4 style=\"margin:5px 0;\">标签提取规则</h4>";
    html += "<div style=\"display:flex;gap:8px;margin-bottom:8px;\">";
    html += "<select id=\"summarizer-rule-type\" class=\"text_pole\" style=\"width:120px;\">";
    html += "<option value=\"include\">包含</option>";
    html += "<option value=\"exclude\">排除</option>";
    html += "<option value=\"regex-include\">正则包含</option>";
    html += "<option value=\"regex-exclude\">正则排除</option>";
    html += "</select>";
    html += "<input type=\"text\" id=\"summarizer-rule-value\" class=\"text_pole\" placeholder=\"标签名或正则\" style=\"flex:1;\">";</input>
    html += "<button id=\"summarizer-add-rule\" class=\"menu_button\">添加</button>";
    html += "</div>";
    html += "<div style=\"display:flex;gap:5px;margin-bottom:8px;flex-wrap:wrap;\">";
    html += "<button id=\"summarizer-preset-cot\" class=\"menu_button\" style=\"font-size:11px;\">去除小CoT</button>";
    html += "<button id=\"summarizer-preset-thinking\" class=\"menu_button\" style=\"font-size:11px;\">排除thinking</button>";
    html += "<button id=\"summarizer-preset-content\" class=\"menu_button\" style=\"font-size:11px;\">只含content</button>";
    html += "<button id=\"summarizer-clear-rules\" class=\"menu_button\" style=\"font-size:11px;\">清空规则</button>";
    html += "<button id=\"summarizer-test-extract\" class=\"menu_button\" style=\"font-size:11px;\">测试规则</button>";
    html += "</div>";
    html += "<div id=\"summarizer-rules-list\" style=\"max-height:120px;overflow-y:auto;margin-bottom:8px;\"></div>";
    html += "<label>黑名单:</label>";
    html += "<textarea id=\"summarizer-blacklist\" class=\"text_pole\" rows=\"2\" placeholder=\"每行一个词\"></textarea>";

    html += "<hr style=\"border-color:#444;margin:10px 0;\">";
    html += "<h4 style=\"margin:5px 0;\">总结设置</h4>";
    html += "<div style=\"display:flex;gap:10px;margin:8px 0;\">";
    html += "<div style=\"flex:2;\"><label>提示词:</label><textarea id=\"summarizer-prompt\" class=\"text_pole\" rows=\"2\"></textarea></div>";
    html += "<div style=\"flex:1;\"><label>总结条数:</label><input type=\"number\" id=\"summarizer-max-msgs\" class=\"text_pole\" min=\"5\" max=\"200\"></div>";</input>
    html += "</div>";
    html += "<div style=\"display:flex;gap:10px;margin:8px 0;\">";
    html += "<div style=\"flex:1;\"><label>自动间隔:</label><input type=\"number\" id=\"summarizer-trigger-interval\" class=\"text_pole\" min=\"10\" max=\"200\"></div>";</input>
    html += "<div style=\"flex:1;\"><label>保留显示:</label><input type=\"number\" id=\"summarizer-keep-visible\" class=\"text_pole\" min=\"1\" max=\"100\"></div>";</input>
    html += "</div>";
    html += "<div style=\"display:flex;gap:15px;align-items:center;margin:8px 0;\">";
    html += "<label class=\"checkbox_label\"><input type=\"checkbox\" id=\"summarizer-auto-enabled\"> 自动总结</input></label>";
    html += "<label class=\"checkbox_label\"><input type=\"checkbox\" id=\"summarizer-auto-hide\"> 自动隐藏</label>";
    html += "</div>";
    html += "<div id=\"summarizer-hide-status\" style=\"font-size:12px;color:#888;margin:5px 0;\">显示: - | 隐藏: - | 总计: -</div>";
    html += "<div style=\"display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;\">";
    html += "<button id=\"summarizer-btn\" class=\"menu_button\">总结</button>";
    html += "<button id=\"summarizer-history-btn\" class=\"menu_button\">历史</button>";
    html += "<button id=\"summarizer-clear-btn\" class=\"menu_button\">清空</button>";
    html += "<button id=\"summarizer-unhide-btn\" class=\"menu_button\">取消隐藏</button>";
    html += "</div>";
    html += "<div id=\"summarizer-output\" style=\"margin-top:10px;padding:10px;background:var(--SmartThemeBlurTintColor);border-radius:5px;max-height:200px;overflow-y:auto;white-space:pre-wrap;\">就绪</div>";

    html += "</div>";
    html += "</div>";

    $("#extensions_settings2").append(html);

    $("#summarizer-api-endpoint").val(s.apiEndpoint).on("change", function() { s.apiEndpoint = this.value.trim(); saveSettings(); });
    $("#summarizer-api-key").val(s.apiKey).on("change", function() { s.apiKey = this.value.trim(); saveSettings(); });
    $("#summarizer-model-manual").val(s.model).on("change", function() { s.model = this.value.trim(); saveSettings(); });
    $("#summarizer-model-select").on("change", function() { if (this.value) { s.model = this.value; $("#summarizer-model-manual").val(this.value); saveSettings(); } });
    $("#summarizer-prompt").val(s.summaryPrompt).on("change", function() { s.summaryPrompt = this.value; saveSettings(); });
    $("#summarizer-max-msgs").val(s.maxMessages).on("change", function() { s.maxMessages = parseInt(this.value) || 20; saveSettings(); });
    $("#summarizer-trigger-interval").val(s.triggerInterval).on("change", function() { s.triggerInterval = parseInt(this.value) || 20; saveSettings(); });
    $("#summarizer-keep-visible").val(s.keepVisible).on("change", function() { s.keepVisible = parseInt(this.value) || 10; saveSettings(); });
    $("#summarizer-auto-enabled").prop("checked", s.autoSummarize).on("change", function() { s.autoSummarize = this.checked; saveSettings(); });
    $("#summarizer-auto-hide").prop("checked", s.autoHide).on("change", function() { s.autoHide = this.checked; saveSettings(); });
    $("#summarizer-blacklist").val(s.blacklist).on("change", function() { s.blacklist = this.value; saveSettings(); });

    $("#summarizer-fetch-models").on("click", refreshModelList);
    $("#summarizer-test-btn").on("click", testConnection);
    $("#summarizer-add-rule").on("click", addRule);
    $("#summarizer-clear-rules").on("click", function() { s.extractionRules = []; saveSettings(); renderRulesList(); });
    $("#summarizer-test-extract").on("click", testExtraction);
    $("#summarizer-preset-cot").on("click", function() { addPresetRule("regex-exclude", ""); });
    $("#summarizer-preset-thinking").on("click", function() { addPresetRule("exclude", "thinking"); });
    $("#summarizer-preset-content").on("click", function() { addPresetRule("include", "content"); });
    $("#summarizer-btn").on("click", doSummarize);
    $("#summarizer-history-btn").on("click", showHistory);
    $("#summarizer-clear-btn").on("click", clearHistory);
    $("#summarizer-unhide-btn").on("click", unhideAll);

    eventSource.on(event_types.MESSAGE_RECEIVED, function() { setTimeout(checkAuto, 1000); });
    eventSource.on(event_types.MESSAGE_SENT, function() { setTimeout(checkAuto, 1000); });

    setTimeout(function() {
        updateHideStatus();
        renderRulesList();
    }, 500);

    console.log("痔疮总结机 loaded");
});
