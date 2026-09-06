# Changelog

## v0.4

- 已连接线路的状态下方显示 IPv4 地址；合并线路按逻辑接口标注全部已连接成员的地址，断线后清除旧地址。
- Show IPv4 addresses below connected status, label each connected member in
  merged rows, and clear stale addresses after disconnection.
- 核对全部中英文词条，明确路由器监控、下载和上传速度、连接中及连接开始时间的表述。
- Review every English and Simplified Chinese string and clarify monitoring,
  download/upload speed, connecting status, and connection start time labels.
- 新增 ImmortalWrt 25.12.1 的单行安装与覆盖升级命令，校验两个包的 SHA-256、允许未受信任签名并自动清理独立临时目录。
- Add an ImmortalWrt 25.12.1 install/upgrade command that verifies both package
  checksums, allows untrusted signatures, and cleans its private temporary directory.

## v0.3

- 在线路状态右侧新增连接数，统计完整 conntrack 表中的双向会话；无法可靠归属时显示 `-`。
- Add per-interface connection counts from the complete conntrack table, with
  `-` for connections that cannot be reliably attributed to a device.
- 修复单个 WAN 设备计数回退导致汇总速率不准确，以及已连接但没有默认路由的有效 WAN 成员被遗漏的问题。
- Fix WAN rate aggregation when one device counter resets, and include
  eligible connected WAN members without a default route.
- 修复 Material 主题移动端列名缺失和摘要表格宽度异常。
- Fix missing mobile column labels and summary table width in Material theme.

## v0.2

- 新增 1–60 秒监控刷新间隔调节选项，默认 3 秒，修改后立即生效且不持久化。
- Add a non-persistent 1–60 second monitoring refresh interval selector that
  defaults to three seconds and applies changes immediately.

## v0.1

- 首次公开发布。
- Initial public release.
