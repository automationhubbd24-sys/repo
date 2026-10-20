const session = require("express-session");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");
const os = require("os");
const AT = (function () {
const AT_PREFIX = "anti-truncation/";
const AT_TOOL_NAME = "emit_answer";
const AT_MAX_ATTEMPTS = 3;
// After this much time since the request arrived, an unfinished round fails instead of continuing.
const AT_CONTINUE_DEADLINE_MS = 360000;
const AT_SYSTEM_HINT =
  "\n\n[SYSTEM CONSTRAINT] You have a tool named emit_answer. " +
  "When you are ready to output your final complete answer, you MUST call " +
  "emit_answer with the full answer text as the value of the key \"answer\". " +
  "Do not output the answer as plain text. Do not stop early. " +
  "If the answer is long, call emit_answer once with the complete content.";

// Google rejects a conversation whose last turn is the model. Turn trailing
// plain-text model turns into user turns; tool-call turns are left untouched.
function fixTrailingModelTurn(body, logger) {
  if (!body || !Array.isArray(body.contents) || !body.contents.length) return body;
  let changed = 0;
  for (let i = body.contents.length - 1; i >= 0; i--) {
    const c = body.contents[i];
    if (!c || c.role !== "model") break;
    const parts = Array.isArray(c.parts) ? c.parts : [];
    if (parts.some((p) => p && (p.functionCall || p.functionResponse))) break;
    body.contents[i] = { ...c, role: "user" };
    changed++;
  }
  if (changed && logger) logger.info("[Adapter] 末尾 " + changed + " 条助手消息已改为用户消息");
  return body;
}
function atIsEnabled(modelName) {
  return typeof modelName === "string" && modelName.startsWith(AT_PREFIX);
}
function atRealModel(modelName) {
  return atIsEnabled(modelName) ? modelName.slice(AT_PREFIX.length) : modelName;
}
function atInjectTools(googleBody) {
  if (!googleBody || !Array.isArray(googleBody.contents)) return googleBody;
  const alreadyInjected = (googleBody.tools || []).some((t) =>
    (t.functionDeclarations || []).some((d) => d.name === AT_TOOL_NAME),
  );
  if (alreadyInjected) return googleBody;
  const decl = {
    name: AT_TOOL_NAME,
    description: "Emit your final complete answer.",
    parameters: {
      type: "OBJECT",
      properties: { answer: { type: "STRING" } },
      required: ["answer"],
    },
  };
  googleBody.tools = [...(googleBody.tools || []), { functionDeclarations: [decl] }];
  const sys = googleBody.systemInstruction;
  let sysText = "";
  if (sys && sys.parts && sys.parts.length > 0) {
    sysText = sys.parts.map((p) => p.text || "").join("\n");
  }
  googleBody.systemInstruction = {
    role: "system",
    parts: [{ text: sysText + AT_SYSTEM_HINT }],
  };
  return googleBody;
}
function atExtractAnswer(googleResponse) {
  // Returns { found: true, answer, finishReason } or { found: false }.
  const candidate = googleResponse && googleResponse.candidates && googleResponse.candidates[0];
  if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) {
    return {found:false,finishReason:candidate?.finishReason || googleResponse?.promptFeedback?.blockReason || null};
  }
  let answer = null;
      let finishReason = candidate.finishReason || null;
  for (const part of candidate.content.parts) {
    const fc = part.functionCall;
    if (fc && fc.name === AT_TOOL_NAME && fc.args && typeof fc.args.answer === "string") {
      answer = fc.args.answer;
      finishReason = candidate.finishReason || null;
    }
  }
  if (answer !== null) return { found: true, answer, finishReason };
  return { found: false, finishReason };
}
function atBuildContinuationBody(googleBody, googleResponse, prevAnswer) {
  // Append the model function-call + a user "continue" request to contents.
  const candidate = googleResponse.candidates && googleResponse.candidates[0];
  const newContents = Array.isArray(googleBody.contents) ? [...googleBody.contents] : [];
  if (candidate && candidate.content) {
    const modelParts = Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    if (modelParts.length) newContents.push({ role: "model", parts: modelParts });
    const calls = modelParts.filter(p=>p.functionCall); if (calls.length) newContents.push({role:/user/.source,parts:calls.map(p=>({functionResponse:{name:p.functionCall.name,...(p.functionCall.id?{id:p.functionCall.id}:{}),response:{status:/incomplete/.source}}}))});
  }
  const contText =
    "Your previous emit_answer call was incomplete or missing. " +
    (prevAnswer ? "Previous partial answer: " + prevAnswer + "\n\n" : "") +
    "Call emit_answer again with the COMPLETE final answer (key \"answer\").";
  newContents.push({ role: "user", parts: [{ text: contText }] });
  const body = Object.assign({}, googleBody, { contents: newContents });
  if (body.generationConfig) {
    body.generationConfig = Object.assign({}, body.generationConfig);
    delete body.generationConfig.maxOutputTokens;
  }
  return body;
}
const AT_BLOCK_REASONS = /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY|OTHER_SAFETY)$/;
function atBlockInfo(googleResponse) {
  if (!googleResponse || typeof googleResponse !== 'object') return null;
  const candidate = Array.isArray(googleResponse.candidates) ? googleResponse.candidates[0] : null;
  const finish = candidate && typeof candidate.finishReason === 'string' ? candidate.finishReason : null;
  const promptBlock = googleResponse.promptFeedback && typeof googleResponse.promptFeedback.blockReason === 'string'
    ? googleResponse.promptFeedback.blockReason : null;
  let reason = null, stage = null;
  if (promptBlock && /^[A-Z_]{1,40}$/.test(promptBlock) && promptBlock !== 'BLOCK_REASON_UNSPECIFIED') { reason = promptBlock; stage = 'prompt'; }
  else if (finish && AT_BLOCK_REASONS.test(finish)) { reason = finish; stage = 'response'; }
  if (!reason) return null;
  const u = googleResponse.usageMetadata;
  const promptTokens = u && Number.isSafeInteger(u.promptTokenCount) && u.promptTokenCount >= 0 ? u.promptTokenCount : null;
  return { reason, stage, promptTokens };
}
function atBlockMessage(info) {
  return '上游内容安全拦截（' + info.reason + '）：模型拒绝生成，本次没有输出。' +
    '这类拦截有时是误判，可以直接重试；多次被拦请调整内容。';
}
// Upstream ended the generation early (finish=OTHER etc.) without emit_answer. Nothing is returned
// to the client; the error carries the finish reason and token counts so the request record shows why.
function atFinishPayload(info, httpStatus) {
  const payload = info.timeLimit
    ? { error: { code: httpStatus, type: 'upstream_incomplete', status: 'AT_TIME_LIMIT',
      message: '已用时约 ' + Math.round(info.elapsedMs / 60000) + ' 分钟仍未得到完整答案（finish=' + info.reason + '），超过 6 分钟不再续写，直接返回失败。已生成约 ' + info.chars + ' 字被丢弃，可重试。' } }
    : { error: { code: httpStatus, type: 'upstream_incomplete', status: 'FINISH_' + info.reason,
    message: '上游中途结束（finish=' + info.reason + '），未返回内容。已生成约 ' + info.chars + ' 字被丢弃，可重试。' } };
  if (info.promptTokens !== null || info.outputTokens !== null) payload.usage = { prompt_tokens: info.promptTokens, completion_tokens: info.outputTokens };
  return payload;
}
function atBlockPayload(info, httpStatus) {
  const payload = { error: { code: httpStatus, type: 'content_blocked', status: info.reason, message: atBlockMessage(info), block_stage: info.stage } };
  if (info.promptTokens !== null) payload.usage = { prompt_tokens: info.promptTokens };
  return payload;
}
  return { AT_PREFIX, AT_TOOL_NAME, AT_MAX_ATTEMPTS, AT_CONTINUE_DEADLINE_MS, fixTrailingModelTurn, atIsEnabled, atRealModel, atInjectTools, atExtractAnswer, atBuildContinuationBody, atBlockInfo, atBlockMessage, atBlockPayload, atFinishPayload };
})();

// ===================================================================================
// AUTH SOURCE MANAGEMENT MODULE
// ===================================================================================
class AuthSource {
  constructor(logger) {
    this.logger = logger;
    this.authMode = "file";
    this.availableIndices = [];
    this.initialIndices = [];
    this.accountNameMap = new Map();

    if (process.env.AUTH_JSON_1) {
      this.authMode = "env";
      this.logger.info(
        "[Auth] 检测到 AUTH_JSON_1 环境变量，切换到环境变量认证模式。",
      );
    } else {
      this.logger.info(
        '[Auth] 未检测到环境变量认证，将使用 "auth/" 目录下的文件。',
      );
    }

    this._discoverAvailableIndices(); // 初步发现所有存在的源
    this._preValidateAndFilter(); // 预检验并过滤掉格式错误的源

    if (this.availableIndices.length === 0) {
      this.logger.warn(
        `[Auth] 在 '${this.authMode}' 模式下未找到任何有效的认证源；需要导入账号。`,
      );
    }
  }

  _discoverAvailableIndices() {
    let indices = [];
    if (this.authMode === "env") {
      const regex = /^AUTH_JSON_(\d+)$/;
      // [关键修复] 完整的 for...in 循环，用于扫描所有环境变量
      for (const key in process.env) {
        const match = key.match(regex);
        if (match && match[1]) {
          indices.push(parseInt(match[1], 10));
        }
      }
    } else {
      // 'file' mode
      const authDir = path.join(__dirname, "auth");
      if (!fs.existsSync(authDir)) {
        this.logger.warn('[Auth] "auth/" 目录不存在。');
        this.availableIndices = [];
        return;
      }
      try {
        const files = fs.readdirSync(authDir);
        const authFiles = files.filter((file) => /^auth-\d+\.json$/.test(file));
        indices = authFiles.map((file) =>
          parseInt(file.match(/^auth-(\d+)\.json$/)[1], 10),
        );
      } catch (error) {
        this.logger.error(`[Auth] 扫描 "auth/" 目录失败: ${error.message}`);
        this.availableIndices = [];
        return;
      }
    }

    // 存取扫描到的原始索引
    this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    this.availableIndices = [...this.initialIndices]; // 先假设都可用

    this.logger.info(
      `[Auth] 在 '${this.authMode}' 模式下，初步发现 ${
        this.initialIndices.length
      } 个认证源: [${this.initialIndices.join(", ")}]`,
    );
  }

  _preValidateAndFilter() {
    if (this.availableIndices.length === 0) return;

    this.logger.info("[Auth] 开始预检验所有认证源的JSON格式...");
    const validIndices = [];
    const invalidSourceDescriptions = [];

    for (const index of this.availableIndices) {
      // 注意：这里我们调用一个内部的、简化的 getAuthContent
      const authContent = this._getAuthContent(index);
      if (authContent) {
        try {
          const authData = JSON.parse(authContent);
          validIndices.push(index);
          this.accountNameMap.set(
            index,
            authData.accountName || "N/A (未命名)",
          );
        } catch (e) {
          invalidSourceDescriptions.push(`auth-${index}`);
        }
      } else {
        invalidSourceDescriptions.push(`auth-${index} (无法读取)`);
      }
    }

    if (invalidSourceDescriptions.length > 0) {
      this.logger.warn(
        `⚠️ [Auth] 预检验发现 ${
          invalidSourceDescriptions.length
        } 个格式错误或无法读取的认证源: [${invalidSourceDescriptions.join(
          ", ",
        )}]，将从可用列表中移除。`,
      );
    }

    this.availableIndices = validIndices;
  }

  // 一个内部辅助函数，仅用于预检验，避免日志污染
  _getAuthContent(index) {
    if (this.authMode === "env") {
      return process.env[`AUTH_JSON_${index}`];
    } else {
      const authFilePath = path.join(__dirname, "auth", `auth-${index}.json`);
      if (!fs.existsSync(authFilePath)) return null;
      try {
        return fs.readFileSync(authFilePath, "utf-8");
      } catch (e) {
        return null;
      }
    }
  }

  getAuth(index) {
    if (!this.availableIndices.includes(index)) {
      this.logger.error(`[Auth] 请求了无效或不存在的认证索引: ${index}`);
      return null;
    }

    let jsonString = this._getAuthContent(index);
    if (!jsonString) {
      this.logger.error(`[Auth] 在读取时无法获取认证源 #${index} 的内容。`);
      return null;
    }

    try {
      return JSON.parse(jsonString);
    } catch (e) {
      this.logger.error(
        `[Auth] 解析来自认证源 #${index} 的JSON内容失败: ${e.message}`,
      );
      return null;
    }
  }
}
// ===================================================================================
// BROWSER MANAGEMENT MODULE
// ===================================================================================

