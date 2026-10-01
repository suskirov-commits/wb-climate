/**
 * @file /etc/wb-rules/wb-climate.js
 * @description Точка входа: поднимает климатические зоны по конфигурации.
 *
 * Установка:
 *   /etc/wb-rules-modules/wbclim-util.js
 *   /etc/wb-rules-modules/wbclim-valve.js
 *   /etc/wb-rules-modules/wbclim-fan.js
 *   /etc/wb-rules-modules/wbclim-convector.js
 *   /etc/wb-rules-modules/wbclim-zone.js
 *   /etc/wb-rules/wb-climate.js            <- этот файл
 *   /etc/wb-climate.conf                   <- конфигурация
 *
 * Логи: journalctl -fu wb-rules
 */

var ZONE = require('wbclim-zone');

var CONF_PATH = '/etc/wb-climate.conf';

(function () {
  var conf;
  try {
    conf = readConfig(CONF_PATH);
  } catch (e) {
    log.error('wbclim: не удалось прочитать {}: {}', CONF_PATH, e);
    return;
  }

  var zones = (conf && conf.zones) || [];
  // Зоны проверяются разом до запуска любой из них: одно реле в двух
  // зонах видно только на полном списке.
  var problems = ZONE.checkZones(zones);
  var ids = [];

  for (var i = 0; i < zones.length; i++) {
    var z = zones[i];
    if (!z || !z.id) {
      log.error('wbclim: зона #{} без поля "id" — пропущена', i);
      continue;
    }
    ids.push(z.id);
    try {
      ZONE.create(z, problems[z.id]);
    } catch (e) {
      log.error('wbclim: не удалось создать зону "{}": {}', z.id, e);
    }
  }
  ZONE.prune(ids);

  log.info('wbclim: зон в работе: {}', ids.length);
})();
