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
{
  const r = require('child_process').spawnSync('node', [path.join(ROOT, 'tools', 'make-schema.js'), '--check'], { encoding: 'utf8' });
  check('схема соответствует генератору tools/make-schema.js', r.status === 0, r.stdout.trim());
}

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
const withDev = (dev) => ({ zones: [Object.assign({}, conf.zones[0], { devices: [dev] })] });
const floorDev = { type: 'floor', id: 'floor1', valve: { topics: [{ control: 'r/K1' }] }, floorSensors: [{ control: 'w1/f' }], minFloor: 24, maxFloor: 29 };
check('тёплый пол проходит oneOf приборов', validate(withDev(floorDev)), JSON.stringify(validate.errors && validate.errors[0]));
check('пол с ролью «свои границы»', validate(withDev(Object.assign({}, floorDev, { role: 'custom', demandFrom: 0, demandTo: 60 }))), JSON.stringify(validate.errors && validate.errors[0]));
check('неизвестная роль отвергается', !validate(withDev(Object.assign({}, floorDev, { role: 'turbo' }))));
check('неизвестный тип прибора отвергается', !validate(withDev(Object.assign({}, floorDev, { type: 'radiator' }))));
check('четыре скорости реле отвергаются', !validate(zoneOf({ type: 'relays', speeds: [1, 2, 3, 4].map((i) => ({ control: 'a/K' + i })) })));
{
  const blank = JSON.parse(JSON.stringify(conf));
  blank.zones[0].id = '';
  blank.zones[0].title = '';
  blank.zones[0].devices[0].id = '';
  check('пустые id и названия допустимы (присвоятся сами)', validate(blank), JSON.stringify(validate.errors && validate.errors[0]));
}
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
for (const name of ['temperature', 'humidity', 'topics', 'speeds', 'out', 'enable', 'waterSensor', 'floorSensors']) {
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
// Названия типов приборов используются в заголовках: {{translate self.type}}
if (/translate self\.type/.test(JSON.stringify(schema))) {
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.properties && n.properties.type && Array.isArray(n.properties.type.enum)) {
      n.properties.type.enum.forEach((v) => {
        if (n.properties.valve) used.add(v); // только приборы (у них есть клапан)
      });
    }
    for (const k of Object.keys(n)) if (k !== 'translations') walk(n[k]);
  })(schema);
}
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
const zf = new ZONE.Zone({ id: 'f', sensors: { temperature: ['x/y'] }, devices: [{ type: 'floor', id: 'fl', valve: { topics: ['x/v3'] } }] }, []);
const fl = zf.devices[0];
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
  ['fan.speedBy', defs.fanRelays.properties.speedBy.default, c.speedBy],
  ['fan.deltaStep', defs.fanRelays.properties.deltaStep.default, c.deltaStep],
  ['fan.deltaHyst', defs.fanRelays.properties.deltaHyst.default, c.deltaHyst],
  ['fan.start', defs.fanRelays.properties.start.default, c.fanStart],
  ['fan.hyst', defs.fanRelays.properties.hyst.default, c.fanHyst],
  ['fan.minStepTime', defs.fanRelays.properties.minStepTime.default, c.fanStepMs / 1000],
  ['fan.delay', defs.fanRelays.properties.delay.default, c.fanDelayMs / 1000],
  ['fan.minWater', defs.fanRelays.properties.minWater.default, c.waterMin],
  ['fan.interlock', defs.fanRelays.properties.interlock.default, c.fan.interlockMs],
  ['fan.min', defs.fanAnalog.properties.min.default, c.fanMin],
  ['modbus.minChange', defs.fanModbus.properties.minChange.default, mb.fan.minChange],
  ['floor.minFloor', defs.floor.properties.minFloor.default, fl.minFloor],
  ['floor.maxFloor', defs.floor.properties.maxFloor.default, fl.maxFloor],
  ['floor.floorHyst', defs.floor.properties.floorHyst.default, fl.hyst],
  ['floor.valve.cycle', defs.floor.properties.valve.properties.cycle.default, fl.valve.cycleMs / 1000],
  ['floor.valve.minOn', defs.floor.properties.valve.properties.minOn.default, fl.valve.minOnMs / 1000],
  ['floor.valve.minOff', defs.floor.properties.valve.properties.minOff.default, fl.valve.minOffMs / 1000],
  ['floor.valve.openTime', defs.floor.properties.valve.properties.openTime.default, fl.valve.openTimeMs / 1000],
  ['role', defs.floor.properties.role.default, 'auto'],
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

