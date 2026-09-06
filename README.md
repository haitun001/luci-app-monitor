# luci-app-monitor

[English](README_EN.md)

luci-app-monitor 是一个只读的 OpenWrt/ImmortalWrt LuCI 实时监视器。安装后可在
“状态 -> 监视器”打开页面。

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
- 状态右侧的“连接数”统计当前 conntrack 表中 TCP、UDP 等双向会话，包含仍被
  跟踪的 TIME_WAIT 等状态。同一会话在一条线路中只计一次，经过不同线路时可
  分别计数；它不是在线终端数量，各行也不能直接相加作为全局连接数。
- 连接归属使用原始和回复方向的地址、NAT 地址及接口网段。桥成员端口、重叠
  网段和无法确定出口的转发会话等不完整归属显示 `-`，断开线路显示 `0`。
  数据经 LuCI 原生直接读取接口获取完整连接表，不受普通 RPC 小文件读取限制。
- 线路表中的 RX、TX、累计 RX 和累计 TX 是对应设备的 Linux 原始方向。
  这对所有设备保持一致；LAN 网桥行不会改写成以局域网用户视角解释的方向。
- 速率按 KB/s、MB/s、GB/s 自动格式化，总量按 KB、MB、GB、TB 自动格式化，
  均保留两位小数。连接时间使用路由器时区。

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

以下示例下载 ImmortalWrt 25.12.1 的 v0.3 包，并核对 Release 中的 SHA-256：

~~~sh
wget https://github.com/haitun001/luci-app-monitor/releases/download/v0.3/immortalwrt-25.12.1-luci-app-monitor-0.3-r1.apk
wget https://github.com/haitun001/luci-app-monitor/releases/download/v0.3/immortalwrt-25.12.1-luci-i18n-monitor-zh-cn-0.3-r1.apk
wget https://github.com/haitun001/luci-app-monitor/releases/download/v0.3/SHA256SUMS
grep ' immortalwrt-25.12.1-' SHA256SUMS | sha256sum -c -
~~~

把两个已验证的文件传到路由器临时目录：

~~~sh
scp immortalwrt-25.12.1-*.apk root@192.168.1.1:/tmp/
~~~

OpenWrt/ImmortalWrt 24.10 使用 opkg：

~~~sh
opkg install /tmp/*-24.10.*.ipk
rm -f /tmp/*-24.10.*.ipk
~~~

OpenWrt/ImmortalWrt 25.12、Snapshot 或 master 使用 apk。Release 包没有使用你的
固件签名密钥，因此本地文件安装需要明确允许未受信任签名：

~~~sh
apk add --allow-untrusted /tmp/*.apk
rm -f /tmp/*.apk
~~~

安装后重新登录 LuCI，在“状态 -> 监视器”查看。不要使用 --force-depends，
也不要混用不同固件家族或系列的产物。

## 支持范围与验证

- 支持带 LuCI 的 OpenWrt 和 ImmortalWrt 24.10 及更新系列。
- v0.3 的 CI 构建 OpenWrt 24.10.8、25.12.5、Snapshot，以及
  ImmortalWrt 24.10.6、25.12.1、master。
- 主包为 all、APK 对应 noarch；网络架构通常不限制安装，但固件家族、发行系列
  和包管理器必须匹配。
- v0.3 以指定的 x86_64 ImmortalWrt 25.12.1 路由器为实机验证目标，覆盖中英文
  桌面和移动页面、只读权限、连接数、流量方向、刷新周期、焦点保持及 8 分钟
  3 秒间隔持续运行。其他目标按 SDK 构建验证，不宣称经过本版实机验证。
- 连接数仅保留本次刷新所需的数据。累计接收和发送仍是设备自本次开机以来的
  计数，不在断线后重新累计；本版未修改 LuCI 登录会话机制。
- sensors 命令是可选探测；没有安装 lm-sensors 或没有温度传感器不会影响其余功能。

## 发布维护

发布新版本时修改 Makefile 中的 PKG_VERSION（需要时递增 PKG_RELEASE），提交并
推送 main，等待六个 CI 构建全部通过，再推送与 PKG_VERSION 一致的 v* 标签，并在
CHANGELOG.md 中提供同版本发布日志。标签工作流会重新构建 12 个包、生成
SHA256SUMS，并使用对应日志创建 GitHub Release。

本地逻辑检查使用 `node tests/monitor-unit.js`。真实页面检查使用
`tests/router-e2e.js`，通过环境变量提供路由器地址、登录信息、Chrome 路径和
仓库外的输出目录；默认浸泡 8 分钟。实机安装必须选择与固件系列匹配的分支
构建产物，并在验证通过后才创建发布标签。

## 许可证

[Apache License 2.0](LICENSE)