class BrowserManager {
  constructor(logger, config, authSource) {
    this.logger = logger;
    this.config = config;
    this.authSource = authSource;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentAuthIndex = 0;
    this.scriptFileName = "black-browser.js";
    this.noButtonCount = 0;
    this.isWakeupRunning = false;
    this.launchArgs = [
      "--disable-dev-shm-usage", // 关键！防止 /dev/shm 空间不足导致浏览器崩溃
      "--disable-gpu",
      "--no-sandbox", // 在受限的容器环境中通常需要
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--safebrowsing-disable-auto-update",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ];

    if (this.config.browserExecutablePath) {
      this.browserExecutablePath = this.config.browserExecutablePath;
    } else {
      const platform = os.platform();
      if (platform === "linux") {
        this.browserExecutablePath = path.join(
          __dirname,
          "camoufox-linux",
          "camoufox",
        );
      } else {
        throw new Error(`Unsupported operating system: ${platform}`);
      }
    }
  }

  notifyUserActivity() {
    if (this.noButtonCount > 0) {
      this.logger.info(
        "[Browser] ⚡ 收到用户请求信号，强制唤醒后台检测 (重置计数器)",
      );
      this.noButtonCount = 0;
    }
  }

  async launchOrSwitchContext(authIndex) {
    if (!this.browser) {
      this.logger.info("🚀 [Browser] 浏览器实例未运行，正在进行首次启动...");
      if (!fs.existsSync(this.browserExecutablePath)) {
        throw new Error(
          `Browser executable not found at path: ${this.browserExecutablePath}`,
        );
      }
      this.browser = await firefox.launch({
        headless: true,
        executablePath: this.browserExecutablePath,
        args: this.launchArgs,
        ...(process.env.PROXY_URL ? { proxy: (() => { const u = new URL(process.env.PROXY_URL); return {server: u.protocol + "//" + u.host, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), bypass: "localhost,127.0.0.1"}; })() } : {}),
      });
      this.browser.on("disconnected", () => {
        this.logger.error("❌ [Browser] 浏览器意外断开连接！");
        this.browser = null;
        this.context = null;
        this.page = null;
      });
      this.logger.info("✅ [Browser] 浏览器实例已成功启动。");
    }
    if (this.context) {
      this.logger.info("[Browser] 正在关闭旧的浏览器上下文...");
      await this.context.close();
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 旧上下文已关闭。");
    }

    const sourceDescription =
      this.authSource.authMode === "env"
        ? `环境变量 AUTH_JSON_${authIndex}`
        : `文件 auth-${authIndex}.json`;
    this.logger.info("==================================================");
    this.logger.info(
      `🔄 [Browser] 正在为账号 #${authIndex} 创建新的浏览器上下文`,
    );
    this.logger.info(`   • 认证源: ${sourceDescription}`);
    this.logger.info("==================================================");

    const storageStateObject = this.authSource.getAuth(authIndex);
    if (!storageStateObject) {
      throw new Error(
        `Failed to get or parse auth source for index ${authIndex}.`,
      );
    }
    const buildScriptContent = fs.readFileSync(
      path.join(__dirname, this.scriptFileName),
      "utf-8",
    );

    try {
      // Camoufox rejects Playwright's default viewport protocol payload because it
      // contains `isMobile`. A null viewport disables that default command.
      this.context = await this.browser.newContext({
        storageState: storageStateObject,
        viewport: null,
      });
      await this.context.addInitScript({ content: buildScriptContent });
      if (process.env.WORKER_ACCOUNT) {
        await require('./verified-client-route').install(
          this.context, buildScriptContent,
          record => this.logger.info('[VerifiedClientRoute] '+JSON.stringify(record))
        );
      }
      this.page = await this.context.newPage();
      // ---- GenerateContent bridge: Google rejects POST via ProxyUnaryCall/ProxyStreamedCall; call MakerSuite GenerateContent directly ----
      {
        const GCB_INSTALL = `(function(){var M=window.default_MakerSuite;if(!M||!M.Cn||!M.GB)return 'nom';
if(!M.Cn.__gcb){var o=M.Cn;var f=function(a,b){if(a&&a.mb)window.__tb=a;return o.apply(this,arguments)};f.__gcb=1;M.Cn=f;}
if(!window.__gcCall||window.__gcCall.v!==5){window.__gcCall=async function(body,ht,key,hx){hx=hx||{};var M=window.default_MakerSuite,tb=window.__tb;if(!tb)return JSON.stringify({s:503,t:'[14,"token service not ready"]'});
var md=tb.getMetadata()||{};var waa=md['X-Goog-Api-Key'];if(!key){var mb=tb.mb||{};for(var k in mb){var v=mb[k];if(typeof v==='string'&&/^AIza[0-9A-Za-z_-]{30,}$/.test(v)&&v!==waa){key=v;break;}}}
if(!key)return JSON.stringify({s:503,t:'[14,"page api key not found"]'});
var base='https://alkalimakersuite-pa.clients6.google.com';var au=md['X-Goog-AuthUser']!=null?String(md['X-Goog-AuthUser']):'0';
body[4]=await M.Cn(tb,await M.GB(ht));
var hd={'content-type':'application/json+protobuf','x-user-agent':'grpc-web-javascript/0.1','x-goog-api-key':key,'authorization':md.Authorization,'x-goog-authuser':au};var tier=hx.tier||null;if(!tier){if(window.__gcTier===undefined){try{var tr=await fetch(base+'/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GetAiStudioBenefitTier',{method:'POST',credentials:'include',headers:hd,body:'[]'});var tj=tr.ok?JSON.parse(await tr.text()):null;var tv=Array.isArray(tj)?tj[0]:null;window.__gcTier=tv===1?'TIER1':tv===2?'TIER2':null;}catch(e){window.__gcTier=null;}}tier=window.__gcTier;}if(tier)hd['x-aistudio-g1-tier']=tier;if(hx.ext)hd['x-goog-ext-519733851-bin']=hx.ext;var ac=new AbortController(),hm=hx.hardMs||660000,wd=setTimeout(function(){ac.abort();},hm);var ab_=window.__gcAb=window.__gcAb||{};if(hx.op)ab_[hx.op]=ac;try{var r=await fetch(base+'/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent',{method:'POST',credentials:'include',headers:hd,body:JSON.stringify(body),signal:ac.signal});var tx=await r.text();}catch(e){if(ac.__cancel)return JSON.stringify({s:499,t:'cancelled',tier:tier||''});var ab=ac.signal.aborted;return JSON.stringify({s:504,t:JSON.stringify({error:{code:504,status:ab?'UPSTREAM_NO_RESPONSE':'UPSTREAM_CONNECTION_LOST',message:ab?('Google 超过 '+Math.round(hm/60000)+' 分钟没有返回，已主动中止，请重试。'):('与 Google 的连接中途断开：'+String(e&&e.message||e)+'，请重试。')}}),tier:tier||''});}finally{clearTimeout(wd);if(hx.op)delete ab_[hx.op];}
return JSON.stringify({s:r.status,t:tx,tier:tier||''});};window.__gcCall.v=5;window.__gcAbort=function(op){var c=window.__gcAb&&window.__gcAb[op];if(!c)return false;c.__cancel=true;c.abort();return true;};}
return window.__tb?'ok':'wait';})()`;
        const pg = this.page, log = this.logger;
        global.__gcbPage = pg; let gcbKey = null; const gcbHx = {}; const gcbWaa = 'AIzaSyBGb5fGAyC-pRcRU6MUHb__b_vKha71HRE'; const GCB_HARD_MS = Number(process.env.GCB_HARD_MS) || 660000; const gcbOps = new Map(); const gcbCancelled = new Set(); let gcbSeq = 0;
        this.gcbCancel = rid => { gcbCancelled.add(rid); setTimeout(() => gcbCancelled.delete(rid), 120000).unref?.(); const op = gcbOps.get(rid); if (!op) return false; gcbOps.delete(rid); log.info('[GCBridge] client cancelled ' + rid + '; aborting upstream call ' + op); pg.evaluate(o => window.wrappedJSObject.__gcAbort(o), op).catch(() => {}); return true; }; // Google itself cuts at ~600s
        this.context.on('request', r => { try { if (!/alkalimakersuite-pa\.clients6\.google\.com\/\$rpc\/.*MakerSuiteService\//.test(r.url())) return; const k = r.headers()['x-goog-api-key']; if (k && k !== gcbWaa && /^AIza/.test(k)) gcbKey = k; const h = r.headers(); if (h['x-aistudio-g1-tier']) gcbHx.tier = h['x-aistudio-g1-tier']; if (h['x-goog-ext-519733851-bin']) gcbHx.ext = h['x-goog-ext-519733851-bin']; } catch {} });
        const gcbInstall = () => pg.evaluate(c => window.wrappedJSObject.eval(c), GCB_INSTALL).catch(() => 'err');
        const gcbTimer = setInterval(() => { if (pg.isClosed()) return clearInterval(gcbTimer); gcbInstall(); }, 3000);
        const CAT = { HARM_CATEGORY_HARASSMENT: 7, HARM_CATEGORY_HATE_SPEECH: 8, HARM_CATEGORY_SEXUALLY_EXPLICIT: 9, HARM_CATEGORY_DANGEROUS_CONTENT: 10, HARM_CATEGORY_CIVIC_INTEGRITY: 11 };
        const THR = { BLOCK_LOW_AND_ABOVE: 1, BLOCK_MEDIUM_AND_ABOVE: 2, BLOCK_ONLY_HIGH: 3, BLOCK_NONE: 4, OFF: 5 };
        const FIN = { 1: 'STOP', 2: 'MAX_TOKENS', 3: 'SAFETY', 4: 'RECITATION', 5: 'OTHER' };
        const encVal = v => { if (v === null || v === undefined) return [0]; if (typeof v === 'number') return [null, v]; if (typeof v === 'string') return [null, null, v]; if (typeof v === 'boolean') return [null, null, null, v]; if (Array.isArray(v)) return [null, null, null, null, null, [v.map(encVal)]]; return [null, null, null, null, encStruct(v)]; };
        const encStruct = o => [Object.entries(o || {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encVal(v)])];
        const decVal = v => { if (!Array.isArray(v)) return null; if (v[1] != null) return v[1]; if (v[2] != null) return v[2]; if (v[3] != null) return !!v[3]; if (v[4] != null) return decStruct(v[4]); if (v[5] != null) return ((v[5] && v[5][0]) || []).map(decVal); return null; };
        const decStruct = st => { const o = {}; for (const kv of ((st && st[0]) || [])) if (Array.isArray(kv)) o[kv[0]] = decVal(kv[1]); return o; };
        const TYP = { string: 1, number: 2, integer: 3, boolean: 4, array: 5, object: 6 };
        const encSchema = sc => { if (!sc || typeof sc !== 'object') return null; const a = [];
          if (!sc.type && Array.isArray(sc.anyOf) && sc.anyOf.length) { const vs = sc.anyOf.filter(v => v && typeof v === 'object'); const nn = vs.filter(v => String(v.type || '').toLowerCase() !== 'null'); const pick = nn[0] || vs[0] || {}; const alt = nn.map(v => String(v.type || 'object').toLowerCase()); const desc = [sc.description || pick.description, alt.length > 1 ? 'Accepted types: ' + alt.join(' | ') : ''].filter(Boolean).join(' '); sc = { ...pick, description: desc || undefined, nullable: vs.length !== nn.length || sc.nullable || pick.nullable || undefined }; }
          a[0] = TYP[String(sc.type || 'object').toLowerCase()] || 6;
          if (sc.format) a[1] = sc.format; if (sc.description) a[2] = sc.description; if (sc.nullable != null) a[3] = !!sc.nullable;
          if (Array.isArray(sc.enum)) a[4] = sc.enum.map(String); if (sc.items) a[5] = encSchema(sc.items);
          if (sc.properties) a[6] = Object.entries(sc.properties).map(([k, v]) => [k, encSchema(v)]);
          if (Array.isArray(sc.required)) a[7] = sc.required;
          for (let i = 0; i < a.length; i++) if (a[i] === undefined) a[i] = null; return a; };
        const encTools = tools => { const decls = []; for (const t of (tools || [])) for (const d of (t.functionDeclarations || t.function_declarations || [])) { const x = [d.name, d.description || null]; const ps = d.parameters || d.parametersJsonSchema; if (ps) x[2] = encSchema(ps); decls.push(x); } return decls.length ? [[null, decls]] : null; };
        const toPart = p => {
          if (p == null) return null;
          const a = []; const d = p.inlineData || p.inline_data; const fc = p.functionCall || p.function_call; const fr = p.functionResponse || p.function_response;
          if (typeof p.text === 'string') a[1] = p.text;
          else if (d) a[2] = [d.mimeType || d.mime_type, d.data];
          else if (fc) a[10] = [fc.name, encStruct(fc.args || {}), fc.id || null];
          else if (fr) a[11] = [fr.name, encStruct(fr.response || {}), fr.id || null];
          else return null;
          if (p.thought) a[12] = true; const sg = p.thoughtSignature || p.thought_signature; if (sg) a[14] = sg; else if (fc && !p.text) a[14] = 'skip_thought_signature_validator';
          for (let i = 0; i < a.length; i++) if (a[i] === undefined) a[i] = null; return a;
        };
        const toContent = c => [(c.parts || []).map(toPart).filter(Boolean), c.role === 'model' ? 'model' : 'user'];
        const buildBody = (model, g) => {
          const gc = g.generationConfig || g.generation_config || {};
          const tc = gc.thinkingConfig || gc.thinking_config || {};
          const cfg = [];
          if (Array.isArray(gc.stopSequences)) cfg[1] = gc.stopSequences;
          cfg[3] = gc.maxOutputTokens || 65536;
          cfg[4] = gc.temperature != null ? gc.temperature : 1;
          cfg[5] = gc.topP != null ? gc.topP : 0.95;
          cfg[6] = gc.topK != null ? gc.topK : 64;
          if (gc.responseMimeType) cfg[7] = gc.responseMimeType;
          const rsc = gc.responseSchema || gc.response_schema;
          if (rsc) { cfg[7] = 'application/json'; cfg[8] = encSchema(rsc); }
          cfg[13] = 1;
          const th = [];
          th[0] = tc.includeThoughts === false ? 0 : 1;
          if (typeof tc.thinkingBudget === 'number') th[1] = tc.thinkingBudget;
          const lv = String(tc.thinkingLevel || '').toLowerCase();
          if (lv === 'low') th[3] = 1; else if (lv === 'high') th[3] = 2; else if (th[1] == null) th[3] = 2;
          cfg[16] = th;
          for (let i = 0; i < cfg.length; i++) if (cfg[i] === undefined) cfg[i] = null;
          for (let i = 0; i < th.length; i++) if (th[i] === undefined) th[i] = null;
          let safety = [7, 8, 9, 10].map(c => [null, null, c, 5]);
          if (Array.isArray(g.safetySettings) && g.safetySettings.length) safety = g.safetySettings.map(s => [null, null, CAT[s.category] || 7, THR[s.threshold] || 5]);
          const contents = (g.contents || []).map(toContent).filter(c => c[0].length);
          const si = g.systemInstruction || g.system_instruction;
          const sys = si && (si.parts || []).length ? [(si.parts || []).map(toPart).filter(Boolean), 'user'] : null;
          const body = ['models/' + model, contents, safety, cfg, null, sys, encTools(g.tools), null, null, null, 1, null, null, [[null, null, 'UTC']]];
          const ht = contents.flatMap(c => c[0]).map(p => p[1] != null ? p[1] : (p[2] ? p[2][1] : '')).join(' ');
          return { body, ht };
        };
        const convChunk = m => {
          if (!Array.isArray(m) || !Array.isArray(m[0])) return null;
          const out = { candidates: m[0].map((c, i) => {
            const parts = (Array.isArray(c && c[0] && c[0][0]) ? c[0][0] : []).map(p => {
              if (!p) return null; const o = {};
              if (typeof p[1] === 'string') o.text = p[1];
              if (Array.isArray(p[2])) o.inlineData = { mimeType: p[2][0], data: p[2][1] }; if (Array.isArray(p[10])) { o.functionCall = { name: p[10][0], args: decStruct(p[10][1]) }; if (p[10][2]) o.functionCall.id = p[10][2]; }
              if (p[12] === 1 || p[12] === true) o.thought = true;
              if (typeof p[14] === 'string' && p[14]) o.thoughtSignature = p[14];
              return Object.keys(o).length ? o : null;
            }).filter(Boolean);
            const cand = { content: { parts, role: 'model' }, index: i };
            if (c && c[1]) cand.finishReason = FIN[c[1]] || 'OTHER';
            return cand;
          }) };
          const u = m[2];
          if (Array.isArray(u)) out.usageMetadata = { promptTokenCount: u[0] || 0, candidatesTokenCount: u[1] || 0, totalTokenCount: u[2] || 0, thoughtsTokenCount: u[9] || 0 };
          if (typeof m[7] === 'string') out.responseId = m[7];
          return out;
        };
        const merge = chunks => {
          const parts = []; let fin, usage, rid;
          for (const ch of chunks) {
            const c = ch.candidates && ch.candidates[0];
            if (c) { if (c.finishReason) fin = c.finishReason;
              for (const p of c.content.parts) {
                const last = parts[parts.length - 1];
                if (p.text != null && last && last.text != null && !!last.thought === !!p.thought && !last.thoughtSignature) { last.text += p.text; if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature; }
                else if (p.text === '' && p.thoughtSignature && last) last.thoughtSignature = p.thoughtSignature;
                else parts.push({ ...p });
              } }
            if (ch.usageMetadata) usage = ch.usageMetadata; if (ch.responseId) rid = ch.responseId;
          }
          const r = { candidates: [{ content: { parts, role: 'model' }, finishReason: fin || 'STOP', index: 0 }] };
          if (usage) r.usageMetadata = usage; if (rid) r.responseId = rid; return r;
        };
        await this.context.route(/MakerSuiteService\/Proxy(Unary|Streamed)Call/, async route => {
          const req = route.request(); let a = null;
          try { a = JSON.parse(req.postData() || ''); } catch {}
          const mm = Array.isArray(a) && typeof a[0] === 'string' && a[0].match(/models\/([^:/?]+):(stream)?generateContent/i);
          if (!mm) return route.continue();
          // Legacy path: models Google no longer serves via MakerSuite GenerateContent still answer through the page's original Proxy call
          if ((process.env.GCB_LEGACY_MODELS || 'gemini-3.7-flash').split(',').map(x => x.trim()).filter(Boolean).some(x => mm[1] === x || mm[1].startsWith(x + '-'))) { log.info('[GCBridge] ' + mm[1] + ' legacy proxy path'); return route.continue(); }
          const streamed = /ProxyStreamedCall/.test(req.url());
          try {
            const g = JSON.parse(a[1] || '{}'); const gcbRid = typeof g.__aisRid === 'string' ? g.__aisRid : null; delete g.__aisRid;
            const { body, ht } = buildBody(mm[1], g);
            await gcbInstall();
            const gcbT0 = Date.now(); const gcbOp = 'g' + (++gcbSeq); if (gcbRid) { if (gcbCancelled.has(gcbRid)) { log.info('[GCBridge] ' + gcbRid + ' already cancelled; not calling upstream'); return route.abort().catch(() => {}); } gcbOps.set(gcbRid, gcbOp); }
            const code = 'window.__gcCall(' + JSON.stringify(body) + ',' + JSON.stringify(ht) + ',' + JSON.stringify(gcbKey) + ',' + JSON.stringify(Object.assign({}, gcbHx, { hardMs: GCB_HARD_MS, op: gcbOp })) + ')';
            let gcbBk; const raw = await Promise.race([pg.evaluate(c => window.wrappedJSObject.eval(c), code), new Promise(rs => { gcbBk = setTimeout(() => rs(JSON.stringify({ s: 504, t: JSON.stringify({ error: { code: 504, status: 'UPSTREAM_NO_RESPONSE', message: '浏览器页面超过 ' + Math.round((GCB_HARD_MS + 30000) / 60000) + ' 分钟没有返回，已主动中止，请重试。' } }) })), GCB_HARD_MS + 30000); })]).finally(() => clearTimeout(gcbBk)); // backstop only: Google cuts at ~600s
            if (gcbRid) gcbOps.delete(gcbRid); const r = JSON.parse(raw);
            if (r.s === 499) { log.info('[GCBridge] ' + mm[1] + ' upstream call ' + gcbOp + ' cancelled after ' + (Date.now() - gcbT0) + 'ms'); return route.abort().catch(() => {}); }
            if (r.s !== 200) { log.warn('[GCBridge] ' + mm[1] + ' status ' + r.s + ' tier=' + (r.tier || '-') + ' ms=' + (Date.now() - gcbT0) + ' ' + String(r.t).slice(0, 300)); return route.fulfill({ status: r.s, contentType: 'application/json+protobuf; charset=UTF-8', body: r.t }); }
            const arr0 = JSON.parse(r.t); const isChunk = x => Array.isArray(x) && Array.isArray(x[0]) && Array.isArray(x[0][0]) && Array.isArray(x[0][0][0]) && x[0][0][0][1] === 'model'; const arr = Array.isArray(arr0) && arr0.some(isChunk) ? arr0 : (Array.isArray(arr0) && Array.isArray(arr0[0]) ? arr0[0] : []);
            const chunks = arr.map(convChunk).filter(c => c && c.candidates && c.candidates.length);
            let out;
            if (streamed) { const tail = arr.length && !isChunk(arr[arr.length - 1]) ? arr[arr.length - 1] : null; out = '[[' + chunks.map(c => JSON.stringify([JSON.stringify(c)])).concat(tail ? [JSON.stringify(tail)] : []).join(',') + ']]'; }
            else out = JSON.stringify([JSON.stringify(merge(chunks))]);
            { const lf = (chunks[chunks.length - 1] && chunks[chunks.length - 1].candidates[0] && chunks[chunks.length - 1].candidates[0].finishReason) || '-'; if (lf !== 'STOP') { try { const sh = v => v == null ? null : typeof v === 'string' ? 's' + v.length : Array.isArray(v) ? 'a' + JSON.stringify(v).length : typeof v; const raw = arr.filter(isChunk).map(m => (m[0] || []).map(c => [(Array.isArray(c && c[0] && c[0][0]) ? c[0][0] : []).map(p2 => Array.isArray(p2) ? p2.map((v, i) => v == null ? null : i + ':' + sh(v)).filter(Boolean).join('|') : sh(p2)).join(' ; '), 'cand=' + (Array.isArray(c) ? c.map((v, i) => v == null ? null : i + ':' + sh(v)).filter(Boolean).join('|') : sh(c))].join(' / ')).join(' || ')); log.warn('[GCBridge] shape ' + mm[1] + ' finish=' + lf + ' top=' + arr0.length + ' chunks=' + raw.length + ' :: ' + raw.slice(-3).join(' ## ').slice(0, 1500)); } catch (e) { log.warn('[GCBridge] shape failed ' + e.message); } } }
            { const lc = chunks[chunks.length - 1]; if (chunks.length && !(lc.candidates[0] && lc.candidates[0].finishReason)) { let chars = 0; for (const c of chunks) for (const p of ((c.candidates[0] && c.candidates[0].content && c.candidates[0].content.parts) || [])) { if (typeof p.text === 'string' && !p.thought) chars += p.text.length; const fa = p.functionCall && p.functionCall.args; if (fa && typeof fa.answer === 'string') chars += fa.answer.length; } const sec = Math.round((Date.now() - gcbT0) / 1000); log.warn('[GCBridge] ' + mm[1] + ' upstream cut: no finishReason after ' + sec + 's chunks=' + chunks.length + ' bytes=' + String(r.t || '').length + ' chars=' + chars); return route.fulfill({ status: 504, contentType: 'application/json; charset=UTF-8', body: JSON.stringify({ error: { code: 504, status: 'UPSTREAM_CUT', message: 'Google 在约 ' + Math.max(1, Math.round(sec / 60)) + ' 分钟时断开连接，回答未写完（已生成约 ' + chars + ' 字被丢弃）。请重试，或让回答短一些。' } }) }); } }
            log.info('[GCBridge] ' + mm[1] + (streamed ? ' stream' : ' unary') + ' ok chunks=' + chunks.length + ' tier=' + (r.tier || '-') + ' ms=' + (Date.now() - gcbT0) + ' bytes=' + String(r.t || '').length + ' finish=' + ((chunks[chunks.length - 1] && chunks[chunks.length - 1].candidates[0] && chunks[chunks.length - 1].candidates[0].finishReason) || '-'));
            return route.fulfill({ status: 200, contentType: 'application/json+protobuf; charset=UTF-8', body: out });
          } catch (e) {
            log.warn('[GCBridge] error ' + e.message);
            return route.fulfill({ status: 500, contentType: 'application/json+protobuf; charset=UTF-8', body: JSON.stringify([13, 'GCBridge: ' + e.message]) });
          }
        });
      }
      if (process.env.WORKER_ACCOUNT || process.env.CLIENT_SCRIPT_OBSERVE === '1') {
        const stopObservation = require('./observe-client-scripts').observe(this.page, record => {
          this.logger.info('[ClientScriptObservation] ' + JSON.stringify(record));
        });
        this.page.once('close', () => { stopObservation().catch(() => {}); });
      }
      this.page.on("console", (msg) => {
        const msgText = msg.text();
        if (msgText.includes("Content-Security-Policy: (Report-Only policy)")) {
          return;
        }
        if (msgText.includes("[ProxyClient]")) {
          this.logger.info(
            `[Browser] ${msgText.replace("[ProxyClient] ", "")}`,
          );
        } else if (msg.type() === "error") {
          this.logger.error(`[Browser Page Error] ${msgText}`);
        }
      });

      // 增加 1：监听页面崩溃
      this.page.on("crash", () => {
        this.logger.error(
          `🚨 [Browser] 致命：页面进程崩溃 (Crash)！当前账号索引: ${authIndex}`,
        );
      });

      // 增加 2：监听意外的页面跳转或刷新
      this.page.on("framenavigated", (frame) => {
        // 只关注主框架的跳转
        if (frame === this.page.mainFrame()) {
          const newUrl = frame.url();
          if (
            newUrl !== "about:blank" &&
            !newUrl.includes(this.config.targetUrl)
          ) {
            this.logger.warn(
              `⚠️ [Browser] 页面发生了意外导航/刷新！新 URL: ${newUrl}`,
            );
          }
        }
      });

      // 增加 3：监听 WebSocket 级别的错误 (方便对照)
      this.page.on("websocket", (ws) => {
        ws.on("close", () =>
          this.logger.info(
            `[Browser Network] 页面内的 WebSocket 连接已关闭: ${ws.url()}`,
          ),
        );
        ws.on("error", (err) =>
          this.logger.error(
            `[Browser Network] 页面内的 WebSocket 发生错误: ${err}`,
          ),
        );
      });

      this.logger.info(`[Browser] 正在导航至目标网页...`);
      const targetUrl = this.config.targetUrl;
      await this.page.goto(targetUrl, {
        timeout: 180000,
        waitUntil: "domcontentloaded",
      });
      this.logger.info("[Browser] 页面加载完成。");

      await this.page.waitForTimeout(3000);

      const currentUrl = this.page.url();
      let pageTitle = "";
      try {
        pageTitle = await this.page.title();
      } catch (e) {
        this.logger.warn(`[Browser] 无法获取页面标题: ${e.message}`);
      }

      this.logger.info(`[Browser] [诊断] URL: ${currentUrl}`);
      this.logger.info(`[Browser] [诊断] Title: "${pageTitle}"`);

      // 1. 检查 Cookie 是否失效 (跳转回登录页)
      if (
        currentUrl.includes("accounts.google.com") ||
        currentUrl.includes("ServiceLogin") ||
        pageTitle.includes("Sign in") ||
        pageTitle.includes("登录")
      ) {
        throw new Error(
          "🚨 Cookie 已失效/过期！浏览器被重定向到了 Google 登录页面。请重新提取 storageState。",
        );
      }

      // 2. 检查 IP 地区限制 (Region Unsupported)
      // 通常标题是 "Google AI Studio is not available in your location"
      if (
        pageTitle.includes("Available regions") ||
        pageTitle.includes("not available")
      ) {
        throw new Error(
          "🚨 当前 IP 不支持访问 Google AI Studio。请更换节点后重启！",
        );
      }

      // 3. 检查 IP 风控 (403 Forbidden)
      if (pageTitle.includes("403") || pageTitle.includes("Forbidden")) {
        throw new Error(
          "🚨 403 Forbidden：当前 IP 信誉过低，被 Google 风控拒绝访问。",
        );
      }

      // 4. 检查白屏 (网络极差或加载失败)
      if (currentUrl === "about:blank") {
        throw new Error(
          "🚨 页面加载失败 (about:blank)，可能是网络连接超时或浏览器崩溃。",
        );
      }

      this.logger.info(
        `[Browser] 进入 20秒 检查流程 (目标: Cookie + Got it + 新手引导)...`,
      );

      const startTime = Date.now();
      const timeLimit = 20000;

      // 状态记录表
      const popupStatus = {
        cookie: false,
        gotIt: false,
        guide: false,
        continueBtn: false,
      };

      while (Date.now() - startTime < timeLimit) {
        // 如果3个都处理过了，立刻退出 ---
        if (popupStatus.cookie && popupStatus.gotIt && popupStatus.guide) {
          this.logger.info(
            `[Browser] ⚡ 完美！3个弹窗全部处理完毕，提前进入下一步。`,
          );
          break;
        }

        let clickedInThisLoop = false;

        // 1. 检查 Cookie "Agree" (如果还没点过)
        if (!popupStatus.cookie) {
          try {
            const agreeBtn = this.page.locator('button:text("Agree")').first();
            if (await agreeBtn.isVisible({ timeout: 100 })) {
              await agreeBtn.click({ force: true });
              this.logger.info(`[Browser] ✅ (1/3) 点击了 "Cookie Agree"`);
              popupStatus.cookie = true;
              clickedInThisLoop = true;
            }
          } catch (e) {}
        }

        // 2. 检查 "Got it" (如果还没点过)
        if (!popupStatus.gotIt) {
          try {
            const gotItBtn = this.page
              .locator('div.dialog button:text("Got it")')
              .first();
            if (await gotItBtn.isVisible({ timeout: 100 })) {
              await gotItBtn.click({ force: true });
              this.logger.info(`[Browser] ✅ (2/3) 点击了 "Got it" 弹窗`);
              popupStatus.gotIt = true;
              clickedInThisLoop = true;
            }
          } catch (e) {}
        }

        // 3. 检查 新手引导 "Close" (如果还没点过)
        if (!popupStatus.guide) {
          try {
            const closeBtn = this.page
              .locator('button[aria-label="Close"]')
              .first();
            if (await closeBtn.isVisible({ timeout: 100 })) {
              await closeBtn.click({ force: true });
              this.logger.info(`[Browser] ✅ (3/3) 点击了 "新手引导关闭" 按钮`);
              popupStatus.guide = true;
              clickedInThisLoop = true;
            }
          } catch (e) {}
        }

        if (!popupStatus.continueBtn) {
          try {
            const clicked = await this.page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll("button"));
              const target = btns.find(
                (b) =>
                  b.innerText && b.innerText.includes("Continue to the app"),
              );
              if (target) {
                target.click();
                return true;
              }
              return false;
            });

            if (clicked) {
              this.logger.info(
                `[Browser] ✅ (4/4) 原生JS成功点击 "Continue to the app"`,
              );
              popupStatus.continueBtn = true;
              clickedInThisLoop = true;
              this.logger.info(
                `[Browser] ⚡ 已确认进入应用，提前终止弹窗等待循环。`,
              );
              break;
            }
          } catch (e) {}
        }
        try {
          const isAppRunning = await this.page.evaluate(() => {
            // 只要页面里出现了 ProxyClient 的输出，就说明代码已经跑起来了
            return document.body.innerText.includes("[ProxyClient]");
          });
          if (isAppRunning) {
            this.logger.info(
              `[Browser] ⚡ 检测到内部环境已就绪，跳出弹窗等待。`,
            );
            break;
          }
        } catch (e) {}

        // 如果本轮点击了按钮，稍微等一下动画；如果没点，等待1秒避免死循环空转
        await this.page.waitForTimeout(clickedInThisLoop ? 500 : 1000);
      }

      this.logger.info(
        `[Browser] 弹窗检查结束 (耗时: ${Math.round(
          (Date.now() - startTime) / 1000,
        )}s)，结果: ` +
          `Cookie[${popupStatus.cookie ? "Ok" : "No"}], ` +
          `GotIt[${popupStatus.gotIt ? "Ok" : "No"}], ` +
          `Guide[${popupStatus.guide ? "Ok" : "No"}]`,
      );

      this.currentAuthIndex = authIndex;
      this._startBackgroundWakeup();
      this.logger.info("[Browser] (后台任务) 🛡️ 监控进程已启动...");
      await this.page.waitForTimeout(1000);
      this.logger.info(
        "[Browser] ⚡ 正在发送主动唤醒请求以触发 Launch 流程...",
      );
      try {
        await this.page.evaluate(async () => {
          try {
            await fetch(
              "https://generativelanguage.googleapis.com/v1beta/models?key=ActiveTrigger",
              {
                method: "GET",
                headers: { "Content-Type": "application/json" },
              },
            );
          } catch (e) {
            console.log(
              "[ProxyClient] 主动唤醒请求已发送 (预期内可能会失败，这很正常)",
            );
          }
        });
        this.logger.info("[Browser] ⚡ 主动唤醒请求已发送。");
      } catch (e) {
        this.logger.warn(
          `[Browser] 主动唤醒请求发送异常 (不影响主流程): ${e.message}`,
        );
      }

      this.logger.info("==================================================");
      this.logger.info(`✅ [Browser] 账号 ${authIndex} 的上下文初始化成功！`);
      this.logger.info("✅ [Browser] 浏览器客户端已准备就绪。");
      this.logger.info("==================================================");
    } catch (error) {
      this.logger.error(
        `❌ [Browser] 账户 ${authIndex} 的上下文初始化失败: ${error.message}`,
      );
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      this.logger.info("[Browser] 正在关闭整个浏览器实例...");
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 浏览器实例已关闭。");
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(
      `🔄 [Browser] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`,
    );
    await this.launchOrSwitchContext(newAuthIndex);
    this.logger.info(
      `✅ [Browser] 账号切换完成，当前账号: ${this.currentAuthIndex}`,
    );
  }

  async _startBackgroundWakeup() {
    if (this.isWakeupRunning && this.wakeupPage === this.page) {
      this.logger.warn(
        "[Browser] (后台任务) 保活监控已在运行，忽略重复启动请求。",
      );
      return;
    }
    this.isWakeupRunning = true;

    const currentPage = this.page;
    const wakeupToken = Symbol("wakeup");
    this.wakeupToken = wakeupToken;
    this.wakeupPage = currentPage;
    let launchAttempts = 0;
    this.noButtonCount = 0;
    await new Promise((r) => setTimeout(r, 1500));

    if (!currentPage || currentPage.isClosed() || this.page !== currentPage) {
      if (this.wakeupToken === wakeupToken) {
        this.isWakeupRunning = false;
        this.wakeupPage = null;
      }
      return;
    }

    this.logger.info("[Browser] (后台任务) 🛡️ 网页保活监控已启动");

    while (
      currentPage &&
      !currentPage.isClosed() &&
      this.page === currentPage && this.wakeupToken === wakeupToken
    ) {
      try {
        // --- [增强步骤 1] 强制唤醒页面 (解决不发请求不刷新的问题) ---
        await currentPage.bringToFront().catch(() => {});

        // 关键：在无头模式下，仅仅 bringToFront 可能不够，需要伪造鼠标移动来触发渲染帧
        // 随机在一个无害区域轻微晃动鼠标
        await currentPage.mouse.move(10, 10);
        await currentPage.mouse.move(20, 20);

        // --- [增强步骤 2] 智能查找 (查找文本并向上锁定可交互父级) ---
        const targetInfo = await currentPage.evaluate(() => {
          // 1. 直接CSS定位
          try {
            const preciseCandidates = Array.from(
              document.querySelectorAll(
                ".interaction-modal button, .interaction-modal [role=button]",
              ),
            );
            for (const el of preciseCandidates) {
              const text = (el.innerText || "").trim();
              if (/^(?:rocket_launch\s*)?Launch$/i.test(text)) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return {
                    found: true,
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    tagName: el.tagName,
                    text: text.substring(0, 15),
                    strategy: "precise_css", // 标记：这是通过精准CSS找到的
                  };
                }
              }
            }
          } catch (e) {}
          return { found: false };
        });

        // --- [增强步骤 3] 执行操作 ---
        if (this.wakeupToken !== wakeupToken || currentPage.isClosed()) break;
        if (targetInfo.found && launchAttempts >= 3) {
          this.logger.warn("[Browser] Launch 已尝试3次，停止自动点击，请人工检查页面");
          break;
        }
        if (targetInfo.found) {
          launchAttempts++;

          this.noButtonCount = 0;
          this.logger.info(
            `[Browser] 🎯 锁定目标 [${targetInfo.tagName}] (策略: ${
              targetInfo.strategy === "precise_css" ? "精准定位" : "模糊扫描"
            })...`,
          );

          // === 策略 A: 物理点击 (模拟真实鼠标) ===
          // 1. 移动过去
          await currentPage.mouse.move(targetInfo.x, targetInfo.y, {
            steps: 5,
          });
          // 2. 悬停 (给 hover 样式一点反应时间)
          await new Promise((r) => setTimeout(r, 300));
          // 3. 按下
          await currentPage.mouse.down();
          // 4. 长按 (某些按钮防误触，需要按住一小会儿)
          await new Promise((r) => setTimeout(r, 400));
          // 5. 抬起
          await currentPage.mouse.up();

          this.logger.info(`[Browser] 🖱️ 物理点击已执行，验证结果...`);
          // 等待 1.5 秒看效果
          await new Promise((r) => setTimeout(r, 1500));

          // === 策略 B: JS 补刀 (如果物理点击失败) ===
          // 再次检查按钮是否还在原地
          const isStillThere = await currentPage.evaluate(() => {
            // 逻辑同上，简单检查
            const allText = document.body.innerText;
            // 简单粗暴检查页面可视区是否还有那个特定位置的文字
            // 这里为了性能做简化：再次扫描元素
            const els = Array.from(
              document.querySelectorAll('button, span, div[role="button"]'),
            );
            return els.some((el) => {
              const r = el.getBoundingClientRect();
              return (
                /Launch|rocket_launch/i.test(el.innerText) &&
                r.top > 400 &&
                r.top < 800 &&
                r.height > 0
              );
            });
          });

          if (isStillThere) {
            this.logger.warn(
              `[Browser] ⚠️ 物理点击似乎无效（按钮仍在），等待后仅重试明确的 Launch 按钮...`,
            );

            await new Promise((r) => setTimeout(r, 2000));
          } else {
            this.logger.info(`[Browser] ✅ 物理点击成功，按钮已消失。`);
            await new Promise((r) => setTimeout(r, 60000));
            if (this.wakeupToken === wakeupToken) this.noButtonCount = 21;
          }
        } else {
          this.noButtonCount++;
          // 5. [关键] 智能休眠逻辑 (支持被唤醒)
          if (this.noButtonCount > 20) {
            for (let i = 0; i < 30; i++) {
              if (this.noButtonCount === 0 || this.wakeupToken !== wakeupToken || currentPage.isClosed()) {
                break;
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
          } else {
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (this.wakeupToken === wakeupToken) {
        this.isWakeupRunning = false;
        this.wakeupPage = null;
      }
  }
}

// ===================================================================================
// PROXY SERVER MODULE
// ===================================================================================

class LoggingService {
  constructor(serviceName = "ProxyServer") {
    this.serviceName = serviceName;
    this.logBuffer = []; // 用于在内存中保存日志
    this.maxBufferSize = 100; // 最多保存100条
  }

  _formatMessage(level, message) {
    message = String(message);
    for (const secret of [process.env.API_KEYS, process.env.SOCKS_UPSTREAM_URL, process.env.PROXY_URL]) {
      if (secret) message = message.split(secret).join("[REDACTED]");
    }
    message = message.replace(/(https?|socks5h?):\/\/[^\s/@]+:[^\s/@]+@/gi, "$1://[REDACTED]@")
      .replace(/([?&](?:key|token|api_key)=)[^\s&]+/gi, "$1[REDACTED]")
      .replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[EMAIL]");
    const timestamp = new Date().toISOString();
    const formatted = `[${level}] ${timestamp} [${this.serviceName}] - ${message}`;

    // 将格式化后的日志存入缓冲区
    this.logBuffer.push(formatted);
    // 如果缓冲区超过最大长度，则从头部删除旧的日志
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    return formatted;
  }

  info(message) {
    console.log(this._formatMessage("INFO", message));
  }
  error(message) {
    console.error(this._formatMessage("ERROR", message));
  }
  warn(message) {
    console.warn(this._formatMessage("WARN", message));
  }
  debug(message) {
    console.debug(this._formatMessage("DEBUG", message));
  }
}

class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 0) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }
  enqueue(message) {
    if (this.closed) return;
    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      clearTimeout(resolver.timeoutId);
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error("Queue is closed");
    }
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }
      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);
      const timeoutId = timeoutMs > 0 && setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error("Queue timeout"));
        }
      }, timeoutMs);
      resolver.timeoutId = timeoutId;
    });
  }
  close() {
    this.closed = true;
    this.waitingResolvers.forEach((resolver) => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error("Queue closed"));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
    this.reconnectGraceTimer = null; // 新增：用于缓冲期计时的定时器
  }
  addConnection(websocket, clientInfo) {
    // --- 核心修改：当新连接建立时，清除可能存在的“断开”警报 ---
    if (this.reconnectGraceTimer) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
      this.logger.info("[Server] 在缓冲期内检测到新连接，已取消断开处理。");
    }
    // --- 修改结束 ---

    this.connections.add(websocket);
    websocket.on("message", (data) =>
      this._handleIncomingMessage(data.toString()),
    );
    websocket.on("close", () => this._removeConnection(websocket));
    websocket.on("error", (error) =>
      this.logger.error(`[Server] 内部WebSocket连接错误: ${error.message}`),
    );
    this.emit("connectionAdded", websocket);
  }

  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.warn("[Server] 内部WebSocket客户端连接断开。");

    // --- 核心修改：不立即清理队列，而是启动一个缓冲期 ---
    this.logger.info("[Server] 启动5秒重连缓冲期...");
    this.reconnectGraceTimer = setTimeout(() => {
      // 5秒后，如果没有新连接进来（即reconnectGraceTimer未被清除），则确认是真实断开
      this.logger.error(
        "[Server] 缓冲期结束，未检测到重连。确认连接丢失，正在清理所有待处理请求...",
      );
      this.messageQueues.forEach((queue) => queue.close());
      this.messageQueues.clear();
      this.emit("connectionLost"); // 使用一个新的事件名，表示确认丢失
    }, 10000); // 5秒的缓冲时间

    this.emit("connectionRemoved", websocket);
  }

  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;
      if (parsedMessage.event_type === `operation_done`) { if (typeof requestId === `string`) this.emit(`operationDone`, requestId); return; }
      if (!requestId) {
        this.logger.warn("[Server] 收到无效消息：缺少request_id");
        return;
      }
      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      } else {
        // 在缓冲期内，旧的请求队列可能仍然存在，但连接已经改变，这可能会导致找不到队列。
        // 暂时只记录警告，避免因竞速条件而报错。
        this.logger.warn(`[Server] 收到未知或已过时请求ID的消息: ${requestId}`);
      }
    } catch (error) {
      this.logger.error("[Server] 解析内部WebSocket消息失败");
    }
  }

  // 其他方法 (_routeMessage, hasActiveConnections, getFirstConnection,等) 保持不变...
  _routeMessage(message, queue) {
    const { event_type } = message;
    switch (event_type) {
      case "response_headers":
      case "chunk":
      case "error":
        queue.enqueue(message);
        break;
      case "stream_close":
        queue.enqueue({ type: "STREAM_END" });
        break;
      default:
        this.logger.warn(`[Server] 未知的内部事件类型: ${event_type}`);
    }
  }
  hasActiveConnections() {
    return this.connections.size > 0;
  }
  getFirstConnection() {
    return this.connections.values().next().value;
  }
  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }
  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }
}

