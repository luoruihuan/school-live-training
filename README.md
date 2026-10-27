# 校园直播实训平台（School Live Training）

面向学校内部的直播电商教学平台：管理员统一管理账号，教师用 OBS 在电脑端推流开课，学生在网页观看直播、聊天互动、领优惠券并用积分兑换小黄车商品，支持自提/送货与直播回放。不接真实支付与物流，适合作为校园实训环境。

前端 React 19 + Ant Design 6，后端 NestJS + Prisma + MySQL，直播与存储基于自托管 SRS + MinIO。学生端 `http://127.0.0.1:5173/`，管理端 `http://127.0.0.1:5173/admin`。

## 功能特性

- **账号体系**：管理员后台统一创建师生账号、重置密码、停用启用；首次登录强制修改初始密码，改密后旧会话全部失效
- **直播教学**：管理端一键生成限时 OBS 推流地址（HMAC token 鉴权）；学生端 FLV/HLS 播放，直播状态由 SRS 回调自动流转
- **课堂互动**：WebSocket 实时聊天，支持禁言、消息隐藏，草稿课堂对学生不可见
- **积分电商**：积分商品、自提点、直播间优惠券；小黄车加购，事务化积分兑换（幂等防重复扣分），默认自提或填送货地点，订单可标记完成
- **积分管理**：管理员增加/扣减/设置余额，需二次验密码，全量流水分页可查
- **直播回放**：SRS 录制回调自动上传 MinIO，登录后经 API 流式播放（支持拖动），默认保留 6 个月（180 天，可配）并定时清理
- **流量管控**：年度直播流量额度台账与阈值预警，超额阻断新直播地址

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、Ant Design 6、Less、Vite |
| 后端 | NestJS、Prisma、MySQL 8+ |
| 实时通信 | Socket.IO |
| 直播服务 | SRS（自托管，RTMP 推流 + HTTP-FLV/HLS 播放 + DVR 录制） |
| 对象存储 | MinIO（自托管，S3 兼容；商品图与回放 MP4） |

## 目录结构

```text
├── apps/api    # NestJS API、Prisma 数据模型与数据库初始化入口 npm run db:init
├── apps/web    # React 学生端与管理端网页
├── deploy      # 生产部署的 Nginx 模板、备份与证书续期配置
├── scripts     # 数据库备份、证书部署脚本
└── compose.production.yaml  # MySQL、API 与网页容器编排
```

## 快速开始（本地开发）

1. 安装 Node.js ≥22.12、npm 和 MySQL 8+，确认本机 MySQL 正在运行。
2. 执行 `cp .env.example apps/api/.env`，填写本机 MySQL 的 `DATABASE_URL`、管理员邮箱与密码。密码必须至少 16 位，不能使用示例值。数据库请单独使用空的 `live_training_points`，不要指向已有业务库。
3. 执行 `npm install`。
4. 使用有权限的 MySQL 账号创建空库：`CREATE DATABASE live_training_points CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`。
5. 执行 `npm run db:generate`、`npm run db:init`。初始化入口只对空库建表；已有库须与当前模型完全一致，否则停止，不做自动迁移。初始化仅创建管理员账号，师生账号与业务资料由管理员在后台添加。
6. 分别执行 `npm run dev -w apps/api` 与 `npm run dev -w apps/web`，打开 Vite 输出的本地地址，使用初始化管理员账号登录。

本地浏览器默认从 `http://127.0.0.1:5173` 访问；若改用其他前端地址，请在 API 环境配置 `APP_ORIGIN` 为该地址（含协议和端口），否则写入请求与互动连接会被拒绝。Docker 部署会根据 `APP_DOMAIN` 自动设置允许来源；生产环境请设置 `COOKIE_SECURE=true`。调整积分时需再次输入管理员登录密码。API 的 `dev` 命令会先编译后运行；修改后端源码后需重启 API。

## 直播与存储（SRS + MinIO 自托管）

直播与存储全部自托管，不依赖外部云服务：

- **SRS**（`deploy/srs/srs.conf`）：OBS 推流到 `rtmp://域名:1935/live/{streamName}`（管理端生成带 HMAC token 的限时地址）；观看经 nginx 反代 `https://域名/live/{streamName}.flv|.m3u8`；录制（DVR）结束后回调 API 自动上传回放。需在云防火墙/安全组放行 **TCP 1935**（推流）。
- **MinIO**：S3 兼容对象存储，存商品图与回放 MP4，仅容器网络可达（不对外暴露端口）；回放播放经 API 登录校验后流式转发（支持 Range 拖动）。
- **回放清理**：API 每 6 小时清理超过 `RECORDING_RETENTION_DAYS`（默认 180 天）的回放对象与记录。
- 敏感配���（`SRS_SECRET`、`MINIO_ROOT_USER/PASSWORD`）只保存在服务端 `deploy/.env`，教师在管理页面复制限时推流地址交给 OBS 使用。

## 运行模式与功能边界

- 学生端 `/` 仅供学生使用，管理端 `/admin` 仅供教师和管理员使用；页面不提供跨入口跳转，同一域名下两个入口共享登录会话。
- 商品使用管理员发放的积分兑换，支持自提或填写送货地点；**不接真实支付、退款、库存锁定和物流接口**，送货为订单信息与线下交付流程。
- 自动账单同步、外部通知、多租户和班级分权不在当前范围；单实例部署。
- 本地开发时可用本地 MP4 预览观看界面：先创建一间课堂，在管理端「配置本场」点击「用桌面 MP4 预览」，或在课堂地址后加 `&mock=1`。Vite 仅在开发服务器提供该文件（可用 `MOCK_VIDEO_PATH` 指定本地 MP4 绝对路径），不进入正式构建，也不绕过 API 的真实推流、回放或额度校验；商品、优惠券和积分仍读取当前数据库。

## Docker 部署

使用 `compose.production.yaml` 与 `deploy/.env.example`（复制为 `deploy/.env` 后填写域名与密钥）编排 MySQL、API、网页、SRS、MinIO 容器，配套 `scripts/` 下的数据库备份与证书续期脚本、`deploy/` 下的 Nginx 模板与 SRS 配置。部署后需在云防火墙放行 TCP 1935（OBS 推流）。

## 安全设计要点

- 草稿课堂由服务端限制学生访问；跨站写请求与聊天连接来源受限。
- 积分调整需管理员密码二次核验并记录流水；订单与流水用「用户 + 请求标识」唯一约束防重复提交，同一标识不能换内容重放。
- 直播/断流/录制回调验签，按事件时间防止旧断流覆盖新开播；推流与播放地址均为限时签名。
- 密码 scrypt 哈希存储；登录限频；停用/重置即时失效全部会话并断开聊天连接。
- 健康检查验证数据库；学生订单分页，购物车和领券操作仅刷新相关数据。

## 开发与测试

```bash
npm run check   # TypeScript 类型检查（api + web）
npm run build   # 生产构建
npm test        # 基础测试（数据库集成测试默认跳过）
RUN_DB_TESTS=true npm test  # 启用真实数据库集成测试
```

启用数据库集成测试时使用测试专属随机账号/店铺，结束后只清理本次测试记录，不重置现有数据库。
