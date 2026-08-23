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

- Refresh live data through one LuCI `poll.add()` callback. Default to three
  seconds and expose a non-persistent native selector for every integer from
  one through 60 seconds.
- On an interval change, replace the registered interval and request one
  immediate refresh. Reuse any in-flight refresh so requests never overlap.
- Update existing text nodes in place. Rebuild a table body only when the set
  of interface or sensor keys changes. Never replace focused controls.
- Read aggregate CPU counters from `/proc/stat`. Calculate multi-core CPU usage
  from consecutive `cpu` samples, counting idle and iowait as idle. A first,
  malformed, reset, or non-increasing sample displays `-`.
- Physical memory usage is `(total - free) / total`; swap is excluded.
- Probe `/usr/sbin/sensors -j -A` through an exact read-only ACL. Treat a valid
  top-level JSON object as a probe result regardless of command exit status;
  lm-sensors returns code 1 with `{}` when no sensors exist. Retry at most three
  missing, malformed, or non-object results. If a valid result contains no
  temperatures, hide temperature output and stop probing for that session.
- Enumerate every netifd logical interface with a usable `device` or
  `l3_device`, preferring the layer-2 `device` for accounting. Merge logical
  names and associated dynamic children which share one accounting device.
- Add every remaining Linux network device reported by
  `luci-rpc.getNetworkDevices` when it has byte counters. Exclude only loopback,
  control interfaces, and unused kernel tunnel placeholders; do not omit an
  explicitly mapped logical device because of its name.
- Display one row per accounting device. Logical rows use
  `network/network6 (device)` and unbound devices use the device name. Table
  directions are literal RX and TX for every physical, bridge, VLAN, wireless,
  PPP, and tunnel device; never infer LAN-relative directions for generic rows.
- Derive a logical row's state and connection time from an active default-route
  member, then from the first active member. Raw devices use kernel link state
  and show `-` for connection time. Disconnected rows show zero rates while
  retaining available boot-session RX and TX totals.
- Use the firewall zone named `wan` as the overall traffic boundary. Resolve
  eligible configured networks, netifd interfaces which request that zone at
  runtime, plus exact and prefix-wildcard raw zone devices. Exclude
  management-only networks with `defaultroute='0'` unless they own an active
  default route.
- Prefer each eligible WAN network's netifd layer-2 `device`; use its
  `l3_device` only when no lower device is available. If any physical/layer-2
  WAN candidate exists, do not also sum unresolved point-to-point candidates.
  Resolve direct upper-device matches through their logical group. Sum each
  connected WAN device once, with RX as download and TX as upload.
- Calculate rates from counter deltas and actual elapsed time. A first sample,
  device change, counter reset, or non-positive interval yields zero.
- Format speed with binary units from `KB/s` through `GB/s`, and totals from
  `KB` through `TB`, always with two decimals.
- Derive connection start from router epoch minus interface uptime and render
  `YYYY-MM-DD HH:mm:ss` in the router's configured timezone.
- Data is boot-session state only. Do not persist samples, counters, or the
  selected refresh interval.

## Security And Repository Rules

- RPC and filesystem permissions must be read-only and least-privilege.
- Never store router credentials, host keys, APKs, screenshots, build output,
  or temporary test fixtures in Git.
- Do not use or modify `/home/ht/immortalwrt` for `v0.2`; the user withdrew it
  as a supported build environment after deleting the original repository.
  Use the existing GitHub Actions SDK matrix as the authoritative build path.
- Use `apply_patch` for manual source edits. Keep code minimal and avoid
  speculative abstractions or unused compatibility paths.
- Update this file when a verified behavior, constraint, or test result changes.

## Release Contract

- The initial public release is `v0.1`. The current release is `v0.2`; both
  `luci-app-monitor` and `luci-i18n-monitor-zh-cn` use package version
  `0.2-r1`.
- Publish under Apache License 2.0 at
  `https://github.com/haitun001/luci-app-monitor`.
- Keep `README.md` in Chinese and `README_EN.md` in English. Both documents
  must describe features, source-tree builds, Release installation, supported
  firmware series, artifact selection, verification scope, and maintenance.
