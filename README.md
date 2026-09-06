# luci-app-monitor

[English](README_EN.md)

luci-app-monitor 是一个只读的 OpenWrt/ImmortalWrt LuCI 实时监控插件。安装后可在
“状态 -> 路由器监控”打开页面。

## 功能

- 默认每 3 秒异步刷新 CPU、内存和网络数据；页面顶部可立即调整为 1–60 秒。
  刷新间隔不持久化，重新打开页面后恢复为 3 秒。
- CPU 使用率由 /proc/stat 的聚合计数器计算，支持多核心 CPU。
- 内存使用率仅计算物理内存的 (total - free) / total，不包含 Swap。
- 安装并检测到 lm-sensors 时显示传感器名称和摄氏温度；没有有效传感器时不显示。
- 顶部下载/上传只汇总防火墙中名为 wan 的区域。每个有效底层设备只计算一次，
  RX 为从上游接收的下载，TX 为向上游发送的上传。
- 线路表枚举 netifd 接口及 Linux 底层网络设备，包括物理网卡、网桥、VLAN、
  PPP、WireGuard、TUN、TAP、GRE 和 VETH 等有字节计数器的设备。
- 已连接线路的状态下方显示 IPv4 地址。合并行列出各已连接逻辑接口的地址并
  标注接口名；PPP 地址与底层管理地址分别显示。未绑定逻辑接口的设备显示自身
  地址。没有 IPv4、连接中或未连接时只显示状态，不显示 IPv6 或残留地址。
- 状态右侧的“连接数”统计当前 conntrack 表中 TCP、UDP 等双向会话，包含仍被
  跟踪的 TIME_WAIT 等状态。同一会话在一条线路中只计一次，经过不同线路时可
  分别计数；它不是在线终端数量，各行也不能直接相加作为全局连接数。
- 连接归属使用原始和回复方向的地址、NAT 地址及接口网段。桥成员端口、重叠
  网段和无法确定出口的转发会话等不完整归属显示 `-`，断开线路显示 `0`。
  数据经 LuCI 原生直接读取接口获取完整连接表，不受普通 RPC 小文件读取限制。
- 线路表中的 RX、TX、累计 RX 和累计 TX 是对应设备的 Linux 原始方向。
  这对所有设备保持一致；LAN 网桥行不会改写成以局域网用户视角解释的方向。
- 速率按 KB/s、MB/s、GB/s 自动格式化，总量按 KB、MB、GB、TB 自动格式化，
  均保留两位小数。连接开始时间使用路由器时区。

数据来自本次路由器启动后的内核计数器。插件没有守护进程、数据库、配置文件或
持久化历史。

## 从源码编译

先检出与路由器固件家族和版本相同的 OpenWrt 或 ImmortalWrt 完整源码，并完成该
源码树要求的 feeds 与编译环境初始化。然后在源码根目录执行：

~~~sh
git clone https://github.com/haitun001/luci-app-monitor.git package/luci-app-monitor
./scripts/feeds update -a
./scripts/feeds install -a
make defconfig
make package/luci-app-monitor/clean \
  CONFIG_PACKAGE_luci-app-monitor=m \
  CONFIG_PACKAGE_luci-i18n-monitor-zh-cn=m
make package/luci-app-monitor/compile V=s \
  CONFIG_PACKAGE_luci-app-monitor=m \
  CONFIG_PACKAGE_luci-i18n-monitor-zh-cn=m
find bin/packages -type f \( -name 'luci-app-monitor*' -o -name 'luci-i18n-monitor-zh-cn*' \)
~~~

主包和简体中文语言包会一起生成。请勿在 OpenWrt 源码树中使用 ImmortalWrt 的
Release 包，反之亦然。

## 从 Release 安装

