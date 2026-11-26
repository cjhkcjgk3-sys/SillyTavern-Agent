# A 阶段实验复现

从主项目根目录执行。用只监听回环地址的独立 SillyTavern 实验数据，保留默认 CSRF。两个实例的数据文件、浏览器状态及模型响应均为测试夹具。测试脚本会创建并修改名为 `Research A Fiction` 、`Research A Large Book` 和 `Research A Two Writers` 的世界书。这里使用 Node.js 24.22.3、npm 11.19.1、Playwright Chromium Headless Shell 141.0.7390.37 和 SQLite 3.54.1。

## 原生基线

```bash
git rev-parse HEAD
npm ci --no-audit --no-fund
npm ci --no-audit --no-fund --prefix tests
(cd tests && npx playwright install chromium)
A_RESEARCH_ROOT="$(mktemp -d)"
node server.js --configPath "$A_RESEARCH_ROOT/baseline.yaml" \
  --dataRoot "$A_RESEARCH_ROOT/baseline" --port 18766 --browserLaunchEnabled false
```

服务出现监听提示后，在另一终端执行以下命令。每次新跑保留原始结果与实际版本。

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18766/
npm run lint
npm run test:unit --prefix tests -- --runInBand
ST_BASE_URL=http://127.0.0.1:18766 npm run test:e2e --prefix tests -- --reporter=line
ST_BASE_URL=http://127.0.0.1:18766 npm run test:e2e --prefix tests -- \
  frontend/ReasoningHiddenBlocks.e2e.js --workers=1 --reporter=line \
  --grep 'confirming message edit with reasoning edit open|changing whitespace-only reasoning to visible content|changing whitespace-only reasoning to different whitespace'
```

## 真实宿主与本地 API 桩

在同一终端保存实验根目录变量，或为它指定另一个新目录。`git archive` 仅导出加载需要的四个文件。本仓库源码与工作台源码均可用原样。测试桩固定绑定 18768。

```bash
A_RESEARCH_ROOT="$(mktemp -d)"
git clone https://github.com/cjhkcjgk3-sys/sillytavern-worldbook-workbench.git "$A_RESEARCH_ROOT/workbench"
git -C "$A_RESEARCH_ROOT/workbench" checkout --detach 13c5258214f08be88c97ae75f360761b3f94dfdc
npm test --prefix "$A_RESEARCH_ROOT/workbench"
mkdir -p "$A_RESEARCH_ROOT/lab/default-user/extensions/workbench"
git -C "$A_RESEARCH_ROOT/workbench" archive HEAD index.js core.js style.css manifest.json \
  | tar -x -C "$A_RESEARCH_ROOT/lab/default-user/extensions/workbench"
node server.js --configPath "$A_RESEARCH_ROOT/lab.yaml" \
  --dataRoot "$A_RESEARCH_ROOT/lab" --port 18767 --browserLaunchEnabled false
```

另开终端，从主项目根执行：

```bash
node docs/research/A/verification/host.mjs
node docs/research/A/verification/viewport.mjs
node docs/research/A/verification/concurrency.mjs
```

`host.mjs` 使用真实宿主的 `Generate`、ToolManager、扩展和世界书 API。测试运行将工具递归深度设成 10，以覆盖一轮七次工具操作，并固定显示连接有效，避免初始自动连接状态干扰桩调用。审批以已注册按钮的事件验证，界面可见性由另一脚本测量。Vertex 从相同宿主的 HTTP 生成端点进入，前端能力函数另有实测，Authorization 只有合成值且未写入留存请求记录。保存失败用合成 HTTP 响应注入。可设 `ST_PROBE_DEBUG=1` 观察浏览器细节。保留版日志中的提案 ID 和修订凭证以合成占位符表示。

## 机制原型与候选

```bash
node --test docs/research/A/verification/mechanisms.test.mjs
A_MCP_PREFIX="$(mktemp -d)"
npm install --prefix "$A_MCP_PREFIX" --save-exact --no-audit --no-fund @modelcontextprotocol/sdk@1.32.2 zod@4.1.12
ST_RESEARCH_MCP_PREFIX="$A_MCP_PREFIX" node docs/research/A/verification/mcp.mjs
```

SQLite 原型会在临时目录使用文件与两个独立子进程，处理退出前后的数据库状态。外部存储部分失败用合成对象模拟。模型调用是本机服务的预定答复。Token 统计使用主仓依赖 tiktoken，并保留不同分词器的结果。MCP 用内存传输和虚构资料。

兄弟插件和 Android 构建计划在各自固定克隆运行：

```bash
# 世界书更新器 3abfc35680d0f2d5287019a3d497e2d5c80a53e7
npm test
# Novel Auto Generator 1a54376aa92fda1b24ca6cb4fc2f4aa47d318f8a
npm ci --no-audit --no-fund
npm test
# SillyDroid 725b5938ab17e1f8181b375affc4a23588f8845b
bash scripts/resolve-tavern-build-plan.sh --tavern-tag 1.19.1 --build-type debug
```

真实 Vertex 和 Android 的续验条件见测试报告 T13、T14。实验完成后可停止两个本地实例并清理本次创建的临时目录。