- GitHub Actions builds on pushes to `main` and manual dispatch. A matching
  `v*` tag additionally creates a GitHub Release. The tag version must equal
  `PKG_VERSION`.
- Build main and Simplified Chinese packages for OpenWrt 24.10.8, 25.12.5,
  Snapshot, ImmortalWrt 24.10.6, 25.12.1, and master. Release assets contain
  exactly those 12 packages plus `SHA256SUMS`.
- OpenWrt/ImmortalWrt 24.10 artifacts are IPK packages. 25.12 and development
  snapshots are APK packages. Do not mix firmware family or series artifacts.
- Verify branch CI before creating or moving a release tag. Pin third-party
  Actions by commit and use the GitHub CLI for Release creation.
- The supplied x86_64 ImmortalWrt master router is runtime-tested. Other listed
  targets are SDK build-tested and must be documented as such.

## Required Verification Before Delivery

- Validate JavaScript syntax, JSON, translations, LuCI i18n extraction, and
  package metadata.
- Build the application and Simplified Chinese packages in all six GitHub
  Actions SDK targets. Use the successful ImmortalWrt master branch artifacts
  for pre-tag router verification.
- Install both packages on the supplied router and test the real LuCI page in
  English and Chinese at desktop and mobile sizes.
- Verify the default three-second cadence, immediate interval changes at the
  one- and 60-second boundaries, calculations, selector focus preservation,
  stable DOM size, no console errors, and the temperature UI with an
  intercepted valid lm-sensors JSON response.
- Complete an eight-minute browser soak and record request intervals, DOM size,
  console errors, and forced-GC heap before and after. Run a 30-minute soak only
  when the user explicitly requests that duration.
- For `v0.2`, additionally run an explicitly requested three-minute soak at a
  selected one-second interval and record the same resource and stability data.
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
- 2026-08-22: A WAN accounting audit found that `wan`, `wan6`, and `modem` all
  share layer-2 device `eth4`; active IPv4 `wan` and dynamic IPv6 `wan_6` share
  `pppoe-wan`; and `modem` explicitly disables its default route. The firewall
  flowtable contains `br-lan`, `eth4`, and `pppoe-wan`. Over a measured
  15-second interval, `eth4` RX increased by 412125 bytes while `pppoe-wan` RX
  increased by only 29808 bytes, proving that the flow-offloaded virtual PPP
  counter is not a reliable download source. WAN RX/download and TX/upload
  direction was confirmed against the inverse `br-lan` counter movement.
- 2026-08-22: WAN accounting correction is locked to `wan (eth4)`, using
  physical `eth4` counters and logical WAN connection state. The table also
  retains `lan (br-lan)`, with TX/download and RX/upload direction. Physical
  totals intentionally include link/protocol overhead and small management,
  ARP, and DHCP traffic. Router network, firewall, and flow-offload
  configuration must not be changed by implementation or testing. Routine
  soak verification is eight minutes; 30 minutes requires an explicit request.
- 2026-08-22: The accounting correction and its deterministic browser fixture
  are implemented pending package and router verification. The fixture gives
  `eth4`, `pppoe-wan`, and an unrelated default-route VPN deliberately divergent
  counters, checks inverse LAN bridge direction, and requires the overall rate
  to equal the single deduplicated WAN row. Sensor retry behavior is covered by
  two malformed results followed by valid JSON on the third probe.
- 2026-08-22: Direct authenticated RPC inspection showed that the target
  router's empty sensors result is `{}` on stdout with command exit code 1.
  Sensor validity is therefore determined by parsed JSON shape, not exit code.
- 2026-08-22: The corrected runtime passed deterministic browser fixtures.
  Deliberately divergent `br-lan`, `eth4`, `pppoe-wan`, and unrelated VPN
  counters produced only `lan (br-lan)` and `wan (eth4)`; LAN directions were
  reversed, WAN RX/download and TX/upload were exact, and the summary equaled
  the deduplicated WAN row. Two malformed sensor responses were retried and a
  third valid response with exit code 1 rendered all three temperatures.
