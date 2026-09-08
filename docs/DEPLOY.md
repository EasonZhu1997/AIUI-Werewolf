# 公网部署

浏览器和眼镜需要连接同一台游戏服务：网页使用 HTTPS，眼镜使用 WSS。本文示例域名 `your-domain.example` 和 IP `203.0.113.10` 都是占位符，请替换成自己的地址。

服务需要 Node.js 20+（推荐 22+），默认监听 `127.0.0.1:8790`。以下以 Linux、systemd 和 Nginx 为例，域名解析与 HTTPS 证书需由部署者配置。

## 1. 安装运行文件

将以下文件放入服务器的 `/opt/aiui-werewolf/`，保持目录结构：

- `server/`、`web/`、`admin/`
- `lib/client.js`
- `package.json`、`package-lock.json`

在该目录安装运行依赖：

```sh
npm ci --omit=dev --ignore-scripts
```

使用独立服务账号运行 Node；下方示例账号为 `werewolf`，需事先创建并授予代码与配置的读取权限。不要把整个源码目录直接作为 Nginx 静态根目录。

## 2. 配置模型

在 `/etc/aiui-werewolf/provider.env` 写入自己的 `DEEPSEEK_API_KEY`，仅允许管理者和服务账号读取。在 `/etc/aiui-werewolf/config.json` 创建：

```json
{
  "host": "127.0.0.1",
  "port": 8790,
  "deepseekEnvFile": "/etc/aiui-werewolf/provider.env",
  "model": "deepseek-v4-flash"
}
```

环境文件读取器仅提取 `DEEPSEEK_API_KEY`，不执行 Shell 命令。密钥不进入客户端、AIX 或公开仓库。`DEEPSEEK_ENV_FILE`、`DEEPSEEK_MODEL`、`HOST` 和 `PORT` 可覆盖相应配置；管理后台按[后台说明](ADMIN.md)单独启用。

## 3. 使用 systemd

创建 `/etc/systemd/system/werewolf.service`，根据实际安装位置调整 Node 路径和服务账号：

```ini
[Unit]
Description=AIUI Werewolf
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=werewolf
Group=werewolf
WorkingDirectory=/opt/aiui-werewolf
Environment=NODE_ENV=production
Environment=WEREWOLF_CONFIG=/etc/aiui-werewolf/config.json
ExecStart=/usr/bin/node /opt/aiui-werewolf/server/index.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now werewolf.service
curl --fail http://127.0.0.1:8790/werewolf/health
```

健康接口应返回 `ok: true`、`aiConfigured: true` 和当前版本。`aiConfigured` 表示已配置模型客户端，不代表密钥有效或账户有额度；真实请求可按[测试说明](TESTING.md)验证。

仓库也提供 [systemd 模板](../deploy/werewolf.service)，其中默认账号是 `ubuntu`；直接使用前需按自己的环境调整。

## 4. 配置 Nginx

把 [werewolf-location.conf](../deploy/werewolf-location.conf) 的内容加入自己的 HTTPS `server` 块：

```nginx
location = /werewolf {
    return 308 /werewolf/;
}

location /werewolf/ {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
    proxy_buffering off;
}
```

```sh
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://your-domain.example/werewolf/health
```

网页入口为 `https://your-domain.example/werewolf/`，WebSocket 为 `wss://your-domain.example/werewolf/ws`。网页自动使用同源地址；眼镜需在本地工程重新配置并构建：

```sh
node tools/configure.mjs wss://your-domain.example/werewolf/ws
npm run build
npm run export:agent
```

最后用不同网络的设备进入同一房间，检查发言、投票和重连。健康检查成功不能替代 WSS 与实际设备验证。

## 可选：首次安装工具

`tools/deploy-remote.py` 是针对特定目录结构的首次安装器，不是通用升级工具。仅在以下条件都满足时使用：

- 目标 Linux 已有 `ubuntu` 用户、`/usr/bin/node`、`/usr/bin/npm`、systemd 和 Nginx。
- 已有可用的 HTTPS 虚拟主机及至少一个同域健康接口。
- `/opt/aiui-werewolf`、`/etc/aiui-werewolf` 整个目录、对应 systemd 服务和 Nginx snippet 均不存在，8790 端口空闲。
- 模型环境文件已放在新配置目录之外，例如 `/etc/werewolf-provider.env`，且 `ubuntu` 可读取。

不符合时使用上方手动部署流程。尤其不要为了预放密钥而创建 `/etc/aiui-werewolf/`，否则首次安装器会拒绝执行。

在本地复制并编辑部署计划，替换主机、域名、虚拟主机路径、模型环境文件路径和已有健康接口：

```sh
mkdir -p verification
cp deploy/plan.example.json verification/deploy-plan.json
```

在目标服务器只读获取虚拟主机摘要，例如：

```sh
sha256sum /etc/nginx/sites-available/werewolf
```

回到本地，将实际摘要传给准备工具：

```sh
python3 tools/prepare-deploy.py \
  --plan verification/deploy-plan.json \
  --vhost-sha256 REPLACE_WITH_64_CHARACTER_SHA256
```

输出为 `verification/deploy-ready/werewolf-runtime.tar.gz` 和 `werewolf-deploy.json`。准备工具只生成本地文件，不连接服务器；归档使用运行文件白名单，不包含环境文件、私有配置、AIX 或测试记录。

将这两个产物和 `tools/deploy-remote.py` 传至目标主机的临时目录，再在**目标 Linux** 上执行：

```sh
sudo python3 /tmp/deploy-remote.py \
  --archive /tmp/werewolf-runtime.tar.gz \
  --plan /tmp/werewolf-deploy.json
```

默认只做预检。检查输出及目标配置后，添加 `--execute` 执行首次安装。安装器校验归档与虚拟主机摘要，启动服务后检查本地和公网健康接口；失败时尝试恢复 Nginx 并移除本次新增内容。若恢复失败，会保留文件供排查。

## 运行与升级

默认支持 12 个数字房间和 1 个公共大厅、72 条连接；每个进程每小时最多 600 次 AI 请求。四位房号用于分桌，不提供密码保护，公开服务的玩家会使用服务端的模型额度。

牌局、座位恢复凭证和后台指标都在单进程内存中。全员离线时暂停，约 30 分钟后清理；重启会清空牌局。升级前安排正在进行的游戏，保留旧源码、服务配置和 Nginx 配置，以便恢复。多进程扩容需要先实现共享房间状态。
