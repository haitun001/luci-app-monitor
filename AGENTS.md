# luci-app-monitor Development Contract

## Scope

- Build only the LuCI application named by this directory: `luci-app-monitor`.
- Register one read-only page at `Status -> Monitor` (`/admin/status/monitor`).
- Keep the implementation native to LuCI and OpenWrt. Do not add daemons,
  databases, configuration pages, history, custom CSS, or runtime dependencies
  beyond `luci-base`.
- Source strings are English. Maintain Simplified Chinese translations in
  `po/zh_Hans/monitor.po` and the template in `po/templates/monitor.pot`.

## Runtime Contract

- Refresh live data every five seconds through one LuCI `poll.add()` callback.
- Update existing text nodes in place. Rebuild a table body only when the set
  of interface or sensor keys changes. Never replace focused controls.
- CPU supports multiple cores and follows LuCI's existing CPU usage RPC.
- Physical memory usage is `(total - free) / total`; swap is excluded.
- Probe `/usr/sbin/sensors -j -A` through an exact read-only ACL. If the first
  successful probe contains no temperatures, hide temperature output and stop
  probing for that browser session.
- List configured, non-dynamic UCI interfaces except `loopback`. RX is download
  and TX is upload. Disconnected or pending rows show zero rates and `-` for
  counters and connection time.
- Overall traffic deduplicates active default-route L3 devices.
- Calculate rates from counter deltas and actual elapsed time. A first sample,
  device change, counter reset, or non-positive interval yields zero.
- Format speed with binary units from `KB/s` through `GB/s`, and totals from
  `KB` through `TB`, always with two decimals.
- Derive connection start from router epoch minus interface uptime and render
  `YYYY-MM-DD HH:mm:ss` in the router's configured timezone.
- Data is boot-session state only. Do not persist samples or counters.

## Security And Repository Rules

- RPC and filesystem permissions must be read-only and least-privilege.
- Never store router credentials, host keys, APKs, screenshots, build output,
  or temporary test fixtures in Git.
- Use `/home/ht/immortalwrt` as the authoritative build tree. Preserve all
  unrelated local changes there and remove any temporary package symlink.
- Use `apply_patch` for manual source edits. Keep code minimal and avoid
  speculative abstractions or unused compatibility paths.
- Update this file when a verified behavior, constraint, or test result changes.

## Required Verification Before Delivery

- Validate JavaScript syntax, JSON, translations, LuCI i18n extraction, and
  package metadata.
- Build the application and Simplified Chinese APK in the ImmortalWrt tree.
- Install both packages on the supplied router and test the real LuCI page in
  English and Chinese at desktop and mobile sizes.
- Verify five-second cadence, calculations, focus preservation, stable DOM
  size, no console errors, and the temperature UI with an intercepted valid
  lm-sensors JSON response.
- Complete a 30-minute browser soak and record request intervals, DOM size,
  console errors, and forced-GC heap before and after.
- Remove router-side APKs and test artifacts; leave only installed packages.

## Progress

- 2026-08-22: Contract created before implementation. Runtime behavior and
  acceptance criteria are locked.
- 2026-08-22: Verified on the target router that configured rows are `lan`,
  `modem`, `wan`, and `wan6`; current IPv4 and dynamic IPv6 default routes both
  use `pppoe-wan`; device counters are under `getNetworkDevices.*.stats`; CPU
  usage is returned by `luci.getCPUUsage`; timezone is `Asia/Shanghai`; and
  `sensors -j -A` returns valid empty JSON with no detected sensors.
- 2026-08-22: Minimal LuCI view, menu, read-only ACL, and English/Simplified
  Chinese catalogs implemented. JavaScript syntax, JSON parsing, whitespace,
  gettext validation, and LuCI i18n extraction pass.
- 2026-08-22: The first package build proved that a standalone package reached
  through a workspace symlink cannot resolve `../../luci.mk`; the Makefile now
  uses the position-independent `$(TOPDIR)/feeds/luci/luci.mk` include. No
  plugin source was compiled in that failed attempt.
- 2026-08-22: Package-level ImmortalWrt builds produce the main noarch APK and
  `luci-i18n-monitor-zh-cn`. Package contents are limited to the view, menu,
  read-only ACL, translation registration, LMO, and package metadata. The
  temporary source symlink is removed and the build tree retains exactly its
  four pre-existing Git status entries.
- 2026-08-22: The exact built files were installed on the target router and
  verified by SHA-256. The sensors command is allowed only as
  `/usr/sbin/sensors -j -A`; an authenticated `/bin/echo` file-exec request is
  denied. With the router's real empty sensors JSON, the page probes once and
  stops. An intercepted lm-sensors JSON fixture renders three named values at
  `42.13`, `39.00`, and `55.75` degrees C.
- 2026-08-22: Real Chrome checks pass in English and Simplified Chinese at
  1440x1000 and 390x844. The page shows `lan`, `modem`, `wan`, and `wan6`, has
  responsive mobile column labels, has no horizontal overflow or overlap, and
  preserves keyboard focus across refreshes.
- 2026-08-22: The final installed runtime passed a continuous 30-minute soak:
  366 system samples, 4973-5014 ms steady intervals (4999.98 ms average), DOM
  count 179 before/after/maximum, forced-GC heap 2923188 -> 2885548 bytes,
  zero console errors, zero page errors, preserved focus, and one sensors
  request. Router-side APKs and test artifacts were removed; only the two
  installed plugin packages remain.