- 2026-08-22: English and Simplified Chinese checks pass at 1440x1000 and
  390x844. All six screenshots, including traffic and sensor fixtures, were
  visually checked with no overflow, overlap, truncation, or table misalignment.
  The exact sensors command is allowed, `/bin/echo` file execution is denied,
  and the real empty sensors response causes exactly one request.
- 2026-08-22: The corrected runtime passed a continuous eight-minute soak:
  102 system samples, 4985-5014 ms steady intervals (4999.95 ms average), DOM
  count 163 before/after/maximum, forced-GC heap 2955848 -> 2913020 bytes, zero
  console errors, zero page errors, preserved focus, and one sensors request.
- 2026-08-22: Generic monitoring work is constrained to existing LuCI RPCs.
  ImmortalWrt source confirms that `getNetworkDevices` enumerates
  `/sys/class/net` and reads each device's kernel RX/TX byte counters, so no
  daemon, backend, dependency, or broader ACL is required. The new acceptance
  contract covers multiple LANs, multiple physical WANs, unmapped devices,
  tunnel devices, and a three-second polling interval; verification is pending.
- 2026-08-22: Firewall4 source confirms that runtime interfaces with
  `data.zone` are zone members and that `device` is the physical device while
  `l3_device` is the upper device. Rpcd-mod-luci also exposes the kernel
  point-to-point flag. WAN selection now follows those fields; deterministic
  and router verification are pending.
- 2026-08-22: The first generic-device browser fixture exposed JavaScript
  coercing a raw device's null uptime to zero and rendering a false connection
  timestamp. The shared formatter rejects null uptime; the completed retest is
  recorded below.
- 2026-08-22: The rebuilt `40170e1` main APK and unchanged `62cdf0b` Simplified
  Chinese APK pass apk signature verification against the build key. The main
  package was installed on the target router; its view, menu, and ACL hashes
  match the package manifest, while the installed Chinese LMO matches the
  unchanged translation package.
- 2026-08-22: Deterministic browser verification passes with 18 simultaneous
  rows covering multiple WANs and LANs, bridges, physical ports, VLAN, PPP,
  WireGuard, TUN, TAP, GRE, USB, VETH, disconnected devices, hotplug removal and
  insertion, shared-device deduplication, divergent WAN counters, and a counter
  reset. Missing raw-device uptime renders `-`, and focus survives row changes.
- 2026-08-22: English and Simplified Chinese screenshots at 1440/1280 desktop
  and 390-pixel mobile widths, including traffic and temperature fixtures, were
  visually inspected with no overflow, overlap, truncation, or field mismatch.
- 2026-08-22: The installed `40170e1` runtime passed a continuous eight-minute
  soak: 169 system samples, 2985-3015 ms steady intervals (3000 ms average), DOM
  count 211 before/after/maximum, forced-GC heap 2577788 -> 2542772 bytes, zero
  console errors, zero page errors, preserved focus, and one sensors request.
- 2026-08-22: Final cleanup removed router-side APKs, local screenshots and
  results, built APKs, package build/staging metadata, and the temporary source
  symlink. The router retains only the installed main and Chinese packages, and
  the ImmortalWrt tree retains exactly its four pre-existing Git status entries.
- 2026-08-23: Release `v0.1` constraints are locked before implementation.
  Official OpenWrt compatibility requires replacing ImmortalWrt's private
  `luci.getCPUUsage` RPC with exact read access to `/proc/stat`; deterministic
  invalid, reset, and consecutive-sample cases are required before release.
- 2026-08-23: Portable aggregate `/proc/stat` CPU sampling, exact read ACL,
  `0.1-r1` metadata, Apache-2.0 license, bilingual documentation, and the
  six-target build/Release workflow are implemented. JavaScript, JSON, YAML,
  gettext, LuCI extraction, and whitespace checks pass.