class RequestHandler {
  constructor(
    serverSystem,
    connectionRegistry,
    logger,
    browserManager,
    config,
    authSource,
  ) {
    this.serverSystem = serverSystem;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.browserManager = browserManager;
    this.config = config;
    this.authSource = authSource;
    this.maxRetries = this.config.maxRetries;
    this.retryDelay = this.config.retryDelay;
    this.failureCount = 0;
    this.usageCount = 0;
    this.isAuthSwitching = false;
    this.needsSwitchingAfterRequest = false;
    this.isSystemBusy = false;
  }

  get currentAuthIndex() {
    return this.browserManager.currentAuthIndex;
  }

  _getMaxAuthIndex() {
    return this.authSource.getMaxIndex();
  }

  _getNextAuthIndex() {
    const available = this.authSource.availableIndices; // 使用新的 availableIndices
    if (available.length === 0) return null;

    const currentIndexInArray = available.indexOf(this.currentAuthIndex);

    if (currentIndexInArray === -1) {
      this.logger.warn(
        `[Auth] 当前索引 ${this.currentAuthIndex} 不在可用列表中，将切换到第一个可用索引。`,
      );
      return available[0];
    }

    const nextIndexInArray = (currentIndexInArray + 1) % available.length;
    return available[nextIndexInArray];
  }

