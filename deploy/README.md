# 云端部署

这是可部署配置，不表示已经部署。当前没有你的域名、云服务器和 MQTT 账号。
本方案不增加硬件，但开发板旁的电脑网关需要保持运行和联网。

## 准备

- 一台可运行 Docker Compose 的云服务器，以及指向它的域名。
- 一个支持 MQTT/TLS 的 broker，端口通常为 8883，证书必须可验证。
- 两个独立账号：网关账号与云端账号；为设备 PV01 设置下列 ACL。
- 防火墙只开放 HTTPS 所需的 80/443；不要公开应用内部的 8787 端口或匿名 MQTT。

| 账号 | 允许发布 | 允许订阅 |
|---|---|---|
| gateway-PV01 | pv/PV01/data、pv/PV01/ack、pv/PV01/presence | pv/PV01/cmd |
| cloud-PV01 | pv/PV01/cmd | pv/PV01/data、pv/PV01/ack、pv/PV01/presence |

禁止跨设备通配符访问。命令发布必须 retain=false；固件链路拒绝超时命令，网关拒绝重连时收到的 retained 命令重放。
MQTT 3 的 broker 会清除实时转发报文的 retain 标志，因此不能靠订阅方识别所有实时 retained 发布。
生产环境同时依赖发送端 retain=false、账号隔离和 broker 的 retained 策略，不能使用公共匿名 broker。

## 云端

将 `deploy/.env.example` 的示例值配置到私有 `deploy/.env` 或部署环境。
`PV_PASSWORD` 至少 12 字符；broker 密码不是网页登录密码。

```sh
docker compose --env-file .env up -d --build
docker compose logs -f pv
```

在 `deploy` 目录运行。Caddy 自动申请 HTTPS 证书。首次证书申请需要正确的 DNS 和可访问的 80/443。
手机访问 `https://你的域名`，用 `PV_PASSWORD` 登录。

## 本地电脑网关

设置 `platform/.env`（已被 Git 忽略）：

```ini
PV_ROLE=gateway
PV_DEVICE_ID=PV01
PV_PORT=8787
PV_MQTT_URL=mqtts://你的broker:8883
PV_MQTT_USERNAME=网关账号
PV_MQTT_PASSWORD=CHANGE_ME_LOCALLY
```

运行 `npm start`，在网页选择 USB 串口。`PV_DEVICE_ID` 必须与云端一致。
串口遥测 -> 网关 -> broker -> 云端 -> 手机；手机指令沿相反方向下发并等待设备 ACK。
网关/云端断开时不会返回假成功。云端仅在收到新鲜、合法遥测时显示设备在线。

## 验收

1. 本地网页已能显示真实设备数据和控制，并且有设备 ACK。
2. 本地“云端 MQTT”与云服务日志显示连接成功。
3. 手机关闭 Wi-Fi、使用移动网络访问 HTTPS 域名，确认实时数据仍更新。
4. 调整一个安全的倾角，确认真实舵机动作、设备上报改变、审计中 ACK 一致。
5. 断开设备 USB，确认云端离线且控制锁定；接回后自动恢复遥测。
6. 断开电脑网络，设备本地的雨天/定时停止保护仍生效。

应用数据位于 Docker 卷 pv-data。定期备份 SQLite 数据和网页登录密码，限制云服务器和 broker 账号访问。
当前环境未安装 Docker，因此这里的镜像构建和公网 HTTPS 证书申请未在本机执行；已用本地 broker 测试 MQTT 全链路。