- 2026-08-23: The authoritative ImmortalWrt master tree built signed
  `luci-app-monitor-0.1-r1.apk` and `luci-i18n-monitor-zh-cn-0.1-r1.apk` as
  noarch packages. Signatures, package metadata, dependencies, and minimal
  file manifests pass inspection; the source-tree `.config` was restored and
  the temporary package symlink was removed.
- 2026-08-23: The local `0.1-r1` packages replaced the target router's prior
  date/hash packages after exact SHA-256 verification. Installed view, menu,
  ACL, and LMO hashes match the build. Deterministic fixtures pass aggregate
  multi-core CPU calculation, malformed input, baseline recovery, counter
  reset recovery, 18 mixed network rows, hotplug, WAN deduplication, and sensor
  retries. Six desktop/mobile screenshots were visually checked without
  overflow, overlap, truncation, or field mismatch.
- 2026-08-23: The local `0.1-r1` runtime passed a continuous eight-minute
  soak: 169 system samples, 2987-3015 ms steady intervals (2999.94 ms average),
  DOM count 211 before/after/maximum, forced-GC heap 2589884 -> 2563504 bytes,
  zero console errors, zero page errors, preserved focus, and one sensors
  request.
- 2026-08-23: Initial branch CI run `32614506647` passed metadata validation
  but all six SDK builds failed because `gh-action-sdk` mounted the package
  repository itself as a feed and therefore searched below the package root.
  Its logs report a missing action-feed index and no
  `package/luci-app-monitor/download` target. The feed root is now the checkout
  parent, placing `luci-app-monitor/Makefile` one directory below it as the SDK
  feed scanner requires.
- 2026-08-23: Branch CI run `32614919777` verifies the feed-root correction.
  Metadata validation and all six OpenWrt/ImmortalWrt SDK jobs built, collected
  exactly two packages, and uploaded their artifacts successfully.
- 2026-08-23: Annotated tag `v0.1` points to `1fabc2b`. Tag CI run
  `32615203399` passed all six SDK builds and published the non-draft,
  non-prerelease GitHub Release. Its assets are exactly 12 target-prefixed
  packages plus `SHA256SUMS`; downloading all 13 assets and checking the file
  verifies every package checksum.
- 2026-08-23: The target router replaced the local build with the downloaded
  ImmortalWrt master Release packages. Router-side SHA-256 and `apk verify`
  pass before installation; the installed APK source is `/feed/luci-app-monitor`,
  and the view, menu, ACL, and Chinese LMO hashes match the Release manifests.
- 2026-08-23: The Release runtime passed the full deterministic fixture suite,
  bilingual desktop/mobile checks, and an eight-minute soak: 169 system
  samples, 2985-3015 ms intervals (2999.994 ms average), DOM count 211
  before/after/maximum, forced-GC heap 3031900 -> 2981944 bytes, zero console
  errors, zero page errors, preserved focus, and one sensors request. All six
  screenshots were visually checked without overflow, overlap, truncation, or
  column mismatch. Router APKs and local build/test artifacts were removed;
  only the two installed packages remain, and the ImmortalWrt tree retains
  exactly its four pre-existing Git status entries with an unchanged `.config`.
- 2026-08-23: Active CPU verification on the two-core Release router captured
  31 distinct complete `/proc/stat` RPC responses and independently recomputed
  every aggregate sample before comparing it with the corresponding rendered
  value. Five stable samples per phase produced medians of
  7.328990228013029% at baseline, 51.333333333333336% with CPU 0 pinned busy,
  100% with CPUs 0 and 1 pinned busy, and 5.676126878130217% after recovery.
  The maximum RPC-to-UI difference was 0.004925864909388622 percentage points;
  the initial sample rendered `-` as specified, and there were zero invalid
  stable values, console errors, or page errors. All three self-terminating
  27-second load processes exited with code 0; exact-PID and marker checks
  confirmed no router-side test process remained, and no package was installed.
- 2026-08-23: The `v0.2` contract is locked before implementation: add one
  native, non-persistent one-to-60-second refresh selector before the summary,
  default it to three seconds, apply changes immediately without overlapping
  requests, publish bilingual release notes, and retain the eight-minute
  routine soak requirement.