  async _switchToNextAuth() {
    const available = this.authSource.availableIndices;

    if (available.length === 0) {
      throw new Error("没有可用的认证源，无法切换。");
    }

    if (this.isAuthSwitching) {
      this.logger.info("🔄 [Auth] 正在切换/重启账号，跳过重复操作");
      return { success: false, reason: "Switch already in progress." };
    }

    // --- 加锁！ ---
    this.isSystemBusy = true;
    this.isAuthSwitching = true;

    try {
      // 单账号模式 - 执行原地重启 (Refresh)
      if (available.length === 1) {
        const singleIndex = available[0];
        this.logger.info("==================================================");
        this.logger.info(
          `🔄 [Auth] 单账号模式：达到轮换阈值，正在执行原地重启...`,
        );
        this.logger.info(`   • 目标账号: #${singleIndex}`);
        this.logger.info("==================================================");

        try {
          // 强制重新加载当前账号的 Context
          await this.browserManager.launchOrSwitchContext(singleIndex);

          // 关键：重置计数器
          this.failureCount = 0;
          this.usageCount = 0;

          this.logger.info(
            `✅ [Auth] 单账号 #${singleIndex} 重启/刷新成功，使用计数已清零。`,
          );
          return { success: true, newIndex: singleIndex };
        } catch (error) {
          this.logger.error(`❌ [Auth] 单账号重启失败: ${error.message}`);
          throw error;
        }
      }

      // 多账号模式 - 执行轮换 (Rotate)

      const previousAuthIndex = this.currentAuthIndex;
      const nextAuthIndex = this._getNextAuthIndex();

      this.logger.info("==================================================");
      this.logger.info(`🔄 [Auth] 多账号模式：开始账号切换流程`);
      this.logger.info(`   • 当前账号: #${previousAuthIndex}`);
      this.logger.info(`   • 目标账号: #${nextAuthIndex}`);
      this.logger.info("==================================================");

      try {
        await this.browserManager.switchAccount(nextAuthIndex);
        this.failureCount = 0;
        this.usageCount = 0;
        this.logger.info(
          `✅ [Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`,
        );
        return { success: true, newIndex: this.currentAuthIndex };
      } catch (error) {
        this.logger.error(
          `❌ [Auth] 切换到账号 #${nextAuthIndex} 失败: ${error.message}`,
        );
        this.logger.warn(
          `🚨 [Auth] 切换失败，正在尝试回退到上一个可用账号 #${previousAuthIndex}...`,
        );
        try {
          await this.browserManager.launchOrSwitchContext(previousAuthIndex);
          this.logger.info(`✅ [Auth] 成功回退到账号 #${previousAuthIndex}！`);
          this.failureCount = 0;
          this.usageCount = 0;
          this.logger.info("[Auth] 失败和使用计数已在回退成功后重置为0。");
          return {
            success: false,
            fallback: true,
            newIndex: this.currentAuthIndex,
          };
        } catch (fallbackError) {
          this.logger.error(
            `FATAL: ❌❌❌ [Auth] 紧急回退到账号 #${previousAuthIndex} 也失败了！服务可能中断。`,
          );
          throw fallbackError;
        }
      }
    } finally {
      this.isAuthSwitching = false;
      this.isSystemBusy = false;
    }
  }

  async _switchToSpecificAuth(targetIndex) {
    if (this.isAuthSwitching) {
      this.logger.info("🔄 [Auth] 正在切换账号，跳过重复操作");
      return { success: false, reason: "Switch already in progress." };
    }
    if (!this.authSource.availableIndices.includes(targetIndex)) {
      return {
        success: false,
        reason: `切换失败：账号 #${targetIndex} 无效或不存在。`,
      };
    }

    this.isSystemBusy = true;
    this.isAuthSwitching = true;
    try {
      this.logger.info(`🔄 [Auth] 开始切换到指定账号 #${targetIndex}...`);
      await this.browserManager.switchAccount(targetIndex);
      this.failureCount = 0;
      this.usageCount = 0;
      this.logger.info(
        `✅ [Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`,
      );
      return { success: true, newIndex: this.currentAuthIndex };
    } catch (error) {
      this.logger.error(
        `❌ [Auth] 切换到指定账号 #${targetIndex} 失败: ${error.message}`,
      );
      // 对于指定切换，失败了就直接报错，不进行回退，让用户知道这个账号有问题
      throw error;
    } finally {
      this.isAuthSwitching = false;
      this.isSystemBusy = false;
    }
  }

  async _handleRequestFailureAndSwitch(errorDetails, res) {
    // 失败计数逻辑
    if (this.config.failureThreshold > 0) {
      this.failureCount++;
      this.logger.warn(
        `⚠️ [Auth] 请求失败 - 失败计数: ${this.failureCount}/${this.config.failureThreshold} (当前账号索引: ${this.currentAuthIndex})`,
      );
    }

    const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(
      errorDetails.status,
    );
    const isThresholdReached =
      this.config.failureThreshold > 0 &&
      this.failureCount >= this.config.failureThreshold;

    // 只要满足任一切换条件
    if (isImmediateSwitch || isThresholdReached) {
      if (isImmediateSwitch) {
        this.logger.warn(
          `🔴 [Auth] 收到状态码 ${errorDetails.status}，触发立即切换账号...`,
        );
      } else {
        this.logger.warn(
          `🔴 [Auth] 达到失败阈值 (${this.failureCount}/${this.config.failureThreshold})！准备切换账号...`,
        );
      }

      // [核心修改] 等待切换操作完成，并根据其结果发送不同消息
      try {
        await this._switchToNextAuth();
        // 如果上面这行代码没有抛出错误，说明切换/回退成功了
        const successMessage = `🔄 目标账户无效，已自动回退至账号 #${this.currentAuthIndex}。`;
        this.logger.info(`[Auth] ${successMessage}`);
        if (res) this._sendErrorChunkToClient(res, successMessage);
      } catch (error) {
        let userMessage = `❌ 致命错误：发生未知切换错误: ${error.message}`;

        if (error.message.includes("Only one account is available")) {
          // 场景：单账号无法切换
          userMessage = "❌ 切换失败：只有一个可用账号。";
          this.logger.info("[Auth] 只有一个可用账号，失败计数已重置。");
          this.failureCount = 0;
        } else if (error.message.includes("回退失败原因")) {
          // 场景：切换到坏账号后，连回退都失败了
          userMessage = `❌ 致命错误：自动切换和紧急回退均失败，服务可能已中断，请检查日志！`;
        } else if (error.message.includes("切换到账号")) {
          // 场景：切换到坏账号后，成功回退（这是一个伪“成功”，本质是上一个操作失败了）
          userMessage = `⚠️ 自动切换失败：已自动回退到账号 #${this.currentAuthIndex}，请检查目标账号是否存在问题。`;
        }

        this.logger.error(`[Auth] 后台账号切换任务最终失败: ${error.message}`);
        if (res) this._sendErrorChunkToClient(res, userMessage);
      }

      return;
    }
  }

