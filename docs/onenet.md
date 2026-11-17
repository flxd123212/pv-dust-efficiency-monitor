# OneNET 接入约定

## 本次新增属性

在 OneNET 产品的物模型中新增并保存/发布以下两个**只读属性**，然后烧录新版 HEX。
网关已支持自动上传，不需要重新配置 Token；设备密钥不等于产品物模型编辑权限，本次没有代你修改云端模型。

| 名称 | 标识符 | 类型 | 最小值 | 最大值 | 步长 | 单位/说明 |
|---|---|---|---|---|---|---|
| 人体活动 | personDetected | bool | 不适用 | 不适用 | 不适用 | false=未检测到活动；true=检测到活动 |
| 板面温度（NTC估算） | surfaceTemp | float | 20 | 80 | 0.1 | ℃ |

人体预热/不可用、NTC无效/越界/过期时不上传对应值。人体报警维修关闭后，活动检测仍照常上报。
原 `panelTemp` 继续为 SHT20 环境温度，不改成板温、不复制给 `surfaceTemp`。
NTC 当前按未核实的 10kΩ、B3950、上拉10kΩ模型换算，必须显示“估算”；接线和校准边界见 `ntc-temperature.md`。
若新增属性未发布而被云端拒收，网关显示异常，并回退上传原字段；每60秒尝试新增字段。
“设备设置→已确认字段”列出 OneNET 最近一次 code=200 真正确认的字段，原字段成功不等于新增字段成功。

## 范围

沿用 STM32 -> 已有 ST-Link USART6 -> 电脑网关 -> OneNET，不新增硬件。
产品 ID 和设备名来自本机私有配置，设备级密钥与 Token 不进入源码、网页或日志。
本次只做设备接入，不需要自建 MQTT 服务或云服务器。

## 冻结契约

- MQTT 3.1.1 + 校验证书的 TLS，官方地址 `mqttstls.heclouds.com:8883`。
  随工程保存官方公开证书。该证书无 DNS SAN，保留证书链/有效期校验，并仅为此固定官方端点
  校验官方叶证书的 SHA-256 指纹；不使用 rejectUnauthorized=false。更新依据见 platform/certs/onenet/README.md。
- clientId=设备名，username=产品ID，password=CHANGE_ME_LOCALLY
- Token version=2018-10-31，method=sha256，res=products/{pid}/devices/{name}。
  签名原文顺序为 et、method、res、version，用换行分隔；密钥先 Base64 解码。
  Token 参数值 URL 编码。默认有效期 24 小时，程序在过期前重连续签。
- 上报主题 `$sys/{pid}/{name}/thing/property/post`；结果主题为 `post/reply`。
  OneJSON 为 `{id,version:"1.0",params:{标识符:{value,time}}}`，id 为不超过 13 位的数字字符串。
- 仅上传协议 3 的设备遥测：current、panelTemp、rain、dustLevel、tiltAngle，以及有效的 personDetected、surfaceTemp。
  每通道有效位必须成立；未知雨滴、未标定积灰、无效温度不上传，不能填零或模拟值。
  默认每 5 秒合并上报一次；断云不缓存过期遥测，重连只发新鲜数据。
- 只有收到匹配 id 的 OneNET `code=200` 业务回复才记录上报成功；MQTT PUBACK 不代表属性入库。
  上报使用 QoS 0、不保留，以业务回复确认；网络中断期间不积压遥测，恢复后重新读取新鲜值。
- 属性设置主题 `thing/property/set`，回复 `thing/property/set_reply`，5 秒内返回。
  只支持 tiltAngle 的整数 0..90，映射到原有 angle 命令；包括新增人体活动和板温在内的其余属性只读。
  下发经 Hub/串口/固件同一入口执行，code=200 仅在真实设备 ACK applied=true 后返回。
  请求重试沿用同一内部 cmdId，离线、超时、越界明确失败，禁止保留消息回放。