在 [Releases](https://github.com/haitun001/luci-app-monitor/releases) 中选择与
固件家族和系列完全一致的两个文件：luci-app-monitor 主包和
luci-i18n-monitor-zh-cn 简体中文包。

| Release 前缀 | 包格式 |
| --- | --- |
| openwrt-24.10.8 | IPK |
| openwrt-25.12.5 | APK |
| openwrt-snapshot | APK |
| immortalwrt-24.10.6 | IPK |
| immortalwrt-25.12.1 | APK |
| immortalwrt-master | APK |

### ImmortalWrt 25.12.1 一键安装或覆盖升级

在已安装 LuCI 的 ImmortalWrt 25.12.1 路由器上以 root 执行以下一条命令。
它从 GitHub 下载 v0.4 主包和简体中文包到独立的 /tmp 临时目录，核对两个包的
SHA-256 后允许未受信任签名并覆盖安装已有版本。成功、失败或收到可捕获的
中断信号时都会清理本次下载的文件，不匹配 /tmp 中的其他 APK。

~~~sh
(set -eu; dir=$(mktemp -d /tmp/luci-monitor-v0.4.XXXXXX); trap 'rm -f "$dir"/*.apk "$dir/SHA256SUMS" "$dir/CHECKSUMS"; rmdir "$dir"' EXIT; trap 'exit 1' HUP INT TERM; cd "$dir"; base=https://github.com/haitun001/luci-app-monitor/releases/download/v0.4; app=immortalwrt-25.12.1-luci-app-monitor-0.4-r1.apk; zh=immortalwrt-25.12.1-luci-i18n-monitor-zh-cn-0.4-r1.apk; for file in "$app" "$zh" SHA256SUMS; do wget -T 60 -O "$file" "$base/$file"; done; awk -v a="$app" -v z="$zh" '$2==a || $2==z {count[$2]++; print} END {exit(count[a]!=1 || count[z]!=1)}' SHA256SUMS > CHECKSUMS; sha256sum -c CHECKSUMS; apk add --allow-untrusted --force-reinstall --no-network --repositories-file /dev/null "$dir/$app" "$dir/$zh")
~~~

命令需要能通过 HTTPS 访问 GitHub。只绕过包签名信任检查，仍校验 HTTPS 和
SHA-256；不修改软件源，不升级其他软件，也不使用 --force-depends。

其他固件先下载对应前缀的两个包，用 SHA256SUMS 核对后传到独立临时目录。
24.10 使用 `opkg install`，25.12、Snapshot 和 master 使用
`apk add --allow-untrusted`，后面明确列出这两个本地文件的路径。安装完成后
仅删除这两个文件和自行创建的临时目录，不混用不同固件家族或系列的产物。

安装后刷新或重新登录 LuCI，在“状态 -> 路由器监控”查看。

## 支持范围与验证

- 支持带 LuCI 的 OpenWrt 和 ImmortalWrt 24.10 及更新系列。
- v0.4 的 CI 构建 OpenWrt 24.10.8、25.12.5、Snapshot，以及
  ImmortalWrt 24.10.6、25.12.1、master。
- 主包为 all、APK 对应 noarch；网络架构通常不限制安装，但固件家族、发行系列
  和包管理器必须匹配。
- v0.4 以指定的 x86_64 ImmortalWrt 25.12.1 路由器为实机验证目标，覆盖中英文
  桌面和移动页面、IPv4 地址归属、只读权限、连接数、流量方向、刷新周期、焦点保持及 8 分钟
  3 秒间隔持续运行。其他目标按 SDK 构建验证，不宣称经过本版实机验证。
- 连接数仅保留本次刷新所需的数据。累计接收和发送仍是设备自本次开机以来的
  计数，不在断线后重新累计；本版未修改 LuCI 登录会话机制。
- sensors 命令是可选探测；没有安装 lm-sensors 或没有温度传感器不会影响其余功能。

## 发布维护

发布新版本时修改 Makefile 中的 PKG_VERSION（需要时递增 PKG_RELEASE），提交并
推送 main，等待六个 CI 构建全部通过，再推送与 PKG_VERSION 一致的 v* 标签，并在
CHANGELOG.md 中提供同版本发布日志。标签工作流会重新构建 12 个包、生成
SHA256SUMS，并使用对应日志创建 GitHub Release。

本地逻辑检查使用 `node tests/monitor-unit.js`；带 POSIX shell 的环境使用
`node tests/install-command.js` 检查安装命令的校验与失败清理。真实页面检查使用
`tests/router-e2e.js`，通过环境变量提供路由器地址、登录信息、Chrome 路径和
仓库外的输出目录；默认浸泡 8 分钟。实机安装必须选择与固件系列匹配的分支
构建产物，并在验证通过后才创建发布标签。

## 许可证

[Apache License 2.0](LICENSE)