  async processRequest(req, res) {
    if (this.browserManager) {
      this.browserManager.notifyUserActivity();
    }
    const requestId = this._generateRequestId();
    res.on("close", () => {
      if (!res.writableEnded) {
        this.logger.warn(
          `[Request] 客户端已提前关闭请求 #${requestId} 的连接。`,
        );
        this._cancelBrowserRequest(requestId);
      }
    });

    if (!this.connectionRegistry.hasActiveConnections()) {
      if (this.isSystemBusy) {
        this.logger.warn(
          "[System] 检测到连接断开，但系统正在进行切换/恢复，拒绝新请求。",
        );
        return this._sendErrorResponse(
          res,
          503,
          "服务器正在进行内部维护（账号切换/恢复），请稍后重试。",
        );
      }

      this.logger.error(
        "❌ [System] 检测到浏览器WebSocket连接已断开！可能是进程崩溃。正在尝试恢复...",
      );
      // --- 开始恢复前，加锁！ ---
      this.isSystemBusy = true;
      try {
        await this.browserManager.launchOrSwitchContext(this.currentAuthIndex);
        this.logger.info(`[System] 浏览器页面已加载，等待 WebSocket 握手...`);
        let wsReady = false;
        for (let i = 0; i < 20; i++) {
          if (this.connectionRegistry.hasActiveConnections()) {
            wsReady = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        if (!wsReady) {
          throw new Error(
            "浏览器已启动，但前端 WebSocket 始终未能连接到代理端。",
          );
        }
        this.logger.info(`✅ [System] 浏览器与 WebSocket 已完全恢复就绪！`);
      } catch (error) {
        this.logger.error(`❌ [System] 浏览器自动恢复失败: ${error.message}`);
        return this._sendErrorResponse(
          res,
          503,
          "服务暂时不可用：后端浏览器实例崩溃且无法自动恢复，请联系管理员。",
        );
      } finally {
        // 只有确信 WS 连上了，或者彻底失败了，才解锁
        this.isSystemBusy = false;
      }
    }

    if (this.isSystemBusy) {
      this.logger.warn(
        "[System] 收到新请求，但系统正在进行切换/恢复，拒绝新请求。",
      );
      return this._sendErrorResponse(
        res,
        503,
        "服务器正在进行内部维护（账号切换/恢复），请稍后重试。",
      );
    }

    const isGenerativeRequest =
      req.method === "POST" &&
      (req.path.includes("generateContent") ||
        req.path.includes("streamGenerateContent"));
    if (this.config.switchOnUses > 0 && isGenerativeRequest) {
      this.usageCount++;
      this.logger.info(
        `[Request] 生成请求 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`,
      );
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    const proxyRequest = this._buildProxyRequest(req, requestId);
    proxyRequest.is_generative = isGenerativeRequest;
    // 根据判断结果，为浏览器脚本准备标志位
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
    const wantsStreamByHeader =
      req.headers.accept && req.headers.accept.includes("text/event-stream");
    const wantsStreamByPath = req.path.includes(":streamGenerateContent");
    const wantsStream = wantsStreamByHeader || wantsStreamByPath;

    try {
      if (wantsStream) {
        // --- 客户端想要流式响应 ---
        this.logger.info(
          `[Request] 客户端启用流式传输 (${this.serverSystem.streamingMode})，进入流式处理模式...`,
        );
        if (this.serverSystem.streamingMode === "fake") {
          await this._handlePseudoStreamResponse(
            proxyRequest,
            messageQueue,
            req,
            res,
          );
        } else {
          await this._handleRealStreamResponse(proxyRequest, messageQueue, res);
        }
      } else {
        // --- 客户端想要非流式响应 ---
        // 明确告知浏览器脚本本次应按“一次性JSON”（即fake模式）来处理
        proxyRequest.streaming_mode = "fake";
        await this._handleNonStreamResponse(proxyRequest, messageQueue, res);
      }
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
      if (this.needsSwitchingAfterRequest) {
        this.logger.info(
          `[Auth] 轮换计数已达到切换阈值 (${this.usageCount}/${this.config.switchOnUses})，将在后台自动切换账号...`,
        );
        await this._switchToNextAuth().catch((err) => {
          this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
        });
        this.needsSwitchingAfterRequest = false;
      }
    }
  }

  async processOpenAIRequest(req, res) {
    if (this.browserManager) {
      this.browserManager.notifyUserActivity();
    }
    const requestId = this._generateRequestId();
    const atRequestStartedAt = Date.now();
    const isOpenAIStream = req.body.stream === true;
    let proxyRequestModel = null;
    const model = req.body.model || "gemini-2.5-flash";
    const systemStreamMode = this.serverSystem.streamingMode;
    let useRealStream = isOpenAIStream && systemStreamMode === "real";
    if (AT.atIsEnabled(model)) useRealStream = false;

    if (this.config.switchOnUses > 0) {
      this.usageCount++;
      this.logger.info(
        `[Request] OpenAI生成请求 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`,
      );
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    let googleBody;
    try {
      googleBody = this._translateOpenAIToGoogle(req.body, model);
      AT.fixTrailingModelTurn(googleBody, this.logger);
    const atEnabled = AT.atIsEnabled(model);
    if (atEnabled) {
      const atReal = AT.atRealModel(model);
      proxyRequestModel = atReal;
      AT.atInjectTools(googleBody);
      this.logger.info("[AT] anti-truncation enabled for " + atReal + ", tools injected");
    }
    } catch (error) {
      this.logger.error(`[Adapter] OpenAI请求翻译失败: ${error.message}`);
      return this._sendErrorResponse(
        res,
        400,
        "Invalid OpenAI request format.",
      );
    }

    const googleEndpoint = useRealStream
      ? "streamGenerateContent"
      : "generateContent";
    const proxyRequest = {
      path: `/v1beta/models/${proxyRequestModel || model}:${googleEndpoint}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      query_params: useRealStream ? { alt: "sse" } : {},
      body: JSON.stringify(googleBody),
      request_id: requestId,
      is_generative: true,
      streaming_mode: useRealStream ? "real" : "fake",
    };

    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);

    try {
      this._forwardRequest(proxyRequest);
      const initialMessage = await messageQueue.dequeue();

      if (initialMessage.event_type === "error") {
        this.logger.error(
          `[Adapter] 收到来自浏览器的错误，将触发切换逻辑。状态码: ${initialMessage.status}, 消息: ${initialMessage.message}`,
        );
        await this._handleRequestFailureAndSwitch(initialMessage, res);
        if (isOpenAIStream && !res.headersSent) {
          // Nothing streamed yet: report the real upstream status so the failure is not
          // recorded as a successful request without usage.
          this._sendErrorResponse(res, initialMessage.status || 502, initialMessage.message);
        } else if (isOpenAIStream) {
          if (!res.writableEnded) {
            res.write("data: [DONE]\n\n");
            res.end();
          }
        } else {
          this._sendErrorResponse(
            res,
            initialMessage.status || 500,
            initialMessage.message,
          );
        }
        return;
      }

      if (this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] OpenAI接口请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`,
        );
        this.failureCount = 0;
      }

      if (isOpenAIStream) {
        res.status(200).set({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        if (useRealStream) {
          this.logger.info(`[Adapter] OpenAI 流式响应 (Real Mode) 已启动...`);
          let lastGoogleChunk = "";
          const streamState = { inThought: false };

          while (true) {
            const message = await messageQueue.dequeue(); // 5分钟超时
            if (message.type === "STREAM_END") {
              if (streamState.inThought) {
                const closeThoughtPayload = {
                  id: `chatcmpl-${requestId}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: "\n</think>\n" },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(closeThoughtPayload)}\n\n`);
              }
              res.write("data: [DONE]\n\n");
              break;
            }
            if (message.data) {
              // [修改] 将 streamState 传递给翻译函数
              const translatedChunk = this._translateGoogleToOpenAIStream(
                message.data,
                model,
                streamState,
              );
              if (translatedChunk) {
                res.write(translatedChunk);
              }
              lastGoogleChunk = message.data;
            }
          }
        } else {
          this.logger.info(`[Adapter] OpenAI 流式响应 (Fake Mode) 已启动...`);

          let fullBody = "";
          while (true) {
            const message = await messageQueue.dequeue();
            if (message.type === "STREAM_END") break;
            if (message.data) fullBody += message.data;
          }

          if (AT.atIsEnabled(model)) { const result = await this._atContinueUntilAnswer(JSON.parse(fullBody), googleBody, res, model, requestId, atRequestStartedAt); if (!result || typeof result.answer !== /string/.source) throw Object.assign(Error(/AT_incomplete_stream_answer/.source),{status:502}); fullBody = JSON.stringify({candidates:[{content:{role:/model/.source,parts:[{text:result.answer}]},finishReason:result.finishReason}],...(result.usageMetadata?{usageMetadata:result.usageMetadata}:{})}); }
          const translatedChunk = this._translateGoogleToOpenAIStream(
            fullBody,
            model,
          );
          if (translatedChunk) {
            res.write(translatedChunk);
          }
          res.write("data: [DONE]\n\n");
          this.logger.info(
            `[Adapter] Fake模式：已一次性发送完整内容并结束流。`,
          );
        }
      } else {
        let fullBody = "";
        while (true) {
          const message = await messageQueue.dequeue();
          if (message.type === "STREAM_END") {
            break;
          }
          if (message.event_type === "chunk" && message.data) {
            fullBody += message.data;
          }
        }

        let googleResponse = JSON.parse(fullBody);
        const atEnabledLocal = AT.atIsEnabled(model);
        let atAnswer = null;
        if (atEnabledLocal) {
          const atResult = await this._atContinueUntilAnswer(
            googleResponse, googleBody, res, model, requestId, atRequestStartedAt,
          );
          if (atResult && typeof atResult.answer === "string") {
            atAnswer = atResult.answer;
            googleResponse = {candidates:[{content:{role:/model/.source,parts:[{text:atAnswer}]},finishReason:atResult.finishReason}],...(atResult.usageMetadata?{usageMetadata:atResult.usageMetadata}:{})};
          }
        }
        if (atEnabledLocal && atAnswer === null) throw Object.assign(Error(/AT_incomplete_answer/.source),{status:502});
        const candidate = googleResponse.candidates?.[0];

        let responseContent = "";
        if (
          candidate &&
          candidate.content &&
          Array.isArray(candidate.content.parts)
        ) {
          const imagePart = candidate.content.parts.find((p) => p.inlineData);
          if (imagePart) {
            const image = imagePart.inlineData;
            responseContent = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
            this.logger.info(
              "[Adapter] 从 parts.inlineData 中成功解析到图片。",
            );
          } else {
            let mainContent = "";
            let reasoningContent = "";
            const oaiToolCalls = [];
            candidate.content.parts.forEach((p) => {
              if (p.functionCall) {
                oaiToolCalls.push({ id: p.functionCall.id || ("call_" + Math.random().toString(36).slice(2, 12)), type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } });
              } else if (p.thought) {
                reasoningContent += p.text || "";
              } else {
                mainContent += p.text || "";
              }
            });

            responseContent = mainContent;
            if (atAnswer !== null && atEnabledLocal) {
              responseContent = atAnswer;
            }
            var messageObj = {
              role: "assistant",
              content: responseContent,
            };
            if (reasoningContent) {
              messageObj.reasoning_content = reasoningContent;
            }
            if (oaiToolCalls.length) { messageObj.tool_calls = oaiToolCalls; if (!messageObj.content) messageObj.content = null; }
          }
        }

        const openaiResponse = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model,
          ...responseUsageFields(googleResponse),
          choices: [
            {
              index: 0,
              // 使用上面构建的 messageObj
              message: messageObj || { role: "assistant", content: "" },
              finish_reason: (messageObj && messageObj.tool_calls) ? "tool_calls" : candidate?.finishReason,
            },
          ],
        };

        const finishReason = candidate?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Request] OpenAI非流式响应结束，原因: ${finishReason}，请求ID: ${requestId}`,
        );

        res.status(200).json(openaiResponse);
      }
    } catch (error) {
      if (AT.atIsEnabled(model)) { if (!res.destroyed) { if (error.atBlock || error.atFinish) { const payload = error.atBlock ? AT.atBlockPayload(error.atBlock, error.status || 502) : AT.atFinishPayload(error.atFinish, error.status || 502); if (res.headersSent) { if (!res.writableEnded) res.write('data: ' + JSON.stringify(payload) + '\n\n'); } else res.status(error.status || 502).type('application/json').send(JSON.stringify(payload)); } else if (res.headersSent) this._sendErrorChunkToClient(res,error.message); else this._sendErrorResponse(res,error.status || 502,error.message); } return; }
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
      if (this.needsSwitchingAfterRequest) {
        this.logger.info(
          `[Auth] OpenAI轮换计数已达到切换阈值 (${this.usageCount}/${this.config.switchOnUses})，将在后台自动切换账号...`,
        );
        await this._switchToNextAuth().catch((err) => {
          this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
        });
        this.needsSwitchingAfterRequest = false;
      }
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  // --- 新增一个辅助方法，用于发送取消指令 ---
  _cancelBrowserRequest(requestId) {
    try { const bm = this.browserManager || (this.serverSystem && this.serverSystem.browserManager); if (bm && typeof bm.gcbCancel === 'function') bm.gcbCancel(requestId); } catch {}
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      this.logger.info(
        `[Request] 正在向浏览器发送取消请求 #${requestId} 的指令...`,
      );
      connection.send(
        JSON.stringify({
          event_type: "cancel_request",
          request_id: requestId,
        }),
      );
    } else {
      this.logger.warn(
        `[Request] 无法发送取消指令：没有可用的浏览器WebSocket连接。`,
      );
    }
  }

  _generateRequestId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
  _buildProxyRequest(req, requestId) {
    let bodyObj = req.body;
    if (
      this.serverSystem.forceThinking &&
      req.method === "POST" &&
      bodyObj &&
      bodyObj.contents
    ) {
      if (!bodyObj.generationConfig) {
        bodyObj.generationConfig = {};
      }

      if (!bodyObj.generationConfig.thinkingConfig) {
        this.logger.info(
          `[Proxy] ⚠️ (Google原生格式) 强制推理已启用，且客户端未提供配置，正在注入 thinkingConfig...`,
        );
        bodyObj.generationConfig.thinkingConfig = { includeThoughts: true };
      } else {
        this.logger.info(
          `[Proxy] ✅ (Google原生格式) 检测到客户端自带推理配置，跳过强制注入。`,
        );
      }
    }

    if (req.method === "POST" && bodyObj && Array.isArray(bodyObj.contents) && /:(generateContent|streamGenerateContent)$/.test(req.path || "")) {
      AT.fixTrailingModelTurn(bodyObj, this.logger);
    }
    let requestBody = "";
    if (bodyObj) {
      requestBody = JSON.stringify(bodyObj);
    }

    return {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body: requestBody,
      request_id: requestId,
      streaming_mode: this.serverSystem.streamingMode,
    };
  }
  // maxOutputTokens is always the model's own upstream cap; any client value is ignored.
  _modelOutputLimit(model) {
    try {
      const cat = this.serverSystem && this.serverSystem.modelCatalog;
      const snap = cat && typeof cat.status === 'function' ? cat.status().snapshot : null;
      const m = snap && Array.isArray(snap.models) ? snap.models.find(x => x.id === model) : null;
      const OVERRIDE = { 'gemini-4-argon': 65536 }; // Google lists 32768 but accepts 65536
      if (OVERRIDE[model]) return OVERRIDE[model];
      return m && Number.isSafeInteger(m.outputTokenLimit) && m.outputTokenLimit > 0 ? m.outputTokenLimit : null;
    } catch { return null; }
  }
  _pinMaxOutputTokens(proxyRequest) {
    const mm = proxyRequest && typeof proxyRequest.path === 'string' && proxyRequest.path.match(/^\/v1beta\/models\/([^:/?]+):(?:generateContent|streamGenerateContent)$/);
    if (!mm || typeof proxyRequest.body !== 'string' || !proxyRequest.body) return;
    let body; try { body = JSON.parse(proxyRequest.body); } catch { return; }
    if (!body || typeof body !== 'object') return;
    const gc = body.generationConfig && typeof body.generationConfig === 'object' ? body.generationConfig : (body.generation_config && typeof body.generation_config === 'object' ? body.generation_config : null);
    const before = gc ? (gc.maxOutputTokens ?? gc.max_output_tokens) : undefined;
    const limit = this._modelOutputLimit(mm[1]);
    const cfg = gc || (body.generationConfig = {});
    delete cfg.max_output_tokens;
    if (limit) cfg.maxOutputTokens = limit; else delete cfg.maxOutputTokens;
    if (before !== cfg.maxOutputTokens) this.logger.info('[MaxTokens] ' + mm[1] + ' client=' + (before ?? '-') + ' -> ' + (limit ?? 'default'));
    // internal: lets a client cancel abort the upstream call; stripped in-page before Google. Legacy models go through the page's own Proxy call (already aborted by cancel), so they are left untouched.
    const gcbLegacy = (process.env.GCB_LEGACY_MODELS || 'gemini-3.7-flash').split(',').map(x => x.trim()).filter(Boolean).some(x => mm[1] === x || mm[1].startsWith(x + '-'));
    if (!gcbLegacy && typeof proxyRequest.request_id === 'string') body.__aisRid = proxyRequest.request_id;
    proxyRequest.body = JSON.stringify(body);
  }
  _forwardRequest(proxyRequest) {
    this._pinMaxOutputTokens(proxyRequest);
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      connection.send(JSON.stringify(proxyRequest));
    } else {
      throw new Error("无法转发请求：没有可用的WebSocket连接。");
    }
  }
  _sendErrorChunkToClient(res, errorMessage) {
    const errorPayload = {
      error: {
        message: `[代理系统提示] ${errorMessage}`,
        type: "proxy_error",
        code: "proxy_error",
      },
    };
    const chunk = `data: ${JSON.stringify(errorPayload)}\n\n`;
    if (res && !res.writableEnded) {
      res.write(chunk);
      this.logger.info(`[Request] 已向客户端发送标准错误信号: ${errorMessage}`);
    }
  }

  async _handlePseudoStreamResponse(proxyRequest, messageQueue, req, res) {
    this.logger.info(
      "[Request] 客户端启用流式传输 (fake)，进入伪流式处理模式...",
    );
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const connectionMaintainer = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 3000);

