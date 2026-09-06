# luci-app-monitor

[中文](README.md)

luci-app-monitor is a read-only real-time LuCI monitor for OpenWrt and
ImmortalWrt. After installation, open it at Status -> Monitor.

## Features

- Refreshes CPU, memory, and network data asynchronously every three seconds by
  default. A page-level selector applies any interval from 1 to 60 seconds
  immediately and resets to three seconds when the page is reopened.
- Calculates aggregate multi-core CPU usage from /proc/stat.
- Reports physical memory usage as (total - free) / total, excluding swap.
- Shows sensor names and temperatures in degrees Celsius when lm-sensors
  returns valid temperature inputs; otherwise the temperature section is hidden.
- The top download/upload summary includes only the firewall zone named wan.
  Each eligible lower device is counted once: RX is download from upstream and
  TX is upload to upstream.
- The interface table includes netifd interfaces and Linux network devices with
  byte counters, including physical NICs, bridges, VLAN, PPP, WireGuard, TUN,
  TAP, GRE, and VETH devices.
- The Connections column after Status counts TCP, UDP, and other bidirectional
  conntrack records, including tracked TIME_WAIT states. Each record counts
  once per row; traffic traversing different networks can count in both rows.
  These are not client counts, and adding rows does not give a global total.
- Attribution uses original/reply addresses, NAT addresses, and interface
  subnets. Unaddressed bridge ports, overlapping networks, and forwarding
  without a reliable egress association show `-`; disconnected rows show `0`.
  LuCI's native direct read retrieves the complete connection table without
  the small-file limit of ordinary RPC reads.
- RX, TX, Total RX, and Total TX in the interface table use the literal Linux
  device direction for every row. A LAN bridge row is not rewritten from a
  client-relative point of view.
- Rates automatically use KB/s, MB/s, or GB/s. Totals use KB, MB, GB, or TB.
  Values have two decimal places, and connection times use the router timezone.

All data comes from kernel counters for the current router boot. The package has
no daemon, database, configuration file, or persistent history.

## Build from source

Check out a complete OpenWrt or ImmortalWrt source tree matching the firmware
family and series on the router, then initialize that tree's documented build
environment and feeds. From the source-tree root:

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

This builds both the main package and the Simplified Chinese language package.
Do not use an ImmortalWrt Release artifact with OpenWrt, or vice versa.

## Install from a Release

Open [Releases](https://github.com/haitun001/luci-app-monitor/releases) and
select both the luci-app-monitor main package and
luci-i18n-monitor-zh-cn package whose prefix exactly matches the firmware
family and series.

| Release prefix | Format |
| --- | --- |
| openwrt-24.10.8 | IPK |
| openwrt-25.12.5 | APK |
| openwrt-snapshot | APK |
| immortalwrt-24.10.6 | IPK |
| immortalwrt-25.12.1 | APK |
| immortalwrt-master | APK |

This example directly downloads the v0.3 ImmortalWrt 25.12.1 packages and
checks them against the published SHA-256 file:

~~~sh
wget https://github.com/haitun001/luci-app-monitor/releases/download/v0.3/immortalwrt-25.12.1-luci-app-monitor-0.3-r1.apk
wget https://github.com/haitun001/luci-app-monitor/releases/download/v0.3/immortalwrt-25.12.1-luci-i18n-monitor-zh-cn-0.3-r1.apk
wget https://github.com/haitun001/luci-app-monitor/releases/download/v0.3/SHA256SUMS
grep ' immortalwrt-25.12.1-' SHA256SUMS | sha256sum -c -
~~~

Transfer the two verified files to the router:

~~~sh
scp immortalwrt-25.12.1-*.apk root@192.168.1.1:/tmp/
~~~

OpenWrt/ImmortalWrt 24.10 uses opkg:

~~~sh
opkg install /tmp/*-24.10.*.ipk
rm -f /tmp/*-24.10.*.ipk
~~~

OpenWrt/ImmortalWrt 25.12, Snapshot, and master use apk. Release packages are
not signed with your firmware's package key, so explicitly allow the local
untrusted package:

~~~sh
apk add --allow-untrusted /tmp/*.apk
rm -f /tmp/*.apk
~~~

Log in to LuCI again and open Status -> Monitor. Do not use --force-depends,
and do not mix artifacts from different firmware families or series.

## Compatibility and verification

- Supports LuCI-equipped OpenWrt and ImmortalWrt 24.10 and later.
- The v0.3 CI matrix builds OpenWrt 24.10.8, 25.12.5, and Snapshot, plus
  ImmortalWrt 24.10.6, 25.12.1, and master.
- The IPK main package is all and APK is noarch. CPU architecture is generally
  not a restriction, but firmware family, release series, and package manager
  must match.
- The v0.3 runtime validation target is the supplied x86_64 ImmortalWrt 25.12.1
  router: English/Chinese desktop and mobile rendering, read-only permissions,
  connection counts, traffic directions, refresh cadence, focus preservation,
  and an eight-minute three-second soak. Other targets receive SDK build
  verification, without a claim of hardware testing for this release.
- Connection records are retained only for the current refresh. Total RX/TX
  remain boot-session counters and do not restart after a disconnect. This
  release does not change LuCI authentication or session expiry.
- The sensors command is an optional probe. Missing lm-sensors or temperature
  inputs do not affect the other metrics.

## Maintainer release process

For a new release, update PKG_VERSION in Makefile and increment PKG_RELEASE
when appropriate, and add matching release notes to CHANGELOG.md. Commit and
push main, wait for all six CI builds to pass, then push a v* tag matching
PKG_VERSION. The tag workflow rebuilds 12 packages, generates SHA256SUMS, and
creates the GitHub Release with the matching changelog entry.

Run local logic checks with `node tests/monitor-unit.js`. The real-page suite
is `tests/router-e2e.js`; provide the router URL, credentials, Chrome path, and
an output directory outside the repository through environment variables. The
default soak is eight minutes. Install matching firmware-series branch
artifacts for router verification before creating the release tag.

## License

[Apache License 2.0](LICENSE)
