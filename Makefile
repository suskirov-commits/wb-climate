# wb-climate — климат-контроль на Wiren Board
#
#   make test        прогнать все автотесты
#   make sim         стенд: зона с конвектором на модели помещения
#   make build       пересобрать однофайловую версию dist/
#   make schema      пересобрать форму настроек из tools/make-schema.js
#   make deb         собрать .deb (нужен dpkg-deb: Linux или CI)
#   make deploy HOST=192.168.1.50    залить файлы по ssh и перезапустить wb-rules

PKG      := wb-climate
# Версия пакета из git:
#   тег v1.2.3            -> 1.2.3
#   3 коммита после тега  -> 1.2.3+3+gabc1234
#   тегов ещё нет         -> 0.0.0+gabc1234
# Версия в Debian обязана начинаться с цифры (wbmix, грабля №8).
GITDESC  := $(shell git describe --tags --always --dirty 2>/dev/null | sed 's/^v//; s/-/+/g')
VERSION  := $(shell echo "$(GITDESC)" | grep -qE '^[0-9]' \
              && echo "$(GITDESC)" \
              || echo "0.0.0+$(if $(GITDESC),$(GITDESC),local)")
# Architecture: all — внутри только JavaScript и JSON, один пакет
# для WB6/7 (armhf) и WB8 (arm64)
DEB      := $(PKG)_$(VERSION)_all.deb
BUILD    := build/deb
HOST     ?=
SSHOPTS  ?= -o StrictHostKeyChecking=accept-new

.PHONY: all test sim build schema deb clean deploy help

all: test

help:
	@sed -n '3,9p' Makefile | sed 's/^# \{0,1\}//'

test:
	@node test/zone.js
	@node test/bundle.js
	@node test/schema.js

sim:
	@node test/sim.js

build:
	@node tools/make-bundle.js

schema:
	@node tools/make-schema.js

# ------------------------------------------------------------------ deb
#
# /etc/wb-climate.conf объявлен в conffiles: dpkg не затрёт конфигурацию
# объекта при обновлении. Ставить с --force-confold — тогда при изменённом
# эталоне dpkg не остановится с вопросом, а положит его рядом .dpkg-dist.
#
# Сжатие принудительно gzip: свежий dpkg-deb в CI пакует в zstd, который
# dpkg на контроллере не разбирает (wbmix, грабля №12).

deb: clean
	@mkdir -p $(BUILD)/DEBIAN
	@mkdir -p $(BUILD)/etc/wb-rules-modules
	@mkdir -p $(BUILD)/etc/wb-rules
	@mkdir -p $(BUILD)/usr/share/wb-mqtt-confed/schemas
	@mkdir -p $(BUILD)/usr/share/$(PKG)
	@install -m 0644 etc/wb-rules-modules/wbclim-*.js $(BUILD)/etc/wb-rules-modules/
	@install -m 0644 etc/wb-rules/wb-climate.js $(BUILD)/etc/wb-rules/
	@install -m 0644 etc/wb-climate.conf $(BUILD)/etc/
	@install -m 0644 usr/share/wb-mqtt-confed/schemas/wb-climate.schema.json \
		$(BUILD)/usr/share/wb-mqtt-confed/schemas/
	@install -m 0644 README.md PROMPT.md ROADMAP.md etc/wb-climate.conf.example $(BUILD)/usr/share/$(PKG)/
	@echo "$(VERSION)" > $(BUILD)/usr/share/$(PKG)/VERSION
	@printf 'Package: %s\n' "$(PKG)"                        >  $(BUILD)/DEBIAN/control
	@printf 'Version: %s\n' "$(VERSION)"                    >> $(BUILD)/DEBIAN/control
	@printf 'Section: misc\n'                               >> $(BUILD)/DEBIAN/control
	@printf 'Priority: optional\n'                          >> $(BUILD)/DEBIAN/control
	@printf 'Architecture: all\n'                           >> $(BUILD)/DEBIAN/control
	@printf 'Depends: wb-rules (>= 2.0), wb-mqtt-confed\n'  >> $(BUILD)/DEBIAN/control
	@printf 'Maintainer: wb-climate <noreply@example.com>\n' >> $(BUILD)/DEBIAN/control
	@printf 'Description: Climate control for Wiren Board\n' >> $(BUILD)/DEBIAN/control
	@printf ' Rooms with a setpoint and heat demand driving convectors:\n' >> $(BUILD)/DEBIAN/control
	@printf ' thermal actuators and fans (relays, 0-10 V, Modbus).\n' >> $(BUILD)/DEBIAN/control
	@printf ' Settings page is provided via wb-mqtt-confed schema.\n' >> $(BUILD)/DEBIAN/control
	@printf '/etc/wb-climate.conf\n'                        >  $(BUILD)/DEBIAN/conffiles
	@printf '#!/bin/sh\nset -e\n'                           >  $(BUILD)/DEBIAN/postinst
	@printf 'if [ "$$1" = configure ]; then\n'              >> $(BUILD)/DEBIAN/postinst
	@printf '  deb-systemd-invoke restart wb-rules >/dev/null 2>&1 || \\\n' >> $(BUILD)/DEBIAN/postinst
	@printf '    systemctl restart wb-rules >/dev/null 2>&1 || true\n' >> $(BUILD)/DEBIAN/postinst
	@printf '  systemctl try-restart wb-mqtt-confed >/dev/null 2>&1 || true\n' >> $(BUILD)/DEBIAN/postinst
	@printf 'fi\nexit 0\n'                                  >> $(BUILD)/DEBIAN/postinst
	@printf '#!/bin/sh\nset -e\nexit 0\n'                   >  $(BUILD)/DEBIAN/postrm
	@chmod 0755 $(BUILD)/DEBIAN/postinst $(BUILD)/DEBIAN/postrm
	@dpkg-deb -Zgzip --root-owner-group --build $(BUILD) $(DEB) >/dev/null
	@ar t $(DEB) | grep -qxF control.tar.gz || { echo 'ОШИБКА: control.tar не gzip, на контроллере не поставится'; exit 1; }
	@ar t $(DEB) | grep -qxF data.tar.gz    || { echo 'ОШИБКА: data.tar не gzip, на контроллере не поставится'; exit 1; }
	@echo "собран $(DEB)"
	@dpkg-deb -I $(DEB) | sed -n '2,12p'

clean:
	@rm -rf build/deb $(PKG)_*_all.deb

# ------------------------------------------------------------------ deploy
#
# Для тестового контроллера: файлы по ssh, конфигурация — только если её
# там ещё нет (настройки объекта не затираются).

deploy:
	@test -n "$(HOST)" || { echo "укажите HOST=<ip контроллера>"; exit 1; }
	@echo "заливаю на $(HOST)..."
	@scp $(SSHOPTS) -q etc/wb-rules-modules/wbclim-*.js root@$(HOST):/etc/wb-rules-modules/
	@scp $(SSHOPTS) -q etc/wb-rules/wb-climate.js root@$(HOST):/etc/wb-rules/
	@scp $(SSHOPTS) -q usr/share/wb-mqtt-confed/schemas/wb-climate.schema.json \
		root@$(HOST):/usr/share/wb-mqtt-confed/schemas/
	@scp $(SSHOPTS) -q etc/wb-climate.conf root@$(HOST):/tmp/wb-climate.conf.dist
	@ssh $(SSHOPTS) root@$(HOST) 'test -f /etc/wb-climate.conf || cp /tmp/wb-climate.conf.dist /etc/wb-climate.conf; \
		systemctl try-restart wb-mqtt-confed; systemctl restart wb-rules && echo готово'