    try {
      let lastMessage,
        requestFailed = false;

      // 我们的重试循环（即使只跑一次）
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        if (attempt > 1) {
          this.logger.info(
            `[Request] 请求尝试 #${attempt}/${this.maxRetries}...`,
          );
        }
        this._forwardRequest(proxyRequest);
        try {
          const timeoutPromise = new Promise(() => {}); // no request time limit
          lastMessage = await Promise.race([
            messageQueue.dequeue(),
            timeoutPromise,
          ]);
        } catch (timeoutError) {
          this.logger.error(`[Request] 致命错误: ${timeoutError.message}`);
          lastMessage = {
            event_type: "error",
            status: 504,
            message: timeoutError.message,
          };
        }

        if (lastMessage.event_type === "error") {
          // --- 核心修改：在这里就区分，避免打印不必要的“失败”日志 ---
          if (
            !(
              lastMessage.message &&
              lastMessage.message.includes("The user aborted a request")
            )
          ) {
            // 只有在不是“用户取消”的情况下，才打印“尝试失败”的警告
            this.logger.warn(
              `[Request] 尝试 #${attempt} 失败: 收到 ${
                lastMessage.status || "未知"
              } 错误。 - ${lastMessage.message}`,
            );
          }

          if (attempt < this.maxRetries) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.retryDelay),
            );
            continue;
          }
          requestFailed = true;
        }
        break;
      }

      // 处理最终结果
      if (requestFailed) {
        if (
          lastMessage.message &&
          lastMessage.message.includes("The user aborted a request")
        ) {
          this.logger.info(
            `[Request] 请求 #${proxyRequest.request_id} 已由用户妥善取消，不计入失败统计。`,
          );
        } else {
          this.logger.error(
            `[Request] 所有 ${this.maxRetries} 次重试均失败，将计入失败统计。`,
          );
          await this._handleRequestFailureAndSwitch(lastMessage, res);
          this._sendErrorChunkToClient(
            res,
            `请求最终失败: ${lastMessage.message}`,
          );
        }
        return;
      }

      // 成功的逻辑
      if (proxyRequest.is_generative && this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] 生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`,
        );
        this.failureCount = 0;
      }
      const dataMessage = await messageQueue.dequeue();
      const endMessage = await messageQueue.dequeue();
      if (dataMessage.data) {
        res.write(`data: ${dataMessage.data}\n\n`);
      }
      if (endMessage.type !== "STREAM_END") {
        this.logger.warn("[Request] 未收到预期的流结束信号。");
      }
      try {
        const fullResponse = JSON.parse(dataMessage.data);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`,
        );
      } catch (e) {}
      res.write("data: [DONE]\n\n");
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      clearInterval(connectionMaintainer);
      if (!res.writableEnded) {
        res.end();
      }
      this.logger.info(
        `[Request] 响应处理结束，请求ID: ${proxyRequest.request_id}`,
      );
    }
  }

  async _handleRealStreamResponse(proxyRequest, messageQueue, res) {
    this.logger.info(`[Request] 请求已派发给浏览器端处理...`);
    this._forwardRequest(proxyRequest);
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === "error") {
      if (
        headerMessage.message &&
        headerMessage.message.includes("The user aborted a request")
      ) {
        this.logger.info(
          `[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消，不计入失败统计。`,
        );
      } else {
        this.logger.error(`[Request] 请求失败，将计入失败统计。`);
        await this._handleRequestFailureAndSwitch(headerMessage, null);
        return this._sendErrorResponse(
          res,
          headerMessage.status,
          headerMessage.message,
        );
      }
      if (!res.writableEnded) res.end();
      return;
    }

    // --- 核心修改：只有在生成请求成功时，才重置失败计数 ---
    if (proxyRequest.is_generative && this.failureCount > 0) {
      this.logger.info(
        `✅ [Auth] 生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`,
      );
      this.failureCount = 0;
    }
    // --- 修改结束 ---

    this._setResponseHeaders(res, headerMessage);
    this.logger.info("[Request] 开始流式传输...");
    try {
      let lastChunk = "";
      while (true) {
        const dataMessage = await messageQueue.dequeue(30000);
        if (dataMessage.type === "STREAM_END") {
          this.logger.info("[Request] 收到流结束信号。");
          break;
        }
        if (dataMessage.data) {
          res.write(dataMessage.data);
          lastChunk = dataMessage.data;
        }
      }
      try {
        if (lastChunk.startsWith("data: ")) {
          const jsonString = lastChunk.substring(6).trim();
          if (jsonString) {
            const lastResponse = JSON.parse(jsonString);
            const finishReason =
              lastResponse.candidates?.[0]?.finishReason || "UNKNOWN";
            this.logger.info(
              `✅ [Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`,
            );
          }
        }
      } catch (e) {}
    } catch (error) {
      if (error.message !== "Queue timeout") throw error;
      this.logger.warn("[Request] 真流式响应超时，可能流已正常结束。");
    } finally {
      if (!res.writableEnded) res.end();
      this.logger.info(
        `[Request] 真流式响应连接已关闭，请求ID: ${proxyRequest.request_id}`,
      );
    }
  }

  async _handleNonStreamResponse(proxyRequest, messageQueue, res) {
    this.logger.info(`[Request] 进入非流式处理模式...`);

    // 转发请求到浏览器端
    this._forwardRequest(proxyRequest);

    try {
      // 1. 等待响应头信息
      const headerMessage = await messageQueue.dequeue();
      if (headerMessage.event_type === "error") {
        // ... (错误处理逻辑保持不变)
        if (headerMessage.message?.includes("The user aborted a request")) {
          this.logger.info(
            `[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消。`,
          );
        } else {
          this.logger.error(
            `[Request] 浏览器端返回错误: ${headerMessage.message}`,
          );
          await this._handleRequestFailureAndSwitch(headerMessage, null);
        }
        return this._sendErrorResponse(
          res,
          headerMessage.status || 500,
          headerMessage.message,
        );
      }

      // 2. 准备一个缓冲区，并确保循环等待直到收到结束信号
      let fullBody = "";
      while (true) {
        const message = await messageQueue.dequeue();
        if (message.type === "STREAM_END") {
          this.logger.info("[Request] 收到结束信号，数据接收完毕。");
          break;
        }
        if (message.event_type === "chunk" && message.data) {
          fullBody += message.data;
        }
      }

      // 3. 重置失败计数器（如果需要）
      if (proxyRequest.is_generative && this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] 非流式生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`,
        );
        this.failureCount = 0;
      }

      // [核心修正] 对Google原生格式的响应进行智能图片处理
      try {
        let parsedBody = JSON.parse(fullBody);
        let needsReserialization = false;

        const candidate = parsedBody.candidates?.[0];
        if (candidate?.content?.parts) {
          const imagePartIndex = candidate.content.parts.findIndex(
            (p) => p.inlineData,
          );

          if (imagePartIndex > -1) {
            this.logger.info(
              "[Proxy] 检测到Google格式响应中的图片数据，正在转换为Markdown...",
            );
            const imagePart = candidate.content.parts[imagePartIndex];
            const image = imagePart.inlineData;

            // 创建一个新的 text part 来替换原来的 inlineData part
            const markdownTextPart = {
              text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
            };

            // 替换掉原来的部分
            candidate.content.parts[imagePartIndex] = markdownTextPart;
            needsReserialization = true;
          }
        }

        if (needsReserialization) {
          fullBody = JSON.stringify(parsedBody); // 如果处理了图片，重新序列化
        }
      } catch (e) {
        this.logger.warn(
          `[Proxy] 响应体不是有效的JSON，或在处理图片时出错: ${e.message}`,
        );
        // 如果出错，则什么都不做，直接发送原始的 fullBody
      }

      try {
        const fullResponse = JSON.parse(fullBody);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`,
        );
      } catch (e) {}

      // 4. 设置正确的JSON响应头，并一次性发送处理过的全部数据
      res
        .status(headerMessage.status || 200)
        .type("application/json")
        .send(fullBody || "{}");

      this.logger.info(`[Request] 已向客户端发送完整的非流式响应。`);
    } catch (error) {
      this._handleRequestError(error, res);
    }
  }

  async _atContinueUntilAnswer(googleResponse, googleBody, res, model, requestId, startedAt = Date.now()) {
    const atRealModelName = AT.atRealModel(model);
    let previousOperationId = requestId;
    let attempt = 0;
    let current = googleResponse;
    let lastAnswer = null;
    const atUsage = {complete: true, sum: {}};
    const atAddUsage = (resp) => { const u = resp && resp.usageMetadata; if (!u || typeof u !== 'object') { atUsage.complete = false; return; } for (const key of ['promptTokenCount','candidatesTokenCount','thoughtsTokenCount','cachedContentTokenCount','totalTokenCount']) { if (Number.isSafeInteger(u[key]) && u[key] >= 0) atUsage.sum[key] = (atUsage.sum[key] || 0) + u[key]; } };
    atAddUsage(current);
    // Diagnostics only: shape and size of each round, never the content itself.
    let roundStartedAt = null;
    const atRoundLog = (round, resp, r) => {
      try {
        const c = resp && resp.candidates && resp.candidates[0];
        const parts = (c && c.content && Array.isArray(c.content.parts)) ? c.content.parts : [];
        let textParts = 0, textChars = 0, thoughtParts = 0, thoughtChars = 0; const calls = [];
        for (const p of parts) {
          if (p && p.functionCall) calls.push(String(p.functionCall.name || '?').slice(0, 40) + (p.functionCall.args && typeof p.functionCall.args.answer === 'string' ? '(answer=' + p.functionCall.args.answer.length + ')' : '(no-answer)'));
          else if (p && typeof p.text === 'string') { if (p.thought) { thoughtParts++; thoughtChars += p.text.length; } else { textParts++; textChars += p.text.length; } }
        }
        const u = (resp && resp.usageMetadata) || {};
        this.logger.info('[AT] round ' + round + ' model=' + atRealModelName + ' req=' + requestId +
          ' ms=' + (roundStartedAt ? Date.now() - roundStartedAt : '-') +
          ' candidates=' + ((resp && resp.candidates) ? resp.candidates.length : 0) +
          ' finish=' + ((c && c.finishReason) || '-') + ' parts=' + parts.length +
          ' text=' + textParts + '/' + textChars + 'ch thought=' + thoughtParts + '/' + thoughtChars + 'ch' +
          ' calls=[' + calls.join(',') + ']' +
          ' emit_answer=' + (r.found ? 'yes' : 'no') +
          ' tok(in/out/think)=' + (u.promptTokenCount ?? '-') + '/' + (u.candidatesTokenCount ?? '-') + '/' + (u.thoughtsTokenCount ?? '-') +
          (resp && resp.promptFeedback && resp.promptFeedback.blockReason ? ' blocked=' + resp.promptFeedback.blockReason : ''));
      } catch (e) { this.logger.warn('[AT] round log failed: ' + e.message); }
    };
    while (attempt <= AT.AT_MAX_ATTEMPTS) {
      attempt++;
      const r = AT.atExtractAnswer(current);
      atRoundLog(attempt, current, r);
      if (r.found ? /^STOP$/.test(r.finishReason || String()) : false) {
        if (atUsage.complete && Number.isSafeInteger(atUsage.sum.promptTokenCount)) r.usageMetadata = atUsage.sum;
        else this.logger.warn("[AT] usage missing in at least one round; tokens for this request will be unknown");
        this.logger.info("[AT] emit_answer found on attempt " + attempt + ", len=" + r.answer.length);
        return r;
      }
      if (attempt > AT.AT_MAX_ATTEMPTS) break;
      if (r.finishReason && !/^(STOP|MAX_TOKENS|MALFORMED_FUNCTION_CALL)$/.test(r.finishReason)) { this.logger.warn('[AT] giving up: finish=' + r.finishReason + ' on round ' + attempt); const atBlock = AT.atBlockInfo(current); if (atBlock) { if (attempt > 1) atBlock.promptTokens = atUsage.complete && Number.isSafeInteger(atUsage.sum.promptTokenCount) ? atUsage.sum.promptTokenCount : null; this.logger.warn('[AT] content blocked by upstream: reason=' + atBlock.reason + ' stage=' + atBlock.stage + ' round=' + attempt + ' promptTokens=' + (atBlock.promptTokens ?? '-')); throw Object.assign(Error('AT_content_blocked'), {status: 502, atBlock}); } { const c0 = current && current.candidates && current.candidates[0]; let chars = 0; for (const p of ((c0 && c0.content && c0.content.parts) || [])) if (p && typeof p.text === 'string' && !p.thought) chars += p.text.length; const ok = atUsage.complete && Number.isSafeInteger(atUsage.sum.promptTokenCount); const atFinish = { reason: String(r.finishReason).slice(0, 40).replace(/[^A-Z0-9_]/gi, '_'), round: attempt, chars, promptTokens: ok ? atUsage.sum.promptTokenCount : null, outputTokens: ok && Number.isSafeInteger(atUsage.sum.candidatesTokenCount) ? atUsage.sum.candidatesTokenCount : null }; this.logger.warn('[AT] upstream ended early: finish=' + atFinish.reason + ' round=' + attempt + ' chars=' + chars + ' tok(in/out)=' + (atFinish.promptTokens ?? '-') + '/' + (atFinish.outputTokens ?? '-') + ' ms=' + (roundStartedAt ? Date.now() - roundStartedAt : '-') + '; not continued, nothing returned'); throw Object.assign(Error('AT_upstream_finish_' + atFinish.reason), {status: 502, atFinish}); } }
      { const elapsed = Date.now() - startedAt; if (elapsed >= AT.AT_CONTINUE_DEADLINE_MS) { const c0 = current && current.candidates && current.candidates[0]; let chars = 0; for (const p of ((c0 && c0.content && c0.content.parts) || [])) if (p && typeof p.text === 'string' && !p.thought) chars += p.text.length; const ok = atUsage.complete && Number.isSafeInteger(atUsage.sum.promptTokenCount); const atFinish = { reason: String(r.finishReason || 'NO_ANSWER').slice(0, 40).replace(/[^A-Z0-9_]/gi, '_'), round: attempt, chars, elapsedMs: elapsed, timeLimit: true, promptTokens: ok ? atUsage.sum.promptTokenCount : null, outputTokens: ok && Number.isSafeInteger(atUsage.sum.candidatesTokenCount) ? atUsage.sum.candidatesTokenCount : null }; this.logger.warn('[AT] not continuing: elapsed=' + elapsed + 'ms >= ' + AT.AT_CONTINUE_DEADLINE_MS + 'ms, finish=' + atFinish.reason + ' round=' + attempt + ' chars=' + chars + ' tok(in/out)=' + (atFinish.promptTokens ?? '-') + '/' + (atFinish.outputTokens ?? '-')); throw Object.assign(Error('AT_continue_deadline'), {status: 502, atFinish}); } }
      this.logger.info('[AT] continuing because ' + (r.found ? 'emit_answer finish=' + r.finishReason : 'no emit_answer (finish=' + (r.finishReason || '-') + ')'));
      lastAnswer = r.answer || lastAnswer;
      if (typeof this._atWaitOperationDone !== /function/.source) throw Error(/AT_cleanup_hook_missing/.source);
      if (!await this._atWaitOperationDone(previousOperationId)) throw Error(/AT_previous_operation_not_settled/.source);
      if (res.destroyed || res.writableEnded) throw Error(/AT_client_disconnected/.source);
      const contBody = AT.atBuildContinuationBody(googleBody, current, lastAnswer);
      const contId = this._generateRequestId();
      const contQueue = this.connectionRegistry.createMessageQueue(contId);
      const contOnClose = () => { if (!res.writableEnded) { this.logger.warn('[AT] client gone during continuation #' + contId + '; cancelling upstream'); this._cancelBrowserRequest(contId); } };
      res.on("close", contOnClose);
      try {
        this.logger.info("[AT] continuation attempt " + attempt + "/" + AT.AT_MAX_ATTEMPTS + " bodyChars=" + JSON.stringify(contBody).length + " prevAnswerChars=" + (lastAnswer ? lastAnswer.length : 0));
        roundStartedAt = Date.now();
        this._forwardRequest({
          path: `/v1beta/models/${atRealModelName}:generateContent`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          query_params: {},
          body: JSON.stringify(contBody),
          request_id: contId,
          is_generative: true,
          streaming_mode: "fake",
        });
        const headerMsg = await contQueue.dequeue();
        if (headerMsg.event_type === "error") {
          this.logger.warn("[AT] continuation error: " + (headerMsg.message || "").slice(0, 200));
          return null;
        }
        let contFull = "";
        while (true) {
          const m = await contQueue.dequeue();
          if (m.type === "STREAM_END") break;
          if (m.event_type === "chunk" && m.data) contFull += m.data;
        }
        current = JSON.parse(contFull);
        atAddUsage(current);
        previousOperationId = contId;
      } catch (e) {
        this.logger.warn("[AT] continuation failed: " + e.message);
        return null;
      } finally {
        res.removeListener("close", contOnClose);
        this.connectionRegistry.removeMessageQueue(contId);
      }
    }
    this.logger.warn("[AT] max attempts reached without emit_answer");
    return null;
  }
  _getKeepAliveChunk(req) {
    if (req.path.includes("chat/completions")) {
      const payload = {
        id: `chatcmpl-${this._generateRequestId()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4",
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    if (
      req.path.includes("generateContent") ||
      req.path.includes("streamGenerateContent")
    ) {
      const payload = {
        candidates: [
          {
            content: { parts: [{ text: "" }], role: "model" },
            finishReason: null,
            index: 0,
            safetyRatings: [],
          },
        ],
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    return "data: {}\n\n";
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      if (name.toLowerCase() !== "content-length") res.set(name, value);
    });
  }
  _handleRequestError(error, res) {
    if (res.headersSent) {
      this.logger.error(`[Request] 请求处理错误 (头已发送): ${error.message}`);
      if (this.serverSystem.streamingMode === "fake")
        this._sendErrorChunkToClient(res, `处理失败: ${error.message}`);
      if (!res.writableEnded) res.end();
    } else {
      this.logger.error(`[Request] 请求处理错误: ${error.message}`);
      const status = error.message.includes("超时") ? 504 : 500;
      this._sendErrorResponse(res, status, `代理错误: ${error.message}`);
    }
  }

  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) {
      // 1. 创建一个符合API规范的JSON错误对象
      const errorPayload = {
        error: {
          code: status || 500,
          message: message,
          status: ({400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 429: "RESOURCE_EXHAUSTED", 500: "INTERNAL", 502: "BAD_GATEWAY", 503: "UNAVAILABLE", 504: "DEADLINE_EXCEEDED"})[status || 500] || "UNKNOWN",
        },
      };
      // 2. 设置响应类型为 application/json 并发送
      res
        .status(status || 500)
        .type("application/json")
        .send(JSON.stringify(errorPayload));
    }
  }

  _translateOpenAIToGoogle(openaiBody, modelName = "") {
    this.logger.info("[Adapter] 开始将OpenAI请求格式翻译为Google格式...");

    let systemInstruction = null;
    const googleContents = [];

    // 1. 分离出 system 指令
    const systemMessages = openaiBody.messages.filter(
      (msg) => msg.role === "system",
    );
    if (systemMessages.length > 0) {
      // 将所有 system message 的内容合并
      const systemContent = systemMessages.map((msg) => msg.content).join("\n");
      systemInstruction = {
        // Google Gemini 1.5 Pro 开始正式支持 system instruction
        role: "system",
        parts: [{ text: systemContent }],
      };
    }

    // 2. 转换 user 和 assistant 消息
    const conversationMessages = openaiBody.messages.filter(
      (msg) => msg.role !== "system",
    );
    const oaiToolNames = {};
    for (const m of conversationMessages) for (const tc of (m.tool_calls || [])) if (tc && tc.id && tc.function) oaiToolNames[tc.id] = tc.function.name;
    for (const message of conversationMessages) {
      if (message.role === "tool" || message.role === "function") {
        let resp = message.content; if (Array.isArray(resp)) resp = resp.map(x => x && x.text || "").join("");
        try { resp = JSON.parse(resp); } catch {}
        if (resp === null || typeof resp !== "object" || Array.isArray(resp)) resp = { result: resp };
        const frPart = { functionResponse: { name: message.name || oaiToolNames[message.tool_call_id] || "tool", response: resp } };
        const prev = googleContents[googleContents.length - 1];
        if (prev && prev.role === "user" && prev.parts.length && prev.parts.every(x => x.functionResponse)) prev.parts.push(frPart);
        else googleContents.push({ role: "user", parts: [frPart] });
        continue;
      }
      const googleParts = [];

      // [核心改进] 判断 content 是字符串还是数组
      if (typeof message.content === "string") {
        // a. 如果是纯文本
        googleParts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        // b. 如果是图文混合内容
        for (const part of message.content) {
          if (part.type === "text") {
            googleParts.push({ text: part.text });
          } else if (part.type === "image_url" && part.image_url) {
            // 从 data URL 中提取 mimetype 和 base64 数据
            const dataUrl = part.image_url.url;
            const match = dataUrl.match(/^data:(image\/.*?);base64,(.*)$/);
            if (match) {
              googleParts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              });
            }
          }
        }
      }

      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        for (let i = googleParts.length - 1; i >= 0; i--) if (googleParts[i].text === "") googleParts.splice(i, 1);
        for (const tc of message.tool_calls) {
          if (!tc || !tc.function) continue;
          let args = tc.function.arguments; try { args = typeof args === "string" ? JSON.parse(args || "{}") : (args || {}); } catch { args = {}; }
          googleParts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      googleContents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: googleParts,
      });
    }

    // 3. 构建最终的Google请求体
    const googleRequest = {
      contents: googleContents,
      ...(systemInstruction && {
        systemInstruction: { parts: systemInstruction.parts },
      }),
    };

    // 4. 转换生成参数
    const generationConfig = {
      temperature: openaiBody.temperature,
      topP: openaiBody.top_p,
      topK: openaiBody.top_k,
      maxOutputTokens: openaiBody.max_tokens,
      stopSequences: openaiBody.stop,
    };
    const rf = openaiBody.response_format;
    if (rf && (rf.type === "json_object" || rf.type === "json_schema")) {
      generationConfig.responseMimeType = "application/json";
      const js = rf.json_schema && rf.json_schema.schema;
      if (rf.type === "json_schema" && js && typeof js === "object") generationConfig.responseSchema = js;
      this.logger.info(`[Adapter] response_format=${rf.type} -> JSON mode${generationConfig.responseSchema ? " + schema" : ""}`);
    }

    const extraBody = openaiBody.extra_body || {};
    let rawThinkingConfig =
      extraBody.google?.thinking_config ||
      extraBody.google?.thinkingConfig ||
      extraBody.thinkingConfig ||
      extraBody.thinking_config ||
      openaiBody.thinkingConfig ||
      openaiBody.thinking_config;

    let thinkingConfig = null;

    if (rawThinkingConfig) {
      // 2. 格式清洗：将 snake_case (下划线) 转换为 camelCase (驼峰)
      thinkingConfig = {};

      // 处理开关
      if (rawThinkingConfig.include_thoughts !== undefined) {
        thinkingConfig.includeThoughts = rawThinkingConfig.include_thoughts;
      } else if (rawThinkingConfig.includeThoughts !== undefined) {
        thinkingConfig.includeThoughts = rawThinkingConfig.includeThoughts;
      }

      // 处理 Budget (预算)
      // if (rawThinkingConfig.thinking_budget !== undefined) {
      // thinkingConfig.thinkingBudgetTokenLimit =
      // rawThinkingConfig.thinking_budget;
      //} else if (rawThinkingConfig.thinkingBudget !== undefined) {
      //thinkingConfig.thinkingBudgetTokenLimit =
      //rawThinkingConfig.thinkingBudget;
      //}

      this.logger.info(
        `[Adapter] 成功提取并转换推理配置: ${JSON.stringify(thinkingConfig)}`,
      );
    }

    // 3. 如果没找到配置，尝试识别 OpenAI 标准参数 'reasoning_effort'
    if (!thinkingConfig) {
      const effort = openaiBody.reasoning_effort || extraBody.reasoning_effort;
      if (effort) {
        this.logger.info(
          `[Adapter] 检测到 OpenAI 标准推理参数 (reasoning_effort: ${effort})，自动转换为 Google 格式。`,
        );
        thinkingConfig = { includeThoughts: true };
      }
    }

    // 4. 强制开启逻辑 (WebUI开关)
    if (this.serverSystem.forceThinking && !thinkingConfig) {
      this.logger.info(
        "[Adapter] ⚠️ 强制推理已启用，且客户端未提供配置，正在注入 thinkingConfig...",
      );
      thinkingConfig = { includeThoughts: true };
    }

    // 5. 写入最终配置
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig;
    }

    googleRequest.generationConfig = generationConfig;
    const oaiTools = (openaiBody.tools || []).filter(t => t && t.type === "function" && t.function).map(t => ({ name: t.function.name, description: t.function.description || "", ...(t.function.parameters ? { parameters: t.function.parameters } : {}) }));
    if (Array.isArray(openaiBody.functions)) for (const f of openaiBody.functions) if (f && f.name) oaiTools.push({ name: f.name, description: f.description || "", ...(f.parameters ? { parameters: f.parameters } : {}) });
    if (oaiTools.length) {
      googleRequest.tools = [{ functionDeclarations: oaiTools }];
      this.logger.info(`[Adapter] 已转换 ${oaiTools.length} 个工具定义。`);
    }
    // 5. 安全设置
    googleRequest.safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ];

    this.logger.info("[Adapter] 翻译完成。");
    return googleRequest;
  }

  _translateGoogleToOpenAIStream(googleChunk, modelName = "gemini-pro") {
    if (!googleChunk || googleChunk.trim() === "") {
      return null;
    }

    let jsonString = googleChunk;
    if (jsonString.startsWith("data: ")) {
      jsonString = jsonString.substring(6).trim();
    }

    if (!jsonString || jsonString === "[DONE]") return null;

    let googleResponse;
    try {
      googleResponse = JSON.parse(jsonString);
    } catch (e) {
      this.logger.warn(`[Adapter] 无法解析Google返回的JSON块: ${jsonString}`);
      return null;
    }

    if (Array.isArray(googleResponse)) {
      return googleResponse.map(item => this._translateGoogleToOpenAIStream(JSON.stringify(item), modelName)).filter(Boolean).join('') || null;
    }
    const usageFields = responseUsageFields(googleResponse);
    const hasUsage = Boolean(usageFields.usageMetadata);
    const candidate = googleResponse.candidates?.[0];
    if (!candidate) {
      if (googleResponse.promptFeedback) {
        this.logger.warn(
          `[Adapter] Google返回了promptFeedback，可能已被拦截: ${JSON.stringify(
            googleResponse.promptFeedback,
          )}`,
        );
        const errorText = `[ProxySystem Error] Request blocked due to safety settings. Finish Reason: ${googleResponse.promptFeedback.blockReason}`;
        return `data: ${JSON.stringify({
          id: `chatcmpl-${this._generateRequestId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            { index: 0, delta: { content: errorText }, finish_reason: "stop" },
          ],
        })}\n\n`;
      }
      if (hasUsage) {
        return `data: ${JSON.stringify({
          id: `chatcmpl-${this._generateRequestId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [],
          ...usageFields,
        })}\n\n`;
      }
      return null;
    }

    const delta = {};

    if (candidate.content && Array.isArray(candidate.content.parts)) {
      const imagePart = candidate.content.parts.find((p) => p.inlineData);

      if (imagePart) {
        const image = imagePart.inlineData;
        delta.content = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
        this.logger.info("[Adapter] 从流式响应块中成功解析到图片。");
      } else {
        // 遍历所有部分，分离思考内容和正文内容
        let contentAccumulator = "";
        let reasoningAccumulator = "";

        for (const part of candidate.content.parts) {
          if (part.functionCall) {
            delta.tool_calls = delta.tool_calls || [];
            delta.tool_calls.push({ index: delta.tool_calls.length, id: part.functionCall.id || ("call_" + Math.random().toString(36).slice(2, 12)), type: "function", function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } });
            continue;
          }
          // Google API 的 thought 标记
          if (part.thought === true) {
            reasoningAccumulator += part.text || "";
          } else {
            contentAccumulator += part.text || "";
          }
        }

        // 只有当有内容时才添加到 delta 中
        if (reasoningAccumulator) {
          delta.reasoning_content = reasoningAccumulator;
        }
        if (contentAccumulator) {
          delta.content = contentAccumulator;
        }
      }
    }

    // 如果没有任何内容变更，则不返回数据（避免空行）
    if (!delta.content && !delta.reasoning_content && !delta.tool_calls && !candidate.finishReason && !hasUsage) {
      return null;
    }

    const openaiResponse = {
      id: `chatcmpl-${this._generateRequestId()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      ...usageFields,
      choices: [
        {
          index: 0,
          delta: delta, // 使用包含 reasoning_content 的 delta
          finish_reason: delta.tool_calls ? "tool_calls" : (candidate.finishReason || null),
        },
      ],
    };

    return `data: ${JSON.stringify(openaiResponse)}\n\n`;
  }
}


// Response accounting metadata only. Never owns request admission or quota.
function responseUsageFields(response) {
  const raw = response?.usageMetadata;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const metadata = {};
  for (const key of ['promptTokenCount', 'candidatesTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount', 'totalTokenCount']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) metadata[key] = raw[key];
  }
  if (!Object.keys(metadata).length) return {};
  const usage = {};
  if (Object.hasOwn(metadata, 'promptTokenCount')) usage.prompt_tokens = metadata.promptTokenCount;
  if (Object.hasOwn(metadata, 'totalTokenCount')) usage.total_tokens = metadata.totalTokenCount;
  if (Object.hasOwn(metadata, 'cachedContentTokenCount')) {
    usage.prompt_tokens_details = {cached_tokens: metadata.cachedContentTokenCount};
  }
  if (Object.hasOwn(metadata, 'thoughtsTokenCount')) {
    usage.completion_tokens_details = {reasoning_tokens: metadata.thoughtsTokenCount};
    if (Object.hasOwn(metadata, 'candidatesTokenCount')) {
      const completion = metadata.candidatesTokenCount + metadata.thoughtsTokenCount;
      if (Number.isSafeInteger(completion)) usage.completion_tokens = completion;
    }
  }
  // Keep native counts for lossless accounting when a standard field is unknown.
  return {usageMetadata: metadata, usage};
}

class ProxyServerSystem extends EventEmitter {
  constructor() {
    super();
    this.logger = new LoggingService("ProxySystem");
    this._loadConfiguration(); // 这个函数会执行下面的_loadConfiguration
    this.streamingMode = this.config.streamingMode;

    this.forceThinking = false;

    this.authSource = new AuthSource(this.logger);
    this.browserManager = new BrowserManager(
      this.logger,
      this.config,
      this.authSource,
    );
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(
      this,
      this.connectionRegistry,
      this.logger,
      this.browserManager,
      this.config,
      this.authSource,
    );

    require("./stability").install(this.requestHandler);
    this.httpServer = null;
    this.wsServer = null;
  }

  // ===== 所有函数都已正确放置在类内部 =====

  _loadConfiguration() {
    let config = {
      httpPort: 7860,
      host: "0.0.0.0",
      wsPort: 9998,
      streamingMode: "real",
      failureThreshold: 3,
      switchOnUses: 40,
      maxRetries: 1,
      retryDelay: 2000,
      browserExecutablePath: null,
      apiKeys: [],
      immediateSwitchStatusCodes: [429, 503],
      // [新增] 用于追踪API密钥来源
      apiKeySource: "未设置",
      targetUrl: "",
    };

    const configPath = path.join(__dirname, "config.json");
    try {
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        config = { ...config, ...fileConfig };
        this.logger.info("[System] 已从 config.json 加载配置。");
      }
    } catch (error) {
      this.logger.warn(`[System] 无法读取或解析 config.json: ${error.message}`);
    }

    if (process.env.PORT)
      config.httpPort = parseInt(process.env.PORT, 10) || config.httpPort;
    if (process.env.HOST) config.host = process.env.HOST;
    if (process.env.TARGET_URL) config.targetUrl = process.env.TARGET_URL;
    if (process.env.STREAMING_MODE)
      config.streamingMode = process.env.STREAMING_MODE;
    if (process.env.FAILURE_THRESHOLD)
      config.failureThreshold =
        parseInt(process.env.FAILURE_THRESHOLD, 10) || config.failureThreshold;
    if (process.env.SWITCH_ON_USES)
      config.switchOnUses =
        parseInt(process.env.SWITCH_ON_USES, 10) || config.switchOnUses;
    if (process.env.MAX_RETRIES)
      config.maxRetries =
        parseInt(process.env.MAX_RETRIES, 10) || config.maxRetries;
    if (process.env.RETRY_DELAY)
      config.retryDelay =
        parseInt(process.env.RETRY_DELAY, 10) || config.retryDelay;
    if (process.env.CAMOUFOX_EXECUTABLE_PATH)
      config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
    if (process.env.API_KEYS) {
      config.apiKeys = process.env.API_KEYS.split(",");
    }

    let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
    let codesSource = "环境变量";

    if (
      !rawCodes &&
      config.immediateSwitchStatusCodes &&
      Array.isArray(config.immediateSwitchStatusCodes)
    ) {
      rawCodes = config.immediateSwitchStatusCodes.join(",");
      codesSource = "config.json 文件或默认值";
    }

    if (rawCodes && typeof rawCodes === "string") {
      config.immediateSwitchStatusCodes = rawCodes
        .split(",")
        .map((code) => parseInt(String(code).trim(), 10))
        .filter((code) => !isNaN(code) && code >= 400 && code <= 599);
      if (config.immediateSwitchStatusCodes.length > 0) {
        this.logger.info(`[System] 已从 ${codesSource} 加载“立即切换报错码”。`);
      }
    } else {
      config.immediateSwitchStatusCodes = [];
    }

    if (Array.isArray(config.apiKeys)) {
      config.apiKeys = config.apiKeys
        .map((k) => String(k).trim())
        .filter((k) => k);
    } else {
      config.apiKeys = [];
    }

    // [修改] 更新API密钥来源的判断逻辑
    if (config.apiKeys.length > 0) {
      config.apiKeySource = "自定义";
    } else {
      config.apiKeys = ["123456"];
      config.apiKeySource = "默认";
      this.logger.info("[System] 未设置任何API Key，已启用默认密码: 123456");
    }

    // Official catalog snapshot; persisted in the mounted runtime file.
    config.modelList = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro"
];
    this.config = config;
    this.logger.info("================ [ 生效配置 ] ================");
    this.logger.info(`  HTTP 服务端口: ${this.config.httpPort}`);
    this.logger.info(`  监听地址: ${this.config.host}`);
    this.logger.info(`  流式模式: ${this.config.streamingMode}`);
    this.logger.info(
      `  轮换计数切换阈值: ${
        this.config.switchOnUses > 0
          ? `每 ${this.config.switchOnUses} 次请求后切换`
          : "已禁用"
      }`,
    );
    this.logger.info(
      `  失败计数切换: ${
        this.config.failureThreshold > 0
          ? `失败${this.config.failureThreshold} 次后切换`
          : "已禁用"
      }`,
    );
    this.logger.info(
      `  立即切换报错码: ${
        this.config.immediateSwitchStatusCodes.length > 0
          ? this.config.immediateSwitchStatusCodes.join(", ")
          : "已禁用"
      }`,
    );
    this.logger.info(`  单次请求最大重试: ${this.config.maxRetries}次`);
    this.logger.info(`  重试间隔: ${this.config.retryDelay}ms`);
    this.logger.info(`  API 密钥来源: ${this.config.apiKeySource}`); // 在启动日志中也显示出来
    this.logger.info(
      "=============================================================",
    );
  }

  async start(initialAuthIndex = null) {
    // <<<--- 1. 重新接收参数
    this.logger.info("[System] 开始弹性启动流程...");
    await this._startHttpServer();
    await this._startWebSocketServer();
    const allAvailableIndices = this.authSource.availableIndices;

    if (allAvailableIndices.length === 0) {
      this.logger.info("[System] 服务器已就绪，等待导入账号。");
      this.emit("started");
      return;
    }

    this.logger.info("[System] 准备加载浏览器...");

    // 2. <<<--- 创建一个优先尝试的启动顺序列表 --->>>
    let startupOrder = [...allAvailableIndices];
    if (initialAuthIndex && allAvailableIndices.includes(initialAuthIndex)) {
      this.logger.info(
        `[System] 检测到指定启动索引 #${initialAuthIndex}，将优先尝试。`,
      );
      // 将指定索引放到数组第一位，其他索引保持原状
      startupOrder = [
        initialAuthIndex,
        ...allAvailableIndices.filter((i) => i !== initialAuthIndex),
      ];
    } else {
      if (initialAuthIndex) {
        this.logger.warn(
          `[System] 指定的启动索引 #${initialAuthIndex} 无效或不可用，将按默认顺序启动。`,
        );
      }
      this.logger.info(
        `[System] 未指定有效启动索引，将按默认顺序 [${startupOrder.join(
          ", ",
        )}] 尝试。`,
      );
    }

    let isStarted = false;
    // 3. <<<--- 遍历这个新的、可能被重排过的顺序列表 --->>>
    for (const index of startupOrder) {
      try {
        this.logger.info(`[System] 尝试使用账号 #${index} 启动服务...`);
        await this.browserManager.launchOrSwitchContext(index);

        isStarted = true;
        this.logger.info(`[System] ✅ 使用账号 #${index} 成功启动！`);
        break; // 成功启动，跳出循环
      } catch (error) {
        this.logger.error(
          `[System] ❌ 使用账号 #${index} 启动失败。原因: ${error.message}`,
        );
        // 失败了，循环将继续，尝试下一个账号
      }
    }

    if (!isStarted) {
      this.logger.error(
        "[System] 所有认证源启动失败；HTTP 服务保持运行，可通过 /import 修复账号。",
      );
      this.emit("started");
      return;
    }
    this.logger.info(`[System] 代理服务器系统启动完成。`);
    this.emit("started");
  }

  _createAuthMiddleware() {
    const basicAuth = require("basic-auth"); // 确保此行存在，为admin认证提供支持

    return (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) {
        return next();
      }

      let clientKey = null;
      if (req.headers["x-goog-api-key"]) {
        clientKey = req.headers["x-goog-api-key"];
      } else if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer ")
      ) {
        clientKey = req.headers.authorization.substring(7);
      } else if (req.headers["x-api-key"]) {
        clientKey = req.headers["x-api-key"];
      } else if (req.query.key) {
        clientKey = req.query.key;
      }

      if (clientKey && serverApiKeys.includes(clientKey)) {
        this.logger.info(
          `[Auth] API Key验证通过 (来自: ${
            req.headers["x-forwarded-for"] || req.ip
          })`,
        );
        if (req.query.key) {
          delete req.query.key;
        }
        return next();
      }

      // 对于没有有效API Key的请求，返回401错误
      // 注意：健康检查等逻辑已在_createExpressApp中提前处理
      if (req.path !== "/favicon.ico") {
        const clientIp = req.headers["x-forwarded-for"] || req.ip;
        this.logger.warn(
          `[Auth] 访问密码错误或缺失，已拒绝请求。IP: ${clientIp}, Path: ${req.path}`,
        );
      }

      return res.status(401).json({
        error: {
          message:
            "Access denied. A valid API key was not found or is incorrect.",
        },
      });
    };
  }

  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);

    this.httpServer.keepAliveTimeout = 120000;
    this.httpServer.headersTimeout = 125000;
    this.httpServer.requestTimeout = 120000;

    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(
          `[System] HTTP服务器已在 http://${this.config.host}:${this.config.httpPort} 上监听`,
        );
        this.logger.info(
          `[System] Keep-Alive 超时已设置为 ${
            this.httpServer.keepAliveTimeout / 1000
          } 秒。`,
        );
        resolve();
      });
    });
  }

  _createExpressApp() {
    const app = express();

    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-requested-with, x-api-key, x-goog-api-key, origin, accept",
      );
      if (req.method === "OPTIONS") {
        return res.sendStatus(204);
      }
      next();
    });

    app.use((req, res, next) => {
      if (
        req.path !== "/api/status" &&
        req.path !== "/" &&
        req.path !== "/favicon.ico" &&
        req.path !== "/login"
      ) {
        this.logger.info(
          `[Entrypoint] 收到一个请求: ${req.method} ${req.path}`,
        );
      }
      next();
    });
    app.use("/api/import-account", express.json({limit:"256kb"}), (err,req,res,next) => res.status(err.status===413?413:400).json({error:"JSON格式错误或超过256KiB"}));
    app.use(express.json({ limit: "100mb" }));
    app.use(express.urlencoded({ extended: true }));

    const sessionSecret =
      // Section 1 & 2 (核心中间件和登录路由) 保持不变...
      (this.config.apiKeys && this.config.apiKeys[0]) ||
      crypto.randomBytes(20).toString("hex");
    app.use(cookieParser());
    app.use(
      session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false, maxAge: 86400000 },
      }),
    );
    const isAuthenticated = (req, res, next) => {
      if (req.session.isAuthenticated) {
        return next();
      }
      res.redirect("/login");
    };
    require("./import-ui")(app,this);
    app.get("/login", (req, res) => {
      if (req.session.isAuthenticated) {
        return res.redirect("/");
      }
      const loginHtml = `
      <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录</title>
      <style>body{display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5}form{background:white;padding:40px;border-radius:10px;box-shadow:0 4px 8px rgba(0,0,0,0.1);text-align:center}input{width:250px;padding:10px;margin-top:10px;border:1px solid #ccc;border-radius:5px}button{width:100%;padding:10px;background-color:#007bff;color:white;border:none;border-radius:5px;margin-top:20px;cursor:pointer}.error{color:red;margin-top:10px}</style>
      </head><body><form action="/login" method="post"><h2>请输入 API Key</h2>
      <input type="password" name="apiKey" placeholder="API Key" required autofocus><button type="submit">登录</button>
      ${
        req.query.error ? '<p class="error">API Key 错误!</p>' : ""
      }</form></body></html>`;
      res.send(loginHtml);
    });
    app.post("/login", (req, res) => {
      const { apiKey } = req.body;
      if (apiKey && this.config.apiKeys.includes(apiKey)) {
        req.session.isAuthenticated = true;
        res.redirect("/");
      } else {
        res.redirect("/login?error=1");
      }
    });

    // ==========================================================
    // Section 3: 状态页面 和 API (最终版)
    // ==========================================================
    app.get("/", isAuthenticated, (req, res) => {
      const { config, requestHandler, authSource, browserManager } = this;
      const initialIndices = authSource.initialIndices || [];
      const availableIndices = authSource.availableIndices || [];
      const invalidIndices = initialIndices.filter(
        (i) => !availableIndices.includes(i),
      );
      const logs = this.logger.logBuffer || [];

      const accountNameMap = authSource.accountNameMap;
      const accountDetailsHtml = initialIndices
        .map((index) => {
          const isInvalid = invalidIndices.includes(index);
          const name = isInvalid
            ? "N/A (JSON格式错误)"
            : accountNameMap.get(index) || "N/A (未命名)";
          return `<span class="label" style="padding-left: 20px;">账号${index}</span>: ${name}`;
        })
        .join("\n");

      const accountOptionsHtml = availableIndices
        .map((index) => `<option value="${index}">账号 #${index}</option>`)
        .join("");

      const statusHtml = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>代理服务状态</title>
        <style>
        body { font-family: 'SF Mono', 'Consolas', 'Menlo', monospace; background-color: #f0f2f5; color: #333; padding: 2em; }
        .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 1em 2em 2em 2em; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        h1, h2 { color: #333; border-bottom: 2px solid #eee; padding-bottom: 0.5em;}
        pre { background: #2d2d2d; color: #f0f0f0; font-size: 1.1em; padding: 1.5em; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.6; }
        #log-container { font-size: 0.9em; max-height: 400px; overflow-y: auto; }
        .status-ok { color: #2ecc71; font-weight: bold; }
        .status-error { color: #e74c3c; font-weight: bold; }
        .label { display: inline-block; width: 220px; box-sizing: border-box; }
        .dot { height: 10px; width: 10px; background-color: #bbb; border-radius: 50%; display: inline-block; margin-left: 10px; animation: blink 1s infinite alternate; }
        @keyframes blink { from { opacity: 0.3; } to { opacity: 1; } }
        .action-group { display: flex; flex-wrap: wrap; gap: 15px; align-items: center; }
        .action-group button, .action-group select { font-size: 1em; border: 1px solid #ccc; padding: 10px 15px; border-radius: 8px; cursor: pointer; transition: background-color 0.3s ease; }
        .action-group button:hover { opacity: 0.85; }
        .action-group button { background-color: #007bff; color: white; border-color: #007bff; }
        .action-group select { background-color: #ffffff; color: #000000; -webkit-appearance: none; appearance: none; }
        @media (max-width: 600px) {
            body { padding: 0.5em; }
            .container { padding: 1em; margin: 0; }
            pre { padding: 1em; font-size: 0.9em; }
            .label { width: auto; display: inline; }
            .action-group { flex-direction: column; align-items: stretch; }
            .action-group select, .action-group button { width: 100%; box-sizing: border-box; }
        }
        </style>
    </head>
    <body>
        <div class="container">
        <p><a href="/import">📥 导入账号（JSON）</a></p>
        <h1>代理服务状态 <span class="dot" title="数据动态刷新中..."></span></h1>
        <div id="status-section">
            <pre>
<span class="label">服务状态</span>: <span class="status-ok">Running</span>
<span class="label">浏览器连接</span>: <span class="${
        browserManager.browser ? "status-ok" : "status-error"
      }">${!!browserManager.browser}</span>
--- 服务配置 ---
<span class="label">流模式</span>: ${
        config.streamingMode
      } (仅启用流式传输时生效)
<span class="label">强制推理</span>: ${
        this.forceThinking ? "✅ 已启用" : "❌ 已关闭"
      }
<span class="label">立即切换 (状态码)</span>: ${
        config.immediateSwitchStatusCodes.length > 0
          ? `[${config.immediateSwitchStatusCodes.join(", ")}]`
          : "已禁用"
      }
<span class="label">API 密钥</span>: ${config.apiKeySource}
--- 账号状态 ---
<span class="label">当前使用账号</span>: #${requestHandler.currentAuthIndex}
<span class="label">使用次数计数</span>: ${requestHandler.usageCount} / ${
        config.switchOnUses > 0 ? config.switchOnUses : "N/A"
      }
<span class="label">连续失败计数</span>: ${requestHandler.failureCount} / ${
        config.failureThreshold > 0 ? config.failureThreshold : "N/A"
      }
<span class="label">扫描到的总帐号</span>: [${initialIndices.join(
        ", ",
      )}] (总数: ${initialIndices.length})
      ${accountDetailsHtml}
<span class="label">格式错误 (已忽略)</span>: [${invalidIndices.join(
        ", ",
      )}] (总数: ${invalidIndices.length})
            </pre>
        </div>
        <div id="actions-section" style="margin-top: 2em;">
            <h2>操作面板</h2>
            <div class="action-group">
                <select id="accountIndexSelect">${accountOptionsHtml}</select>
                <button onclick="switchSpecificAccount()">切换账号</button>
                <button onclick="toggleStreamingMode()">切换流模式</button>
                <button onclick="toggleForceThinking()">切换强制推理</button>
            </div>
        </div>
        <div id="log-section" style="margin-top: 2em;">
            <h2>实时日志 (最近 ${logs.length} 条)</h2>
            <pre id="log-container">${logs.join("\n")}</pre>
        </div>
        </div>
        <script>
        function updateContent() {
            fetch('/api/status').then(response => response.json()).then(data => {
                const statusPre = document.querySelector('#status-section pre');
                const accountDetailsHtml = data.status.accountDetails.map(acc => {
                  return '<span class="label" style="padding-left: 20px;">账号' + acc.index + '</span>: ' + acc.name;
                }).join('\\n');
                statusPre.innerHTML =
                    '<span class="label">服务状态</span>: <span class="status-ok">Running</span>\\n' +
                    '<span class="label">浏览器连接</span>: <span class="' + (data.status.browserConnected ? "status-ok" : "status-error") + '">' + data.status.browserConnected + '</span>\\n' +
                    '--- 服务配置 ---\\n' +
                    '<span class="label">流模式</span>: ' + data.status.streamingMode + '\\n' +
                    '<span class="label">强制推理</span>: ' + data.status.forceThinking + '\\n' +
                    '<span class="label">立即切换 (状态码)</span>: ' + data.status.immediateSwitchStatusCodes + '\\n' +
                    '<span class="label">API 密钥</span>: ' + data.status.apiKeySource + '\\n' +
                    '--- 账号状态 ---\\n' +
                    '<span class="label">当前使用账号</span>: #' + data.status.currentAuthIndex + '\\n' +
                    '<span class="label">使用次数计数</span>: ' + data.status.usageCount + '\\n' +
                    '<span class="label">连续失败计数</span>: ' + data.status.failureCount + '\\n' +
                    '<span class="label">扫描到的总账号</span>: ' + data.status.initialIndices + '\\n' +
                    accountDetailsHtml + '\\n' +
                    '<span class="label">格式错误 (已忽略)</span>: ' + data.status.invalidIndices;

                const logContainer = document.getElementById('log-container');
                const logTitle = document.querySelector('#log-section h2');
                const isScrolledToBottom = logContainer.scrollHeight - logContainer.clientHeight <= logContainer.scrollTop + 1;
                logTitle.innerText = \`实时日志 (最近 \${data.logCount} 条)\`;
                logContainer.innerText = data.logs;
                if (isScrolledToBottom) { logContainer.scrollTop = logContainer.scrollHeight; }
            }).catch(error => console.error('Error fetching new content:', error));
        }

        function switchSpecificAccount() {
            const selectElement = document.getElementById('accountIndexSelect');
            const targetIndex = selectElement.value;
            if (!confirm(\`确定要切换到账号 #\${targetIndex} 吗？这会重置浏览器会话。\`)) {
                return;
            }
            fetch('/api/switch-account', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetIndex: parseInt(targetIndex, 10) })
            })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => {
                if (err.message.includes('Load failed') || err.message.includes('NetworkError')) {
                    alert('⚠️ 浏览器启动较慢，操作仍在后台进行中。\\n\\n请不要重复点击。');
                } else {
                    alert('❌ 操作失败: ' + err);
                }
                updateContent();
            });
        }

        function toggleStreamingMode() {
            const newMode = prompt('请输入新的流模式 (real 或 fake):', '${
              this.config.streamingMode
            }');
            if (newMode === 'fake' || newMode === 'real') {
                fetch('/api/set-mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: newMode })
                })
                .then(res => res.text()).then(data => { alert(data); updateContent(); })
                .catch(err => alert('设置失败: ' + err));
            } else if (newMode !== null) {
                alert('无效的模式！请只输入 "real" 或 "fake"。');
            }
        }

        function toggleForceThinking() {
            fetch('/api/toggle-force-thinking', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => alert('设置失败: ' + err));
        }

        document.addEventListener('DOMContentLoaded', () => {
            updateContent();
            setInterval(updateContent, 5000);
        });
        </script>
    </body>
    </html>
    `;
      res.status(200).send(statusHtml);
    });

    app.get("/api/status", isAuthenticated, (req, res) => {
      const { config, requestHandler, authSource, browserManager } = this;
      const initialIndices = authSource.initialIndices || [];
      const invalidIndices = initialIndices.filter(
        (i) => !authSource.availableIndices.includes(i),
      );
      const logs = this.logger.logBuffer || [];
      const accountNameMap = authSource.accountNameMap;
      const accountDetails = initialIndices.map((index) => {
        const isInvalid = invalidIndices.includes(index);
        const name = isInvalid
          ? "N/A (JSON格式错误)"
          : accountNameMap.get(index) || "N/A (未命名)";
        return { index, name };
      });

      const data = {
        status: {
          streamingMode: `${this.streamingMode} (仅启用流式传输时生效)`,
          forceThinking: this.forceThinking ? "✅ 已启用" : "❌ 已关闭",
          browserConnected: !!browserManager.browser,
          immediateSwitchStatusCodes:
            config.immediateSwitchStatusCodes.length > 0
              ? `[${config.immediateSwitchStatusCodes.join(", ")}]`
              : "已禁用",
          apiKeySource: config.apiKeySource,
          currentAuthIndex: requestHandler.currentAuthIndex,
          usageCount: `${requestHandler.usageCount} / ${
            config.switchOnUses > 0 ? config.switchOnUses : "N/A"
          }`,
          failureCount: `${requestHandler.failureCount} / ${
            config.failureThreshold > 0 ? config.failureThreshold : "N/A"
          }`,
          initialIndices: `[${initialIndices.join(", ")}] (总数: ${
            initialIndices.length
          })`,
          accountDetails: accountDetails,
          invalidIndices: `[${invalidIndices.join(", ")}] (总数: ${
            invalidIndices.length
          })`,
        },
        logs: logs.join("\n"),
        logCount: logs.length,
      };
      res.json(data);
    });
    app.post("/api/switch-account", isAuthenticated, async (req, res) => {
      try {
        const { targetIndex } = req.body;
        if (targetIndex !== undefined && targetIndex !== null) {
          this.logger.info(
            `[WebUI] 收到切换到指定账号 #${targetIndex} 的请求...`,
          );
          const result =
            await this.requestHandler._switchToSpecificAuth(targetIndex);
          if (result.success) {
            res.status(200).send(`切换成功！已激活账号 #${result.newIndex}。`);
          } else {
            res.status(400).send(result.reason);
          }
        } else {
          this.logger.info("[WebUI] 收到手动切换下一个账号的请求...");
          if (this.authSource.availableIndices.length <= 1) {
            return res
              .status(400)
              .send("切换操作已取消：只有一个可用账号，无法切换。");
          }
          const result = await this.requestHandler._switchToNextAuth();
          if (result.success) {
            res
              .status(200)
              .send(`切换成功！已切换到账号 #${result.newIndex}。`);
          } else if (result.fallback) {
            res
              .status(200)
              .send(`切换失败，但已成功回退到账号 #${result.newIndex}。`);
          } else {
            res.status(409).send(`操作未执行: ${result.reason}`);
          }
        }
      } catch (error) {
        res
          .status(500)
          .send(`致命错误：操作失败！请检查日志。错误: ${error.message}`);
      }
    });
    app.post("/api/set-mode", isAuthenticated, (req, res) => {
      const newMode = req.body.mode;
      if (newMode === "fake" || newMode === "real") {
        this.streamingMode = newMode;
        this.logger.info(
          `[WebUI] 流式模式已由认证用户切换为: ${this.streamingMode}`,
        );
        res.status(200).send(`流式模式已切换为: ${this.streamingMode}`);
      } else {
        res.status(400).send('无效模式. 请用 "fake" 或 "real".');
      }
    });

    app.post("/api/toggle-force-thinking", isAuthenticated, (req, res) => {
      this.forceThinking = !this.forceThinking;
      const statusText = this.forceThinking ? "已启用" : "已关闭";
      this.logger.info(`[WebUI] 强制推理开关已切换为: ${statusText}`);
      res.status(200).send(`强制推理模式: ${statusText}`);
    });

    app.use(this._createAuthMiddleware());

    app.get("/v1/models", (req, res) => {
      const modelIds = this.config.modelList || ["gemini-2.5-pro"];

      const models = modelIds.map((id) => ({
        id: id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google",
      }));

      res.status(200).json({
        object: "list",
        data: models,
      });
    });

    app.post("/v1/chat/completions", (req, res) => {
      this.requestHandler.processOpenAIRequest(req, res);
    });
    app.all(/(.*)/, (req, res) => {
      this.requestHandler.processRequest(req, res);
    });

    return app;
  }

  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({
      port: this.config.wsPort,
      host: this.config.host,
    });
    this.wsServer.on("connection", (ws, req) => {
      this.connectionRegistry.addConnection(ws, {
        address: req.socket.remoteAddress,
      });
    });
  }
}

// ===================================================================================
// MAIN INITIALIZATION
// ===================================================================================

async function initializeServer() {
  const initialAuthIndex = parseInt(process.env.INITIAL_AUTH_INDEX, 10) || 1;
  try {
    const serverSystem = new ProxyServerSystem();
    await serverSystem.start(initialAuthIndex);
  } catch (error) {
    console.error("❌ 服务器启动失败:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeServer();
}

module.exports = { ProxyServerSystem, BrowserManager, initializeServer };
