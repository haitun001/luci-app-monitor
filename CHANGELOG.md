# Changelog

## v0.3

- 在线路状态右侧新增连接数，统计完整 conntrack 表中的双向会话；无法可靠归属时显示 `-`。
- Add per-interface connection counts from the complete conntrack table, with
  `-` for connections that cannot be reliably attributed to a device.
- 修复单个 WAN 设备计数回退导致汇总速率不准确，以及已连接但没有默认路由的有效 WAN 成员被遗漏的问题。
- Fix WAN rate aggregation when one device counter resets, and include
  eligible connected WAN members without a default route.

## v0.2

- 新增 1–60 秒监控刷新间隔调节选项，默认 3 秒，修改后立即生效且不持久化。
- Add a non-persistent 1–60 second monitoring refresh interval selector that
  defaults to three seconds and applies changes immediately.

## v0.1

- 首次公开发布。
- Initial public release.
