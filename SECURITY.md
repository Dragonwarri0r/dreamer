# 安全说明

Dreamer 当前是单用户本地工作台。Host 只监听回环地址，校验 Host、同源 Origin、会话 Cookie 与写入 CSRF；这不等于公网账号鉴权。不要直接通过反向代理、隧道或端口映射公开现有 Host。

同一操作系统用户下的进程、浏览器会话和文件访问并非相互隔离的安全租户。体验 UID 是内容与存档范围标识，不是登录凭据；需要公网使用时，应先设计真实身份、授权、速率限制和部署边界。

## 凭据与发布

- 视频 Key 以 0600 文件保存于数据根的 `credentials/`，GET 不回传 Key；本机用户仍可读取明文。
- Agent 运行时可能包含指向个人登录文件的符号链接，不能复制整个工作区、解引用链接或上传运行日志。
- 不提交 `.env.local`、`.local/`、`data/`、数据库、备份、导出、模型或个人作品。`.gitignore` 不能移除已有提交中的数据。
- `.gitignore` 仅放行根目录已审阅的 `.env.example`；不要因为文件名带 example 就写入真实 Key。本机 MCP、云视频配置、token JSON、SSH 私钥和编辑器本地配置均应留在忽略范围内。历史文件按已有公开白名单排除，原件仍保留在本地。
- 提交前运行 `npm run source:check`：检查公开白名单、工作树、Git 暂存区和所有未被忽略的未跟踪文件。白名单外的可提交文件会报错；新公开文件需同时审核 `config/public-source.json` 和忽略规则。检查输出只给路径、行号和规则，不打印疑似密钥值。这是有限模式检查，不能替代 Gitleaks 等专用扫描和人工复核。
- 忽略规则按路径生效，无法阻止把 Key 硬编码到正常源码里；`git add -f` 也能绕过忽略规则。本地检查并未安装为强制 Git hook，不应跳过提交前检查。
- 真正发布前对全部分支、标签与历史运行专用密钥扫描；GitHub 仓库应启用 secret scanning / push protection，并核查配置是否实际生效。
- 如果发现已泄露的 Key，先撤销或轮换，再清理历史；仅删除当前文件不够。见 [GitHub 泄漏处置说明](https://docs.github.com/en/code-security/tutorials/remediate-leaked-secrets/remediating-a-leaked-secret)。

## 报告漏洞

仓库为 [Dragonwarri0r/dreamer](https://github.com/Dragonwarri0r/dreamer)。目前维护 `main` 上的早期版本。如果仓库 Security 页面提供私密漏洞报告入口，请优先使用；该功能是否启用由仓库管理员控制。尚无入口时，可先提交不含漏洞细节的 Issue，请维护者提供私密沟通方式。不要在公开 Issue 粘贴 Key、完整数据库、登录文件、私有作品或可被滥用的详细攻击步骤。

CI 对 Git 历史运行固定版本 Gitleaks，并执行公开白名单检查。GitHub 账户侧的 secret scanning / push protection 设置仍需管理员核对；CI 检查不能替代推送前扫描。

依赖风险与当前未完成事项见 [开源审计](docs/open-source-audit.md)。
