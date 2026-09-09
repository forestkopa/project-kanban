// AI 超时配置回归：
//   - LM Studio 等本地小模型单步推理可能 10~30s，整轮 agent 循环（推理→工具调用→再推理）累计可能 90s+
//   - 前端默认 api() 超时只有 15s，会在 agent 还在跑时强制 abort → 用户看到误导性"请求超时，请重试"
//   - 必须把 aiRun 调用 /ai/agent 的 timeout 抬到 ≥ 后端调 LM Studio 的 120s
// 不依赖真实 LLM：只断言前端代码字面常量 + 调用点的 timeout 透传。
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log('  \x1b[32mPASS\x1b[0m ' + msg); }
  else { failed++; console.error('  \x1b[31mFAIL\x1b[0m ' + msg); }
}

const APP = path.resolve(__dirname, '../public/app.js');
const src = fs.readFileSync(APP, 'utf8');

// 1. aiRun 应把 timeout 显式 ≥ 120000 透传（与后端 server.js 调 LM Studio 的 120000 对齐，留余量）
const m = src.match(/const AI_AGENT_TIMEOUT_MS\s*=\s*(\d+)/);
check(!!m, 'aiRun 定义了 AI_AGENT_TIMEOUT_MS 常量');
const aiMs = m ? Number(m[1]) : 0;
check(aiMs >= 120000, 'AI_AGENT_TIMEOUT_MS ≥ 120000ms（与后端 LM Studio 超时对齐）');
check(aiMs <= 300000, 'AI_AGENT_TIMEOUT_MS ≤ 300000ms（避免挂死太久，最多 5 分钟）');

// 2. aiRun 调用 /ai/agent 时必须显式透传 timeout
check(/timeout:\s*AI_AGENT_TIMEOUT_MS/.test(src), 'aiRun 调 /ai/agent 透传 timeout: AI_AGENT_TIMEOUT_MS');

// 3. aiSummarize 调用 /ai/summarize 时也应显式透传 timeout（至少 30s，本地模型单步也可能有几秒）
check(/\/ai\/summarize[\s\S]{0,200}timeout:\s*\d+/.test(src), 'aiSummarize 调 /ai/summarize 透传 timeout');

// 4. 错误文案：超时分支必须有"本地模型"或"换云端"提示，引导用户找到根因（不再是空泛的"请重试"）
check(/AbortError[\s\S]{0,200}本地小模型|AbortError[\s\S]{0,200}LM Studio|AbortError[\s\S]{0,200}云端/.test(src), '超时错误文案提示"本地模型/换云端"（引导用户找根因）');
// 反向断言：旧的误导文案"请求超时（"+ms+"ms），请重试"必须移除
check(!/请求超时（\$\{ms\}ms），请重试/.test(src), '旧文案"请重试"已移除（不再误导）');

// 5. aiRun 调 /ai/agent 默认 api() 调用应包含 method/body/timeout 三要素，不漏
const aiRunSection = src.match(/async function aiRun[\s\S]*?bubble\.innerHTML = mdToHtml/);
check(!!aiRunSection, '找到 aiRun 函数体（用于上下文检查）');
if (aiRunSection) {
  check(/method:\s*'POST'/.test(aiRunSection[0]), 'aiRun 用 POST 调 /ai/agent');
  check(/body:\s*JSON\.stringify/.test(aiRunSection[0]), 'aiRun 带 body 到 /ai/agent');
  check(/timeout:\s*AI_AGENT_TIMEOUT_MS/.test(aiRunSection[0]), 'aiRun 显式带 timeout 到 /ai/agent');
}

console.log(`\nAI 超时配置回归结果: ${passed} 通过, ${failed} 失败`);
process.exitCode = failed ? 1 : 0;
