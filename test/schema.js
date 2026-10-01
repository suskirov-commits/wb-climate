/**
 * schema.js — форма настроек (wb-mqtt-confed) и эталонная конфигурация.
 *
 * Форму нельзя прогнать через веб-интерфейс из скрипта, поэтому
 * проверяется всё, что проверяемо машинно:
 *   - схема компилируется как JSON Schema draft-04, эталон ей соответствует;
 *   - у всех полей-топиков выбор из списка (wb-autocomplete);
 *   - $ref без соседних ключей (wbmix, грабля №5);
 *   - все ключи переводов на месте в обеих локалях;
 *   - каждое поле схемы читается кодом, умолчания схемы = умолчания кода;
 *   - в эталоне все топики пустые (wbmix, грабля №17);
 *   - пример с комментариями собирается в рабочие зоны.
 *
 * Запуск: node test/schema.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Ajv = require('ajv-draft-04');
const { createEnv, makeChecker, ROOT } = require('./harness');

const R = makeChecker();
const check = R.check;

const SCHEMA_PATH = path.join(ROOT, 'usr/share/wb-mqtt-confed/schemas/wb-climate.schema.json');
const CONF_PATH = path.join(ROOT, 'etc/wb-climate.conf');
const EXAMPLE_PATH = path.join(ROOT, 'etc/wb-climate.conf.example');
const MOD_DIR = path.join(ROOT, 'etc/wb-rules-modules');

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const conf = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));

console.log('\n=== 1. Компиляция и валидация ===');
const ajv = new Ajv({ strict: false, allErrors: true });
let validate = null,
  err = null;
try {
  validate = ajv.compile(schema);
} catch (e) {
  err = e;
}
check('схема компилируется как draft-04', err === null, err && err.message);
check('эталон валиден', validate && validate(conf), JSON.stringify(validate && validate.errors && validate.errors[0]));
check('путь к конфигурации', schema.configFile && schema.configFile.path === '/etc/wb-climate.conf');
check('перезапускаемый сервис — wb-rules', schema.configFile && schema.configFile.service === 'wb-rules');

// Каждый тип вентилятора — ровно одна ветка oneOf
const zoneOf = (fan) => ({ zones: [Object.assign({}, conf.zones[0], { devices: [Object.assign({}, conf.zones[0].devices[0], { fan })] })] });
for (const fan of [
  { type: 'none' },
  { type: 'relays', speeds: [{ control: 'a/b' }] },
  { type: 'analog', out: 'a/b' },
  { type: 'modbus', out: 'a/b', steps: 3 },
  { type: 'modbus', out: 'a/b', steps: 0, minChange: 5 },
  { type: 'modbus', out: 'a/b', values: [30, 60, 100] }
]) {
  check('вентилятор «' + fan.type + '» проходит oneOf', validate(zoneOf(fan)), JSON.stringify(validate.errors && validate.errors[0]));
}
check('неизвестный тип вентилятора отвергается', !validate(zoneOf({ type: 'jet' })));
check('четыре скорости реле отвергаются', !validate(zoneOf({ type: 'relays', speeds: [1, 2, 3, 4].map((i) => ({ control: 'a/K' + i })) })));
const badId = JSON.parse(JSON.stringify(conf));
badId.zones[0].devices[0].id = 'Conv-1';
check('id конвектора с недопустимыми символами отвергается', !validate(badId));

console.log('\n=== 2. Выбор топиков из списка ===');
const topicFields = [];
(function walk(n, p) {
  if (Array.isArray(n)) return n.forEach((v, i) => walk(v, p + '/' + i));
  if (!n || typeof n !== 'object') return;
  if (n.pattern === '^$|^[^/+#]+/[^/+#]+$') topicFields.push({ p, n });
  for (const k of Object.keys(n)) walk(n[k], p + '/' + k);
})(schema, '');
check('полей-топиков найдено', topicFields.length >= 10, topicFields.length);
const noAuto = topicFields.filter((f) => f.n._format !== 'wb-autocomplete' || !f.n.options || !f.n.options.wb || f.n.options.wb.data !== 'devices');
check('у всех — wb-autocomplete по devices', noAuto.length === 0, noAuto.map((f) => f.p).join(', '));
for (const name of ['temperature', 'humidity', 'topics', 'speeds', 'out', 'enable', 'waterSensor']) {
  check('поле «' + name + '» выбирается из списка', topicFields.some((f) => f.p.indexOf('/' + name + '/') >= 0 || f.p.endsWith('/' + name)), name);
}

console.log('\n=== 3. $ref без соседних ключей ===');
const badRef = [];
(function walk(n, p) {
  if (Array.isArray(n)) return n.forEach((v, i) => walk(v, p + '/' + i));
  if (!n || typeof n !== 'object') return;
  if (n.$ref && Object.keys(n).length > 1) badRef.push(p);
  for (const k of Object.keys(n)) walk(n[k], p + '/' + k);
})(schema, '');
check('таких мест нет', badRef.length === 0, badRef.join(', '));

console.log('\n=== 4. Переводы ===');
const used = new Set();
(function collect(n, key) {
  if (Array.isArray(n)) {
    if (key === 'enum_titles') n.forEach((x) => used.add(x));
    return n.forEach((v) => collect(v));
  }
  if (!n || typeof n !== 'object') return;
  for (const k of Object.keys(n)) {
    if (k === 'translations') continue;
    const v = n[k];
    if ((k === 'title' || k === 'description' || k === 'patternmessage' || k === 'placeholder') && typeof v === 'string') used.add(v);
    collect(v, k);
  }
})(schema);
const en = schema.translations.en,
  ru = schema.translations.ru;
const missEn = [...used].filter((k) => !(k in en) && !/^\{\{/.test(k));
const missRu = [...used].filter((k) => !(k in ru) && !/^\{\{/.test(k));
check('все ключи есть в en', missEn.length === 0, missEn.join(', '));
check('все ключи есть в ru', missRu.length === 0, missRu.join(', '));
check('наборы ключей en и ru совпадают', Object.keys(en).sort().join() === Object.keys(ru).sort().join());
const unused = Object.keys(ru).filter((k) => !used.has(k));
check('нет неиспользуемых переводов', unused.length === 0, unused.join(', '));

console.log('\n=== 5. Поля схемы читаются кодом ===');
const code = fs.readdirSync(MOD_DIR).map((f) => fs.readFileSync(path.join(MOD_DIR, f), 'utf8')).join('\n');
const props = new Set();
(function walk(n) {
  if (Array.isArray(n)) return n.forEach(walk);
  if (!n || typeof n !== 'object') return;
  if (n.properties) Object.keys(n.properties).forEach((k) => props.add(k));
  for (const k of Object.keys(n)) if (k !== 'translations') walk(n[k]);
})(schema);
const notRead = [...props].filter((k) => !new RegExp('\\.' + k + '\\b').test(code));
check('каждое поле схемы читается в модулях', notRead.length === 0, notRead.join(', '));

// Умолчания: эталон, форма и код должны говорить одно и то же
const env = createEnv();
const ZONE = env.require('wbclim-zone');
const z = new ZONE.Zone({ id: 'd', sensors: { temperature: ['x/y'] }, devices: [{ id: 'c', valve: { topics: ['x/v'] }, fan: { type: 'relays', speeds: ['x/s1'] } }] }, []);
const c = z.devices[0];
const zm = new ZONE.Zone({ id: 'm', sensors: { temperature: ['x/y'] }, devices: [{ id: 'c', valve: { topics: ['x/v2'] }, fan: { type: 'modbus', out: 'x/f' } }] }, []);
const mb = zm.devices[0];
const defs = schema.definitions;
const pairs = [
  ['band', defs.zone.properties.control.properties.band.default, z.bandDefault],
  ['ti', defs.zone.properties.control.properties.ti.default, z.tiDefault],
  ['period', defs.zone.properties.control.properties.period.default, z.periodMs / 1000],
  ['setpointMin', defs.zone.properties.control.properties.setpointMin.default, z.spMin],
  ['setpointMax', defs.zone.properties.control.properties.setpointMax.default, z.spMax],
  ['defaultSetpoint', defs.zone.properties.defaultSetpoint.default, z.spDefault],
  ['frostTemp', defs.zone.properties.safety.properties.frostTemp.default, z.frostT],
  ['failSafeDemand', defs.zone.properties.safety.properties.failSafeDemand.default, z.failSafeDemand],
  ['window.delay', defs.zone.properties.window.properties.delay.default, z.winDelayMs / 1000],
  ['valve.minOn', defs.convector.properties.valve.properties.minOn.default, c.valve.minOnMs / 1000],
  ['valve.minOff', defs.convector.properties.valve.properties.minOff.default, c.valve.minOffMs / 1000],
  ['valve.openTime', defs.convector.properties.valve.properties.openTime.default, c.valve.openTimeMs / 1000],
  ['valve.cycle', defs.convector.properties.valve.properties.cycle.default, c.valve.cycleMs / 1000],
  ['fan.start', defs.fanRelays.properties.start.default, c.fanStart],
  ['fan.hyst', defs.fanRelays.properties.hyst.default, c.fanHyst],
  ['fan.minStepTime', defs.fanRelays.properties.minStepTime.default, c.fanStepMs / 1000],
  ['fan.delay', defs.fanRelays.properties.delay.default, c.fanDelayMs / 1000],
  ['fan.minWater', defs.fanRelays.properties.minWater.default, c.waterMin],
  ['fan.interlock', defs.fanRelays.properties.interlock.default, c.fan.interlockMs],
  ['fan.min', defs.fanAnalog.properties.min.default, c.fanMin],
  ['modbus.minChange', defs.fanModbus.properties.minChange.default, mb.fan.minChange],
  ['modbus.steps', defs.fanModbus.properties.steps.default, mb.fan.steps]
];
for (const [name, s, k] of pairs) check('умолчание ' + name + ': форма ' + s + ' = код ' + k, s === k);
const zc = conf.zones[0];
check('эталон: band = умолчанию', zc.control.band === z.bandDefault);
check('эталон: ti = умолчанию', zc.control.ti === z.tiDefault);
check('эталон: fan.hyst = умолчанию', zc.devices[0].fan.hyst === c.fanHyst);

console.log('\n=== 6. Эталон: топики пустые, зона не запускается ===');
const filled = [];
(function walk(n, p) {
  if (Array.isArray(n)) return n.forEach((v, i) => walk(v, p + '/' + i));
  if (!n || typeof n !== 'object') return;
  for (const k of Object.keys(n)) {
    const isTopic = ['control', 'out', 'enable', 'waterSensor'].indexOf(k) >= 0 && typeof n[k] === 'string';
    if (isTopic && n[k] !== '') filled.push(p + '/' + k + '=' + n[k]);
    walk(n[k], p + '/' + k);
  }
})(conf, '');
check('в эталоне нет адресов модулей', filled.length === 0, filled.join(', '));
{
  const e = createEnv();
  e.config = conf;
  const mark = e.writes.length;
  e.runScript(path.join(ROOT, 'etc/wb-rules/wb-climate.js'));
  e.advance(60 * 1000);
  const ext = e.writes.slice(mark).filter((w) => w[0].indexOf(zc.id + '/') !== 0);
  check('эталон ничего не переключает', ext.length === 0, JSON.stringify(ext));
  check('карточка: «Ошибка настройки»', e.get(zc.id + '/state') === 'Ошибка настройки', e.get(zc.id + '/state'));
  check('в аварии — что заполнить', /датчик температуры/.test(e.get(zc.id + '/alarm_text')), e.get(zc.id + '/alarm_text'));
}

console.log('\n=== 7. Что вернёт форма: необязательные секции пропущены ===');
{
  const minimal = { zones: [{ id: 'z', sensors: { temperature: [{ control: 'msw/T' }] }, devices: [] }] };
  check('минимальная зона валидна', validate(minimal), JSON.stringify(validate.errors && validate.errors[0]));
  const e = createEnv();
  e.control('msw/T', 20);
  e.config = minimal;
  e.runScript(path.join(ROOT, 'etc/wb-rules/wb-climate.js'));
  e.advance(30 * 1000);
  check('минимальная зона работает', e.get('z/temperature') === 20 && e.get('z/demand') === 100, e.get('z/demand'));
  const passive = {
    zones: [
      {
        id: 'p',
        sensors: { temperature: [{ control: 'msw/T' }] },
        devices: [{ type: 'convector', id: 'c1', valve: { topics: [{ control: 'r/K1' }] }, fan: { type: 'none' } }]
      }
    ]
  };
  check('пассивный конвектор без лишних полей валиден', validate(passive), JSON.stringify(validate.errors && validate.errors[0]));
}

console.log('\n=== 8. Пример с комментариями ===');
{
  const txt = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  let ex = null,
    exErr = null;
  try {
    // объект начинается со строки, первый символ которой «{» (в шапке скобок нет)
    ex = vm.runInNewContext('(' + txt.slice(txt.search(/^\{/m)) + ')');
  } catch (e) {
    exErr = e;
  }
  check('пример разбирается как литерал JavaScript', ex !== null, exErr && exErr.message);
  const p = ZONE.checkZones(ex.zones);
  check('в примере нет ошибок конфигурации', Object.keys(p).every((k) => p[k].length === 0), JSON.stringify(p));
  check('в примере все три вида вентиляторов', ['relays', 'analog', 'none'].every((t) => ex.zones[0].devices.some((d) => d.fan.type === t)));
}

R.done('schema.js');
