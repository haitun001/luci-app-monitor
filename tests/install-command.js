'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const commandFrom = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')
	.split(/\r?\n/).find(line => line.startsWith('(set -eu; dir=$(mktemp -d /tmp/luci-monitor-v'));
const command = commandFrom('README.md');
assert(command, 'Missing single-command installer');
assert.equal(commandFrom('README_EN.md'), command, 'Both languages must provide the same command');

// Only download and installation are stubbed; real shell traps and SHA-256 checks run.
const stubs = `
mktemp() { command mktemp -d "$MONITOR_TEST_DIR/work.XXXXXX"; }
wget() {
  test "$1" = -T && test "$2" = 60 && test "$3" = -O || return 1
  case "$5" in https://github.com/haitun001/luci-app-monitor/releases/download/v0.4/"$4") ;; *) return 1 ;; esac
  if test "$4" = SHA256SUMS; then
    case "$MONITOR_TEST_CASE" in
      missing) sha256sum immortalwrt-25.12.1-luci-app-monitor-*.apk > "$4" ;;
      duplicate) sha256sum immortalwrt-25.12.1-luci-app-monitor-*.apk immortalwrt-25.12.1-luci-app-monitor-*.apk > "$4" ;;
      *) sha256sum immortalwrt-25.12.1-*.apk > "$4" ;;
    esac
    if test "$MONITOR_TEST_CASE" = checksum; then
      printf corrupt >> immortalwrt-25.12.1-luci-app-monitor-0.4-r1.apk
    fi
  else
    printf package > "$4"
  fi
  test "$MONITOR_TEST_CASE" != download
}
apk() {
  printf '%s\\n' "$@" > "$MONITOR_TEST_DIR/install-args"
  test "$MONITOR_TEST_CASE" != install
}
`;

for (const scenario of [ 'success', 'download', 'checksum', 'missing', 'duplicate', 'install' ]) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-installer-check-'));
	try {
		fs.writeFileSync(path.join(temp, 'unrelated.apk'), 'keep');
		const result = spawnSync('sh', [ '-c', stubs + '\n' + command ], {
			env: { ...process.env, MONITOR_TEST_DIR: temp, MONITOR_TEST_CASE: scenario }, encoding: 'utf8'
		});
		assert.ifError(result.error);
		assert.equal(result.status === 0, scenario === 'success', `${scenario}: ${result.stderr}`);
		assert.equal(fs.readFileSync(path.join(temp, 'unrelated.apk'), 'utf8'), 'keep');
		assert.equal(fs.readdirSync(temp).some(name => name.startsWith('work.')), false, `${scenario}: leaked downloads`);
		const installed = fs.existsSync(path.join(temp, 'install-args'));
		assert.equal(installed, scenario === 'success' || scenario === 'install', `${scenario}: unexpected installation`);
		if (installed) {
			const args = fs.readFileSync(path.join(temp, 'install-args'), 'utf8').trim().split('\n');
			assert.deepEqual(args.slice(0, 6), [ 'add', '--allow-untrusted', '--force-reinstall',
				'--no-network', '--repositories-file', '/dev/null' ]);
			assert.equal(args.length, 8);
			assert.equal(path.basename(args[6]), 'immortalwrt-25.12.1-luci-app-monitor-0.4-r1.apk');
			assert.equal(path.basename(args[7]), 'immortalwrt-25.12.1-luci-i18n-monitor-zh-cn-0.4-r1.apk');
		}
	}
	finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
}
console.log('Installer checks passed: exact downloads, checksums, failed downloads/installs, isolated cleanup');
