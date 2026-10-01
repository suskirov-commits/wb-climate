/**
 * make-bundle.js — однофайловая версия для загрузки через веб-интерфейс
 * Wiren Board (вкладка «Правила»).
 *
 * Модули инлайнятся в один файл со своим мини-загрузчиком, конфигурация
 * вклеивается прямо в код: пример с комментариями — валидный литерал
 * объекта JavaScript, комментарии в веб-редакторе помогают.
 *
 * Сборка побайтово воспроизводима — никаких дат (wbmix, грабля №7):
 * CI проверяет, что dist/ соответствует исходникам.
 *
 * Запуск: node tools/make-bundle.js   (или make build)
 * Результат: dist/wb-climate.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOD_DIR = path.join(ROOT, 'etc', 'wb-rules-modules');
const OUT_DIR = path.join(ROOT, 'dist');

const MODULES = ['wbclim-util', 'wbclim-valve', 'wbclim-fan', 'wbclim-convector', 'wbclim-floor', 'wbclim-zone'];

const conf = fs.readFileSync(path.join(ROOT, 'etc', 'wb-climate.conf.example'), 'utf8');
// Тело объекта — со строки, начинающейся с «{» (шапка-комментарий без скобок)
const confBody = conf.slice(conf.search(/^\{/m));

let out = '';

out += `/**
 * wb-climate.js — ОДНОФАЙЛОВАЯ СБОРКА
 *
 * Климат-контроль на Wiren Board: помещения, конвекторы (термоголовки
 * и вентиляторы — реле, 0-10 В, Modbus), тёплый пол (по датчикам пола).
 *
 * КУДА ЗАГРУЖАТЬ:
 *   Веб-интерфейс контроллера -> Правила -> Новый скрипт
 *   (файл ляжет в /etc/wb-rules/). Больше ничего копировать не нужно:
 *   модули и конфигурация уже внутри этого файла.
 *
 * ЧТО ПРАВИТЬ:
 *   Секцию CONFIG ниже — помещения, датчики, реле термоголовок,
 *   вентиляторов и петель пола. Всё ниже отметки «КОД» трогать не нужно.
 *
 * Для парка объектов лучше ставить пакетом (README, способ 1): там есть
 * страница настроек с выбором топиков из выпадающего списка.
 * Пакет и эта сборка одновременно не ставятся — зоны задвоятся.
 *
 * Сгенерировано из исходников wb-climate (tools/make-bundle.js).
 * Секцию кода вручную не редактировать.
 */

/* ==================================================================== *
 *                          К О Н Ф И Г У Р А Ц И Я                     *
 * ==================================================================== */

var CONFIG = ${confBody.trim()};

/* ==================================================================== *
 *                                К О Д                                 *
 *                    (ниже правки обычно не требуются)                 *
 * ==================================================================== */

// Реестр экземпляров хранится в прототипе глобального объекта: он общий
// для всех сценариев и переживает автоперезагрузку файла правил. Без него
// после каждого сохранения скрипта в веб-интерфейсе оставался бы висячий
// таймер, и выходами управляли бы сразу два такта.
if (!global.__proto__.__wbclimShared) global.__proto__.__wbclimShared = {};

(function () {
  var __defs = {};
  var __cache = {};

  function require(name) {
    if (__cache[name]) return __cache[name].exports;
    if (!__defs[name]) throw new Error('wbclim: модуль не найден: ' + name);
    var m = {
      exports: {},
      filename: name,
      // module.static — общее хранилище в прототипе глобального объекта,
      // чтобы поведение совпадало с обычными модулями
      static: global.__proto__.__wbclimShared
    };
    __cache[name] = m;
    __defs[name](m.exports, m, require);
    return m.exports;
  }

`;

for (const name of MODULES) {
  const code = fs.readFileSync(path.join(MOD_DIR, name + '.js'), 'utf8');
  const indented = code
    .split('\n')
    .map((l) => (l.length ? '    ' + l : l))
    .join('\n');
  out += `  /* ---------------- модуль ${name} ---------------- */\n`;
  out += `  __defs['${name}'] = function (exports, module, require) {\n`;
  out += indented;
  out += `\n  };\n\n`;
}

out += `  /* ---------------- точка входа ---------------- */

  var ZONE = require('wbclim-zone');
  var zones = (CONFIG && CONFIG.zones) || [];

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
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, 'wb-climate.js');
fs.writeFileSync(outPath, out, 'utf8');

console.log('Собрано: ' + path.relative(ROOT, outPath));
console.log('  строк: ' + out.split('\n').length + ', размер: ' + Math.round(out.length / 1024) + ' КБ');
console.log('  модулей внутри: ' + MODULES.length);
