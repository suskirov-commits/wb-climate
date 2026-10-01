/**
 * bundle.js — однофайловая сборка dist/wb-climate.js и синтаксис ES5.
 *
 * Сборка грузится так, как это делает wb-rules: единый сценарий, никаких
 * внешних модулей. Проверяется, что зоны поднимаются и работают, что
 * повторная загрузка (сохранение в веб-интерфейсе) не плодит такты, что
 * dist/ соответствует исходникам и что весь код — ECMAScript 5
 * (duktape в wb-rules не понимает let/const/=>).
 *
 * Запуск: node test/bundle.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const acorn = require('acorn');
const { createEnv, makeChecker, ROOT } = require('./harness');

const R = makeChecker();
const check = R.check;
const BUNDLE = path.join(ROOT, 'dist', 'wb-climate.js');

console.log('\n=== 1. Сборка соответствует исходникам ===');
{
  const before = fs.existsSync(BUNDLE) ? fs.readFileSync(BUNDLE, 'utf8') : '';
  cp.execFileSync('node', [path.join(ROOT, 'tools', 'make-bundle.js')], { stdio: 'pipe' });
  const after = fs.readFileSync(BUNDLE, 'utf8');
  check('dist/wb-climate.js актуален (иначе: make build)', before === after);
  cp.execFileSync('node', [path.join(ROOT, 'tools', 'make-bundle.js')], { stdio: 'pipe' });
  check('сборка воспроизводима побайтово', fs.readFileSync(BUNDLE, 'utf8') === after);
}

console.log('\n=== 2. Синтаксис ECMAScript 5 ===');
const files = fs
  .readdirSync(path.join(ROOT, 'etc', 'wb-rules-modules'))
  .map((f) => path.join(ROOT, 'etc', 'wb-rules-modules', f))
  .concat([path.join(ROOT, 'etc', 'wb-rules', 'wb-climate.js'), BUNDLE]);
for (const f of files) {
  let e = null;
  try {
    acorn.parse(fs.readFileSync(f, 'utf8'), { ecmaVersion: 5, sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (x) {
    e = x;
  }
  check(path.relative(ROOT, f).replace(/\\/g, '/'), e === null, e && e.message);
}

console.log('\n=== 3. Работа сборки ===');
const proto = {};
const env = createEnv({ globalProto: proto });
const T = 'wb-msw-v3_21/Temperature';
env.control(T, 20);
env.control('wb-msw-v3_21/Humidity', 45);
for (let k = 1; k <= 6; k++) env.control('wb-mr6c_45/K' + k, false);
env.control('wb-mao4_12/Channel 1', 0);
env.runScript(BUNDLE);
env.advance(5 * 1000);
check('создано устройство зоны из CONFIG', !!env.devices.climate_living);
check('на карточке температура', env.get('climate_living/temperature') === 20, env.get('climate_living/temperature'));
check('три конвектора на карточке', ['conv1', 'conv2', 'conv3'].every((d) => (d + '_status') in env.devices.climate_living.cells));
check('потребность при 20 °C и уставке 22 — 100 %', env.get('climate_living/demand') === 100, env.get('climate_living/demand'));
check('термоголовки открыты', env.get('wb-mr6c_45/K1') && env.get('wb-mr6c_45/K5') && env.get('wb-mr6c_45/K6'));
env.advance(200 * 1000);
check('вентилятор на реле — третья скорость', env.get('wb-mr6c_45/K4') === true);
check('вентилятор 0-10 В — 10000 мВ', env.get('wb-mao4_12/Channel 1') === 10000, env.get('wb-mao4_12/Channel 1'));
check('ошибок в журнале нет', !env.logs.some((l) => /^E /.test(l)), env.logs.filter((l) => /^E /.test(l)).join(' | '));

console.log('\n=== 4. Повторная загрузка (сохранение в веб-интерфейсе) ===');
const timers1 = env.timers.size;
const mark = env.writes.length;
env.runScript(BUNDLE);
env.runScript(BUNDLE);
env.advance(5 * 1000);
check('таймеров не прибавилось', env.timers.size <= timers1, timers1 + ' -> ' + env.timers.size);
const offs = env.writes.slice(mark).filter((w) => /^wb-mr6c_45\//.test(w[0]) && w[1] === false);
check('выходы не дёргались', offs.length === 0, JSON.stringify(offs));
check('вентилятор не ушёл на прогрев заново', env.get('wb-mr6c_45/K4') === true);
const zone = proto.__wbclimShared && proto.__wbclimShared.zones && proto.__wbclimShared.zones.climate_living;
let ticks = 0;
const orig = zone._tick.bind(zone);
zone._tick = () => (ticks++, orig());
env.advance(100 * 1000);
check('один тактовый цикл: 10 тактов за 100 с', ticks === 10, ticks);

R.done('bundle.js');