console.log('\n=== 6а. В эталоне есть все поля формы ===');
{
  // Редактор формы прячет необязательные поля, которых нет в загруженном
  // конфиге: у прибора из эталона без role не было «Участия в нагреве».
  const missing = [];
  const pickOneOf = (node, data) => {
    for (const r of node.oneOf) {
      const d = schema.definitions[r.$ref.split('/').pop()];
      if (d.properties.type && d.properties.type.enum[0] === data.type) return d;
    }
    return null;
  };
  (function walk(node, data, p) {
    if (node.$ref) node = schema.definitions[node.$ref.split('/').pop()];
    if (node.oneOf) node = pickOneOf(node, data) || node;
    if (node.type === 'array' && node.items && Array.isArray(data)) {
      data.forEach((x, i) => {
        if (x && typeof x === 'object' && !Array.isArray(x)) walk(node.items, x, p + '/' + i);
      });
      return;
    }
    if (!node.properties || !data || typeof data !== 'object') return;
    for (const k of Object.keys(node.properties)) {
      if (!(k in data)) missing.push(p + '/' + k);
      else walk(node.properties[k], data[k], p + '/' + k);
    }
  })({ properties: schema.properties }, conf, '');
  check('ни одно поле не пропущено', missing.length === 0, missing.join(', '));
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

console.log('\n=== 8а. Заголовки элементов в форме ===');
{
  // Шаблонизатор веб-интерфейса Wiren Board (homeui, dumbtemplate.js):
  // {{if A == ""}}…{{else}}…{{endif}}, {{translate VAR}}, {{VAR}}.
  // Повторяем его разбор, чтобы заголовок совпадал с normalize().
  const render = (src, vars) => {
    const get = (expr) => {
      if (/^".*"$/.test(expr)) return expr.slice(1, -1);
      return expr.split('.').reduce((v, k) => (v == null ? v : v[k]), vars);
    };
    const str = (v) => (v === undefined || v === null || v === '' ? '' : String(v));
    return src
      .replace(/\{\{\s*if\s+([\w.\[\]]+?|".*?")\s*(==)\s*([\w.\[\]]+?|".*?")\s*\}\}(.*?)(?:\{\{else\}\}(.*?))?\{\{\s*endif\s*\}\}/g, (m, l, op, r, t, f) =>
        str(get(l)) == get(r) ? t || '' : f || ''
      )
      .replace(/\{\{\s*translate\s+([\w.\[\]]+?)\s*\}\}/g, (m, e) => {
        const v = str(get(e));
        return schema.translations.ru[v] !== undefined ? schema.translations.ru[v] : v;
      })
      .replace(/\{\{\s*([\w.\[\]]+?)\s*\}\}/g, (m, e) => str(get(e)));
  };
  const devHdr = schema.definitions.zone.properties.devices.items.headerTemplate;
  const zoneHdr = schema.definitions.zone.headerTemplate;
  const env = createEnv();
  const Z = env.require('wbclim-zone');
  const devs = [{ type: 'convector', title: 'У окна' }, { type: 'convector', title: '' }, { type: 'floor', title: '' }];
  const norm = Z.normalize([{ id: 'z', devices: devs }])[0].devices;
  const hdrs = devs.map((d, i) => render(devHdr, { self: d, i1: i + 1 }));
  check('заголовок прибора с названием — название', hdrs[0] === 'У окна', hdrs[0]);
  check('заголовки приборов без названия = названия, которые даст код', hdrs[1] === norm[1].title && hdrs[2] === norm[2].title, hdrs.join(' | ') + ' / ' + norm.map((d) => d.title).join(' | '));
  const zh = [render(zoneHdr, { self: { title: 'Гостиная' }, title: 'Помещение 1' }), render(zoneHdr, { self: { title: '' }, title: 'Помещение 2' })];
  const zn = Z.normalize([{ id: 'a', title: 'Гостиная' }, { title: '' }]);
  check('заголовки помещений: название, а без него — как у кода', zh[0] === 'Гостиная' && zh[1] === zn[1].title, zh.join(' | ') + ' / ' + zn[1].title);
}

{
  // «Как понять, где какая скорость?» — в таблице строки без подписи.
  // Обычный список: json-editor пишет над элементом «<title> <номер>».
  const sp = schema.definitions.fanRelays.properties.speeds;
  check('реле скоростей — список, а не безымянная таблица', sp.format !== 'table' && sp._format !== 'table', sp.format || sp._format);
  check('элемент подписан «Скорость» (→ «Скорость 1», «Скорость 2»)', schema.translations.ru[sp.items.title] === 'Скорость', sp.items.title);
  check('формат конфига прежний: [{control}]', sp.items.properties.control !== undefined && sp.maxItems === 3);
}

console.log('\n=== 9. Команда установки ===');
{
  // Одна строка без переменных: команда с U=... во второй строке,
  // вызванная из истории терминала без первой, падала «Scheme missing»
  // (на контроллере 2026-10-02). README и страница релиза — одинаково
  // (wbmix, грабля №16).
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const rel = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const cmd = (txt) =>
    txt
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /wget .*wb-climate_all\.deb/.test(l)) || '';
  const a = cmd(readme);
  const b = cmd(rel);
  const ok = (c) => /^wget -O \/tmp\/wbclim\.deb https:\/\/\S+\/wb-climate_all\.deb && dpkg -i --force-confold \/tmp\/wbclim\.deb$/.test(c) && c.indexOf('$U') < 0;
  check('README: одна строка, без переменных, с --force-confold', ok(a), a);
  const bn = b.replace('${{ github.repository }}', 'suskirov-commits/wb-climate').replace('${{ github.ref_name }}', 'vX');
  const an = a.replace('latest/download', 'download/vX');
  check('страница релиза: та же команда для своей версии', ok(bn) && an === bn, b);
}

R.done('schema.js');