- 2026-08-23: The user withdrew `/home/ht/immortalwrt` as a usable build
  environment. A path with source-shaped files still exists locally, but its
  provenance and completeness are not trusted. `v0.2` will use branch CI SDK
  artifacts for router verification before its release tag is created.
- 2026-08-23: The minimal `v0.2` selector, guarded dynamic poll registration,
  `0.2-r1` metadata, bilingual catalogs and documentation, versioned changelog,
  Release-note extraction, and browser assertions are implemented. JavaScript,
  JSON, YAML, gettext, upstream LuCI i18n extraction, metadata, and Git
  whitespace checks pass; SDK builds and router verification are pending.
- 2026-08-23: Branch CI run `32636576506` passed metadata validation and all
  six OpenWrt/ImmortalWrt SDK builds, each collecting and uploading exactly two
  `0.2-r1` packages. Its ImmortalWrt master APKs were installed on the router;
  package versions and archive-to-installed-file hashes pass. The first browser
  preflight stopped because Playwright `selectOption()` had not focused the
  selector before the focus-preservation assertion; the test now establishes
  focus explicitly, and runtime verification remains pending.
- 2026-08-23: The corrected full-suite browser preflight passes. Measured
  one-second intervals were 991-1015 ms and five-second intervals were
  4995-5010 ms; the 60-second boundary produced only its immediate request,
  maximum concurrent system requests were one, and reload restored three
  seconds. DOM count stayed at 275, forced-GC heap changed by 6616 bytes, focus
  survived refreshes and row hotplug, and console/page errors were zero. All
  six English/Chinese desktop/mobile, traffic, and sensor screenshots were
  visually checked without overflow, overlap, truncation, or misalignment.
- 2026-08-23: The user explicitly requested one additional three-minute soak at
  a selected one-second interval for `v0.2`. The existing browser suite now
  accepts a validated, test-only `MONITOR_SOAK_INTERVAL`; its default remains
  three seconds and it does not alter or persist plugin state.
- 2026-08-23: The requested one-second runtime soak passed on the installed
  `0.2-r1` release candidate: 204 samples over three minutes, 981-1041 ms
  intervals (1000.158 ms average), DOM count 275 before/after/maximum, forced-GC
  heap 3077532 -> 3100088 bytes (+22556), zero console errors, zero page errors,
  preserved focus, and one sensors request. The six fixture and bilingual
  desktop/mobile screenshots were visually checked without overflow, overlap,
  truncation, or column mismatch. The HTTP observer saw a maximum of two
  concurrent `system.info` requests because LuCI's global status request can
  interleave; the interval fixture's application poll callback remained at one
  active request and the view's shared Promise prevents duplicate snapshots.
- 2026-08-23: Annotated tag `v0.2` points to `1a200a5`. Tag CI run
  `32638746412` passed metadata validation and all six SDK builds, then
  published the non-draft, non-prerelease GitHub Release. Its assets are
  exactly 12 target-prefixed packages plus `SHA256SUMS`; downloading all 13
  assets and checking the 12 listed hashes succeeds.
- 2026-08-23: The target router force-reinstalled the two ImmortalWrt master
  Release APKs offline after exact SHA-256 and `apk verify` checks. Both
  installed packages report `0.2-r1`; the installed view, menu, ACL, and
  Simplified Chinese LMO hashes match the Release manifests and the long-tested
  release candidate. The final short browser regression measured one-second
  intervals of 994-1009 ms, five-second intervals of 4992-4996 ms, and default
  three-second intervals of 2992-3005 ms (2999.667 ms average). DOM count stayed
  at 275, forced-GC heap changed by 6616 bytes, focus was preserved, sensors ran
  once, and console/page errors were zero. All six bilingual desktop/mobile,
  traffic, and sensor screenshots were visually checked without overflow,
  overlap, truncation, or column mismatch. Router-side uploaded and prior stray
  APKs, local Release/test assets, screenshots, results, CI logs, and the
  temporary Playwright install were removed; the router retains only the two
  installed plugin packages and no test process.
