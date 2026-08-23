# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

PKG_VERSION:=0.2
PKG_RELEASE:=1
PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE

LUCI_TITLE:=LuCI Monitor
LUCI_DEPENDS:=+luci-base
LUCI_URL:=https://github.com/haitun001/luci-app-monitor
LUCI_MAINTAINER:=haitun001

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