- 属性获取主题 `thing/property/get`，回复 `thing/property/get_reply`。
  仅提供 5 秒内的有效测量，不返回零值或过期缓存冒充实时值。
- 人体与NTC板温新功能需要烧录本次固件；只更新网页不会在旧固件上生成板温。

## 使用边界

OneNET 的设备在线表示电脑上的 MQTT 网关已联网，不保证 STM32 或所有传感器都在线。
板子断连时不再上传；OneNET 可能保留最后一次值，手机应结合属性时间戳判断是否实时。
panelTemp 仍是 SHT20 环境温度，不是板面温度；tiltAngle 是 PWM 指令角度，不是轴位置反馈。
平台物模型的标识符、类型、范围、读写权限需与前述定义一致，并完成保存/发布。
云端属性查询和倾角控制不等于自动部署了手机页面；看板需在 OneNET 当前账户可用的可视化功能中配置。
新版固件的雨天联动在设备本地执行，OneNET 倾角下发同样不能绕过挡雨/收起保护及停止锁定。
停止锁定通过手机网页的“恢复联动”或 LCD RESUME 解除；本次不新增 OneNET 必填属性。

## 本机配置

本机私有 `platform/.env` 已存产品 ID、设备名和设备级密钥，不能提交或公开。
通用配置模板见 `platform/.env.example`。设置 PV_CLOUD_PROVIDER=onenet，保持 PV_ROLE=gateway，
不设置模拟模式；网关连接时自动生成 Token，每次重连重签，并在到期前一分钟主动重连。
同一个设备名不要同时启动第二个 MQTT 客户端，否则双方会互相挤下线。

如需在 MQTT 调试工具中手填 Token，在 platform 目录执行：

```powershell
npm run token:onenet
```

完整 Token 写入本机 `platform/data/onenet-token.secret`，有效期 24 小时，命令输出显示北京时间到期时刻。
调试工具填写：Client ID=平台设备名、Username=产品 ID、Password=CHANGE_ME_LOCALLY
使用官方 TLS 地址与证书。Token 是密码，不是应公开的普通配置字符串，也不是 OneNET 控制台登录密码。
需要手工调试时先停止网关，避免设备 ID 冲突；网关运行不读取此手动文件，而是在内存自动续签。

正常启动仍用 tools/start-platform.ps1 或 platform 目录的 npm start。设备设置显示
云连接状态和平台确认时间；只有最近收到的协议 3 真机数据会被上传。
没有串口设备、传感器无效或物模型尚未发布时，不能用测试值代替。

## 官方依据

- https://open.iot.10086.cn/doc/v5/fuse/detail/919 ：MQTT 连接及服务地址。
- https://open.iot.10086.cn/doc/v5/fuse/detail/1486 ：Token 签名算法。
- https://open.iot.10086.cn/doc/v5/fuse/detail/902 ：属性上报、设置、获取与 5 秒回复期限。
- https://open.iot.10086.cn/doc/v5/fuse/detail/922 ：OneJSON 物模型接入流程。

## 验收

测试先使用本地测试密钥和模拟 MQTT 服务验证鉴权、上报回执、真实固件 ACK 对账、拒绝与重试。
生产验证仅连接用户指定设备和上传真实遥测，不主动下发物理动作，不向生产 OneNET 发送测试温度或假雨滴。
界面分别显示云连接、平台上报确认和本地设备在线状态；账号配额和计费以 OneNET 实际账户为准。

2026-11-07 验证记录：OneNET 官方 TLS/Token 鉴权及三个标准主题订阅成功；
14 项后端测试、3 项浏览器测试通过，另检查了实际网关的手机/桌面待数据界面。
用户未携带开发板，电脑未发现串口，因此未验证生产属性上报、真实 OneNET 属性回执或实物远控。
当前未向生产 OneNET 上传模拟测量，未主动发送任何实物动作命令。
