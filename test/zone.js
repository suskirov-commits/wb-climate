/**
 * zone.js — поведение зоны и конвекторов на эмуляторе wb-rules.
 *
 * Запуск: node test/zone.js
 */
'use strict';
const { createEnv, makeChecker } = require('./harness');

const R = makeChecker();
const check = R.check;

const TEMP = 'msw/Temperature',
  TEMP2 = 'ms/Temperature',
  HUM = 'msw/Humidity',
  VALVE = 'mr6c_1/K1',
  S1 = 'mr6c_1/K2',
  S2 = 'mr6c_1/K3',
  S3 = 'mr6c_1/K4',
  AO = 'mao4/Channel 1',
  AO_EN = 'mr6c_1/K5',
  MB = 'conv_mb/Fan Speed',
  WATER = 'w1/28-0001',
  WIN = 'mcm8/Input 1';

/** Среда с типовыми контролами. */
function makeEnv(opts) {
  const env = createEnv(opts);
  env.control(TEMP, 18);
  env.control(TEMP2, 18);
  env.control(HUM, 40);
  for (const t of [VALVE, S1, S2, S3, AO_EN, 'mr6c_2/K1', 'mr6c_2/K2']) env.control(t, false);
  env.control(AO, 0);
  env.control(MB, 0);
  env.control(WATER, 20);
  env.control(WIN, false);
  return env;
}

function relaysZone(extra) {
  return Object.assign(
    {
      id: 'room',
      title: 'Комната',
      defaultSetpoint: 22,
      sensors: { temperature: [TEMP], tau: 0 },
      control: { period: 10 },
      devices: [
        {
          type: 'convector',
          id: 'conv',
          title: 'Конвектор',
          valve: { topics: [VALVE] },
          fan: { type: 'relays', speeds: [S1, S2, S3] }
        }
      ]
    },
    extra || {}
  );
}

/**
 * Температура в помещении меняется плавно: скачок больше ~3 К за такт
 * фильтр выбросов датчика справедливо считает сбоем шины. Большие
 * изменения подаём шагами по 0,8 К каждые 10 с.
 */
function setT(env, v) {
  let cur = env.get(TEMP);
  while (typeof cur === 'number' && Math.abs(v - cur) > 0.8) {
    cur = Math.round((cur + Math.sign(v - cur) * 0.8) * 100) / 100;
    env.set(TEMP, cur);
    env.advance(10 * 1000);
  }
  env.set(TEMP, v);
}

const speed = (env) => (env.get(S3) ? 3 : 0) + (env.get(S2) ? 2 : 0) + (env.get(S1) ? 1 : 0);
const onCount = (env) => [S1, S2, S3].filter((t) => env.get(t) === true).length;

/* ================================================================== */
console.log('\n=== 1. Конвектор: чем больше разница, тем сильнее воздействие ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  // ti 0 — чистый П: проверяем ровно описанную логику
  ZONE.create(relaysZone({ control: { period: 10, band: 2, ti: 0 } }));
  setT(env, 18); // разница 4 К при band 2 — потребность 100 %
  env.advance(1000);
  check('большая разница: клапан открыт сразу', env.get(VALVE) === true);
  check('потребность 100 %', env.get('room/demand') === 100, env.get('room/demand'));
  check('вентилятор ждёт прогрева теплообменника', speed(env) === 0, speed(env));
  check('в статусе — прогрев', /прогрев/.test(env.get('room/conv_status')), env.get('room/conv_status'));
  env.advance(170 * 1000);
  check('через 171 с вентилятор ещё стоит', speed(env) === 0);
  env.advance(20 * 1000);
  check('после прогрева — максимальная скорость', speed(env) === 3 && env.get(S3) === true, speed(env));
  check('включено одно реле скорости', onCount(env) === 1);

  // Подходим к уставке: скорость падает до нуля, затем закрывается клапан
  const seen = [];
  let maxOn = 0;
  for (let t = 18; t <= 22.3; t += 0.05) {
    env.set(TEMP, Math.round(t * 100) / 100);
    for (let k = 0; k < 9; k++) {
      env.advance(10 * 1000);
      maxOn = Math.max(maxOn, onCount(env));
    }
    seen.push([t, speed(env), env.get(VALVE)]);
  }
  const speeds = seen.map((x) => x[1]);
  let mono = true;
  for (let i = 1; i < speeds.length; i++) if (speeds[i] > speeds[i - 1]) mono = false;
  check('скорость только снижается по мере подхода к уставке', mono, speeds.join(''));
  check('пройдены все ступени 3-2-1-0', [3, 2, 1, 0].every((s) => speeds.indexOf(s) >= 0), speeds.join(''));
  check('никогда не включено больше одного реле скорости', maxOn <= 1, maxOn);
  const atSp = seen.filter((x) => x[0] < 21.99);
  check('ниже уставки клапан открыт', atSp.every((x) => x[2] === true));
  check('уставка достигнута — клапан закрыт', env.get(VALVE) === false);
  check('вентилятор стоит при закрытом клапане', speed(env) === 0);
  const fanZero = seen.findIndex((x) => x[1] === 0);
  const valveOff = seen.findIndex((x) => x[2] === false);
  check('сначала останавливается вентилятор, потом закрывается клапан', fanZero >= 0 && fanZero < valveOff, fanZero + ' / ' + valveOff);
  check('состояние «Уставка достигнута»', env.get('room/state') === 'Уставка достигнута', env.get('room/state'));
}

/* ================================================================== */
console.log('\n=== 2. Ступени: пауза при смене скорости, выдержка, гистерезис ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone({ control: { period: 10, band: 2, ti: 0 } }));
  setT(env, 18);
  env.advance(200 * 1000);
  check('старт: скорость 3', speed(env) === 3);
  // Падение потребности: 3 -> 1. Пауза между выключением и включением.
  const mark = env.writes.length;
  setT(env, 21.4); // e 0.6 -> 30 % -> скорость 1
  env.advance(30 * 1000);
  const w = env.writes.slice(mark).filter((x) => [S1, S2, S3].indexOf(x[0]) >= 0);
  const off3 = w.find((x) => x[0] === S3 && x[1] === false);
  const on1 = w.find((x) => x[0] === S1 && x[1] === true);
  check('скорость сменилась на 1', speed(env) === 1, speed(env));
  check('старое реле выключено раньше нового', off3 && on1 && off3[2] < on1[2], JSON.stringify(w));
  check('пауза между ними не меньше 500 мс', off3 && on1 && on1[2] - off3[2] >= 500, on1 && off3 && on1[2] - off3[2]);

  // Выдержка: сразу после смены ступени новая смена не раньше 60 с
  setT(env, 20.3); // 85 % -> хотелось бы 3
  env.advance(20 * 1000);
  check('через 20 с после смены ступень не меняется', speed(env) === 1, speed(env));
  env.advance(50 * 1000);
  check('после выдержки ступень поднялась', speed(env) === 3, speed(env));

  // Гистерезис: потребность чуть ниже порога ступени — остаётся
  // пороги при start 20: 20 / 46.7 / 73.3; гистерезис 10
  setT(env, 22 - 0.68 * 2); // 68 % — между 73.3 − 10 и 73.3
  env.advance(120 * 1000);
  check('внутри гистерезиса скорость 3 держится', speed(env) === 3, speed(env));
  setT(env, 22 - 0.6 * 2); // 60 % — ниже 63.3
  env.advance(120 * 1000);
  check('ниже гистерезиса — скорость 2', speed(env) === 2, speed(env));
}

/* ================================================================== */
console.log('\n=== 3. П + И: недобор снимается, клапан закрывается при перегреве ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone()); // по умолчанию band 1.5, ti 30
  const z = ZONE.get('room');
  check('по умолчанию зона пропорциональности 1,5 К', env.get('room/band') === 1.5, env.get('room/band'));
  check('по умолчанию время интегрирования 30 мин', env.get('room/ti') === 30, env.get('room/ti'));
  setT(env, 21.8); // постоянный недобор 0,2 К
  env.advance(60 * 60 * 1000);
  check('интегральная часть растёт при недоборе', z.integral > 20, z.integral);
  check('потребность выше чистого П (13 %)', z.demand > 30, z.demand);
  const iBefore = z.integral;
  setT(env, 22.6); // перегрев
  env.advance(30 * 1000);
  check('перегрев: потребность 0', z.demand === 0, z.demand);
  env.advance(10 * 60 * 1000);
  check('перегрев: И-часть убывает', z.integral < iBefore, z.integral + ' < ' + iBefore);
  check('перегрев: клапан закрыт', env.get(VALVE) === false);
  // anti-windup: при насыщении 100 % И не растёт
  setT(env, 15);
  env.advance(10 * 1000);
  const iSat = z.integral;
  env.advance(30 * 60 * 1000);
  check('anti-windup: при 100 % И не копится', z.integral <= iSat + 0.01, iSat + ' -> ' + z.integral);
  env.set('room/ti', 0);
  env.advance(20 * 1000);
  check('ti = 0 — чистый П, И обнулена', z.integral === 0, z.integral);
}

/* ================================================================== */
console.log('\n=== 4. Термоголовка: минимальные времена, NO, ШИМ ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone({ control: { period: 10, band: 2, ti: 0 } }));
  setT(env, 21);
  env.advance(1000);
  check('открыта', env.get(VALVE) === true);
  setT(env, 22.5);
  env.advance(60 * 1000);
  check('мин. время открытия 120 с: через 61 с ещё открыта', env.get(VALVE) === true);
  env.advance(70 * 1000);
  check('после 120 с закрылась', env.get(VALVE) === false);
  setT(env, 21);
  env.advance(60 * 1000);
  check('мин. время в закрытом 120 с: через 60 с ещё закрыта', env.get(VALVE) === false);
  env.advance(70 * 1000);
  check('после 120 с открылась', env.get(VALVE) === true);
  // выключение зоны — без выдержки
  env.set('room/enabled', false);
  env.advance(1000);
  check('выключение зоны закрывает клапан сразу', env.get(VALVE) === false);
  check('состояние «Выключено»', env.get('room/state') === 'Выключено');
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone();
  cfg.devices[0].valve.normallyOpen = true;
  cfg.devices[0].fan = { type: 'none' };
  ZONE.create(cfg);
  setT(env, 25);
  env.advance(1000);
  check('NO-термоголовка: закрыть = реле включено', env.get(VALVE) === true && env.get('room/conv_valve') === false);
  setT(env, 18);
  env.advance(200 * 1000);
  check('NO-термоголовка: открыть = реле выключено', env.get(VALVE) === false && env.get('room/conv_valve') === true);
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ control: { period: 10 } });
  cfg.devices[0].valve = { topics: [VALVE], mode: 'pwm', cycle: 900, minOn: 120, minOff: 120 };
  cfg.devices[0].fan = { type: 'none' };
  cfg.mode = 1;
  ZONE.create(cfg);
  env.set('room/mode', 1);
  env.set('room/manual_demand', 40);
  env.advance(1000);
  let on = 0;
  for (let i = 0; i < 180; i++) {
    env.advance(10 * 1000);
    if (env.get(VALVE)) on++;
  }
  check('ШИМ 40 %: открыт ~40 % времени', Math.abs(on / 180 - 0.4) < 0.05, Math.round((100 * on) / 180) + ' %');
  env.set('room/manual_demand', 10); // 90 с < minOn — не открывать
  env.advance(1000 * 1000);
  let on2 = 0;
  for (let i = 0; i < 90; i++) {
    env.advance(10 * 1000);
    if (env.get(VALVE)) on2++;
  }
  check('ШИМ: импульс короче минимального не выдаётся', on2 === 0, on2);
  env.set('room/manual_demand', 95); // пауза 45 с < minOff — держать открытым
  env.advance(1000 * 1000);
  let off3 = 0;
  for (let i = 0; i < 90; i++) {
    env.advance(10 * 1000);
    if (!env.get(VALVE)) off3++;
  }
  check('ШИМ: пауза короче минимальной не выдаётся', off3 === 0, off3);
}

/* ================================================================== */
console.log('\n=== 5. Защита от холодного дутья по датчику воды ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone();
  cfg.devices[0].waterSensor = WATER;
  ZONE.create(cfg);
  env.set(WATER, 22);
  setT(env, 18);
  env.advance(400 * 1000);
  check('вода 22 °C — вентилятор стоит даже после задержки', speed(env) === 0 && env.get(VALVE) === true);
  check('в статусе — ждёт горячую воду', /горячую воду/.test(env.get('room/conv_status')), env.get('room/conv_status'));
  env.set(WATER, 35);
  env.advance(30 * 1000);
  check('вода 35 °C — вентилятор пошёл', speed(env) === 3, speed(env));
  env.set(WATER, 28.5);
  env.advance(30 * 1000);
  check('гистерезис: при 28,5 °C продолжает', speed(env) === 3);
  env.set(WATER, 26);
  env.advance(30 * 1000);
  check('вода остыла до 26 °C — вентилятор остановлен', speed(env) === 0);
  env.setError(WATER, 'r');
  env.advance(60 * 1000);
  check('датчик воды отказал — работает по таймеру', speed(env) === 3, speed(env));
  check('отказ датчика воды — в аварии', /датчик воды/.test(env.get('room/alarm_text')), env.get('room/alarm_text'));
  env.setError(WATER, '');
  env.set(WATER, 40);
  env.advance(60 * 1000);
  check('датчик воды вернулся — авария снята', !/датчик воды/.test(env.get('room/alarm_text')), env.get('room/alarm_text'));
}

/* ================================================================== */
console.log('\n=== 6. Окно ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone({ window: { topics: [WIN], delay: 30 } }));
  const z = ZONE.get('room');
  setT(env, 20);
  env.advance(400 * 1000);
  check('до окна: нагрев идёт', env.get(VALVE) === true && speed(env) > 0);
  env.set(WIN, true);
  env.advance(10 * 1000);
  check('проветривание короче задержки — нагрев не прерывается', env.get(VALVE) === true);
  env.advance(30 * 1000);
  check('окно открыто дольше 30 с — клапан закрыт', env.get(VALVE) === false);
  check('вентилятор остановлен', speed(env) === 0);
  check('состояние «Окно открыто»', env.get('room/state') === 'Окно открыто');
  const iw = z.integral;
  env.advance(20 * 60 * 1000);
  check('интегратор заморожен', z.integral === iw, iw + ' -> ' + z.integral);
  env.set(WIN, false);
  env.advance(2 * 1000);
  check('окно закрыли — клапан открыт сразу', env.get(VALVE) === true);
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone({ window: { topics: [WIN], invert: true, delay: 0 } }));
  setT(env, 20);
  env.advance(1000);
  check('инверсия датчика окна: false = открыто', env.get(VALVE) === false && env.get('room/window') === true);
}

/* ================================================================== */
console.log('\n=== 7. Защита от замерзания, отказ датчиков ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone({ defaultEnabled: false }));
  setT(env, 12);
  env.advance(1000);
  check('выключена, 12 °C — клапан закрыт', env.get(VALVE) === false);
  setT(env, 6.5);
  env.advance(30 * 1000);
  check('выключена, 6,5 °C — защита от замерзания открывает клапан', env.get(VALVE) === true);
  check('авария «защита от замерзания»', /замерзания/.test(env.get('room/alarm_text')));
  setT(env, 8);
  env.advance(200 * 1000);
  check('гистерезис: при 8 °C продолжает греть', env.get(VALVE) === true);
  setT(env, 9.5);
  env.advance(200 * 1000);
  check('выше 9 °C — снова выключено', env.get(VALVE) === false && env.get('room/state') === 'Выключено');
  check('авария снята', env.get('room/alarm') === false, env.get('room/alarm_text'));
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone();
  cfg.sensors = { temperature: [TEMP, TEMP2], humidity: HUM, tau: 0 };
  ZONE.create(cfg);
  setT(env, 20);
  env.set(TEMP2, 21);
  env.advance(15 * 1000);
  check('два датчика — среднее', env.get('room/temperature') === 20.5, env.get('room/temperature'));
  check('влажность на карточке', env.get('room/humidity') === 40, env.get('room/humidity'));
  env.setError(TEMP2, 'r');
  env.advance(40 * 1000);
  check('отказ одного — работает по второму', env.get('room/temperature') === 20, env.get('room/temperature'));
  check('отказ одного — авария с адресом датчика', /ms\/Temperature/.test(env.get('room/alarm_text')), env.get('room/alarm_text'));
  check('нагрев продолжается', env.get(VALVE) === true);
  env.setError(TEMP, 'r');
  env.advance(40 * 1000);
  check('отказ всех — состояние «Авария»', env.get('room/state') === 'Авария', env.get('room/state'));
  env.advance(200 * 1000);
  check('отказ всех — клапан закрыт (безопасная потребность 0)', env.get(VALVE) === false && speed(env) === 0);
  env.setError(TEMP, '');
  env.setError(TEMP2, '');
  setT(env, 19);
  env.set(TEMP2, 19.2);
  env.advance(60 * 1000);
  check('датчики вернулись — авария снята', env.get('room/alarm') === false, env.get('room/alarm_text'));
  check('нагрев возобновлён', env.get(VALVE) === true);
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ safety: { failSafeDemand: 30 } });
  ZONE.create(cfg);
  setT(env, 20);
  env.advance(15 * 1000);
  env.setError(TEMP, 'r');
  env.advance(300 * 1000);
  check('failSafeDemand 30 — клапан открыт при отказе датчика', env.get(VALVE) === true && env.get('room/demand') === 30);
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone({ sensors: { temperature: [TEMP], tau: 0 } }));
  setT(env, 21.9);
  env.advance(30 * 1000);
  env.set(TEMP, 85); // обрыв 1-Wire — скачком
  env.advance(10 * 1000);
  check('выброс 85 °C отбракован', env.get('room/temperature') === 21.9, env.get('room/temperature'));
  check('по выбросу клапан не закрылся', env.get(VALVE) === true);
}

/* ================================================================== */
console.log('\n=== 8. Ручная потребность, уставка ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone());
  setT(env, 25);
  env.set('room/mode', 1);
  env.set('room/manual_demand', 100);
  env.advance(200 * 1000);
  check('ручная 100 %: клапан и максимальная скорость при 25 °C', env.get(VALVE) === true && speed(env) === 3);
  check('состояние «Ручная потребность»', env.get('room/state') === 'Ручная потребность');
  env.set('room/manual_demand', 30);
  env.advance(70 * 1000);
  check('ручная 30 %: скорость 1', speed(env) === 1, speed(env));
  env.set('room/mode', 0);
  env.advance(200 * 1000);
  check('возврат в авто: при 25 °C всё выключено', env.get(VALVE) === false && speed(env) === 0);

  env.set('room/setpoint', 25.37);
  env.advance(1000);
  check('уставка округляется до 0,1', env.get('room/setpoint') === 25.4, env.get('room/setpoint'));
  env.set('room/setpoint', 100);
  env.advance(1000);
  check('уставка ограничена сверху (30)', env.get('room/setpoint') === 30, env.get('room/setpoint'));
  env.set('room/setpoint', 'abc');
  env.advance(1000);
  check('мусор вместо уставки — значение по умолчанию', env.get('room/setpoint') === 22, env.get('room/setpoint'));
}

/* ================================================================== */
console.log('\n=== 9. Вентилятор 0-10 В и Modbus ===');
{
  const env = makeEnv();
  env.store[AO] = 7000; // после рестарта на выходе осталось старое значение
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ control: { period: 10, band: 2, ti: 0 } });
  cfg.devices[0].fan = { type: 'analog', out: AO, enable: AO_EN, min: 20, delay: 0 };
  ZONE.create(cfg);
  setT(env, 23);
  env.advance(1000);
  check('первая команда 0 мВ записана (а не пропущена)', env.get(AO) === 0, env.get(AO));
  setT(env, 18);
  env.advance(20 * 1000);
  check('100 % -> 10000 мВ', env.get(AO) === 10000, env.get(AO));
  check('реле питания включено', env.get(AO_EN) === true);
  setT(env, 22 - 0.2 * 2 - 0.001); // 20 % — старт, минимальная скорость
  env.advance(20 * 1000);
  check('порог старта -> минимальная скорость 2000 мВ', env.get(AO) === 2000, env.get(AO));
  setT(env, 22 - 0.6 * 2); // 60 % -> 20 + 80*0.5 = 60 %
  env.advance(20 * 1000);
  check('60 % потребности -> 6000 мВ', env.get(AO) === 6000, env.get(AO));
  setT(env, 22 - 0.12 * 2); // 12 % — внутри гистерезиса остановки (20 − 10)
  env.advance(20 * 1000);
  check('внутри гистерезиса — минимальная скорость', env.get(AO) === 2000, env.get(AO));
  setT(env, 22 - 0.08 * 2); // 8 % — ниже 20 − 10
  env.advance(20 * 1000);
  check('ниже порога с гистерезисом — 0 мВ', env.get(AO) === 0, env.get(AO));
  check('реле питания выключено', env.get(AO_EN) === false);
  setT(env, 18);
  env.advance(20 * 1000);
  env.store[AO] = 0; // модуль перезапустился и сбросил выход
  env.advance(70 * 1000);
  check('выход восстановлен после сброса модуля', env.get(AO) === 10000, env.get(AO));
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ control: { period: 10, band: 2, ti: 0 } });
  cfg.devices[0].fan = { type: 'modbus', out: MB, steps: 3, delay: 0 };
  ZONE.create(cfg);
  setT(env, 18);
  env.advance(20 * 1000);
  check('Modbus, 3 ступени: 100 % -> 3', env.get(MB) === 3, env.get(MB));
  setT(env, 21.4);
  env.advance(80 * 1000);
  check('Modbus: 30 % -> 1', env.get(MB) === 1, env.get(MB));
  setT(env, 23);
  env.advance(200 * 1000);
  check('Modbus: уставка достигнута -> 0', env.get(MB) === 0, env.get(MB));
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ control: { period: 10, band: 2, ti: 0 } });
  cfg.devices[0].fan = { type: 'modbus', out: MB, steps: 0, valueMin: 0, valueMax: 100, min: 30, delay: 0 };
  ZONE.create(cfg);
  setT(env, 18);
  env.advance(20 * 1000);
  check('Modbus плавно: 100 % -> 100', env.get(MB) === 100, env.get(MB));
  setT(env, 21.4); // 30 % -> 30 + 70*(10/80)=38.75 -> 39
  env.advance(20 * 1000);
  check('Modbus плавно: 30 % потребности -> 39', env.get(MB) === 39, env.get(MB));
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ control: { period: 10, band: 2, ti: 0 } });
  cfg.devices[0].fan = { type: 'modbus', out: MB, values: [30, 60, 100], delay: 0 };
  ZONE.create(cfg);
  env.set(TEMP, 18);
  env.advance(20 * 1000);
  check('Modbus, ступени со значениями: 100 % -> 100', env.get(MB) === 100, env.get(MB));
  check('на карточке — номер ступени', env.get('room/conv_fan') === 3, env.get('room/conv_fan'));
  setT(env, 21.4);
  env.advance(80 * 1000);
  check('Modbus, ступени со значениями: 30 % потребности -> 30', env.get(MB) === 30, env.get(MB));
  env.store[MB] = 0; // плата сбросила регистр
  env.advance(70 * 1000);
  check('сброшенная ступень восстановлена', env.get(MB) === 30, env.get(MB));
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ control: { period: 10, band: 2, ti: 0 } });
  cfg.devices[0].fan = { type: 'modbus', out: MB, steps: 3, delay: 0 };
  ZONE.create(cfg);
  env.set(TEMP, 18);
  env.advance(20 * 1000);
  env.store[MB] = 2; // плата показала другую ступень
  env.advance(70 * 1000);
  check('Modbus, ступени: расхождение на одну ступень исправляется', env.get(MB) === 3, env.get(MB));
}
{
  // Плавный Modbus: мелкие изменения не пишутся (ресурс памяти платы)
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ control: { period: 10, band: 2, ti: 0 } });
  cfg.devices[0].fan = { type: 'modbus', out: MB, steps: 0, min: 20, delay: 0 };
  ZONE.create(cfg);
  env.set(TEMP, 21.2); // 40 % -> 20 + 80*0.25 = 40 %
  env.advance(20 * 1000);
  check('плавно: 40 % потребности -> 40', env.get(MB) === 40, env.get(MB));
  const mark = env.writes.length;
  for (const t of [21.18, 21.16, 21.19, 21.15, 21.17]) {
    env.set(TEMP, t); // потребность 41–42,5 % -> скорость 41–43 %
    env.advance(10 * 1000);
  }
  check('изменения меньше 5 % не пишутся', env.countWrites(MB, mark) === 0, env.countWrites(MB, mark));
  env.set(TEMP, 20.9); // 55 % -> 55
  env.advance(20 * 1000);
  check('изменение на 15 % записано', env.get(MB) === 55, env.get(MB));
  setT(env, 19);
  env.advance(20 * 1000);
  check('выход на 100 % записан всегда', env.get(MB) === 100, env.get(MB));
  setT(env, 23);
  env.advance(200 * 1000);
  check('остановка записана всегда', env.get(MB) === 0, env.get(MB));
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ control: { period: 10, band: 2, ti: 0 } });
  cfg.devices[0].fan = { type: 'relays', speeds: [S1, S2, S3], relayMode: 'cumulative', delay: 0 };
  ZONE.create(cfg);
  setT(env, 18);
  env.advance(20 * 1000);
  check('cumulative: скорость 3 = все три реле', env.get(S1) && env.get(S2) && env.get(S3));
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const cfg = relaysZone({ control: { period: 10, band: 2, ti: 0 } });
  cfg.devices[0].fan = { type: 'relays', speeds: [S1, S2], delay: 0 };
  ZONE.create(cfg);
  setT(env, 18);
  env.advance(20 * 1000);
  check('двухскоростной: 100 % -> вторая скорость', env.get(S2) === true && env.get(S1) === false);
}

/* ================================================================== */
console.log('\n=== 10. Связь с модулями, восстановление выходов ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone());
  setT(env, 18);
  env.advance(200 * 1000);
  env.setError(S2, 'w');
  env.advance(20 * 1000);
  check('нет связи с реле скорости — авария', /вентилятор: нет связи/.test(env.get('room/alarm_text')), env.get('room/alarm_text'));
  env.setError(S2, '');
  env.advance(20 * 1000);
  check('связь вернулась — авария снята', env.get('room/alarm') === false, env.get('room/alarm_text'));
  env.store[VALVE] = false; // модуль реле перезапустился
  env.store[S3] = false;
  env.advance(20 * 1000);
  check('реле клапана восстановлено', env.get(VALVE) === true);
  check('реле скорости восстановлено', env.get(S3) === true);
}

/* ================================================================== */
console.log('\n=== 11. Проверка конфигурации до запуска ===');
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const blank = {
    id: 'blank',
    title: 'Пустая',
    sensors: { temperature: [''] },
    devices: [{ type: 'convector', id: 'conv1', valve: { topics: [''] }, fan: { type: 'relays', speeds: ['', '', ''] } }]
  };
  const mark = env.writes.length;
  ZONE.create(blank);
  env.advance(60 * 1000);
  const ext = env.writes.slice(mark).filter((w) => w[0].indexOf('blank/') !== 0);
  check('эталон с пустыми топиками ничего не переключает', ext.length === 0, JSON.stringify(ext));
  check('состояние «Ошибка настройки»', env.get('blank/state') === 'Ошибка настройки');
  const txt = env.get('blank/alarm_text');
  check('в аварии перечислено незаполненное', /датчик температуры/.test(txt) && /термоголовка/.test(txt) && /реле скоростей/.test(txt), txt);
}
{
  const env = makeEnv();
  const ZONE = env.require('wbclim-zone');
  const a = relaysZone({ id: 'a', title: 'A' });
  const b = relaysZone({ id: 'b', title: 'B' });
  b.devices[0].valve.topics = ['mr6c_2/K1'];
  b.devices[0].fan = { type: 'relays', speeds: ['mr6c_2/K2', S2] }; // S2 — чужое
  const p = ZONE.checkZones([a, b]);
  check('одно реле в двух зонах — ошибка у обеих', p.a.length === 1 && p.b.length === 1, JSON.stringify(p));
  check('в тексте — адрес и чужая зона', /mr6c_1\/K3/.test(p.b[0]) && /зона «A»/.test(p.b[0]), p.b[0]);
  const c = relaysZone({ id: 'c' });
  c.devices.push({ id: 'conv', valve: { topics: [VALVE] } });
  const pc = ZONE.checkZones([c]).c;
  check('повтор id исполнителя', pc.some((x) => /повторяется/.test(x)), JSON.stringify(pc));
  check('реле клапана в двух конвекторах одной зоны', pc.some((x) => /уже используется/.test(x)), JSON.stringify(pc));
  const d = relaysZone({ id: 'd' });
  d.devices[0].type = 'heatpump';
  check('неизвестный тип исполнителя', /неизвестный тип/.test(ZONE.checkZones([d]).d.join()), ZONE.checkZones([d]).d.join());
  const e = relaysZone({ id: 'e' });
  e.devices[0].id = 'Conv-1';
  check('id исполнителя с недопустимыми символами', /латиница/.test(ZONE.checkZones([e]).e.join()));
  const ok = ZONE.checkZones([relaysZone({ id: 'ok' }), Object.assign(relaysZone({ id: 'ok2' }), { devices: [] })]);
  check('правильная конфигурация — без ошибок', ok.ok.length === 0 && ok.ok2.length === 0, JSON.stringify(ok));
  const shared = relaysZone({ id: 's1' });
  const shared2 = relaysZone({ id: 's2' });
  shared2.devices = [];
  check('общий датчик у двух зон — не ошибка', ZONE.checkZones([shared, shared2]).s2.length === 0);
}

/* ================================================================== */
console.log('\n=== 12. Перезагрузка сценария и перезапуск контроллера ===');
{
  const statics = {},
    storages = {};
  const env = makeEnv({ statics, storages });
  const ZONE = env.require('wbclim-zone');
  ZONE.create(relaysZone());
  setT(env, 21.5);
  env.advance(40 * 60 * 1000);
  const z1 = ZONE.get('room');
  const i1 = z1.integral;
  const sp1 = speed(env);
  check('до перезагрузки клапан открыт, вентилятор работает', env.get(VALVE) === true && sp1 > 0, sp1);
  const timersBefore = env.timers.size;
  // перезагрузка: тот же module.static, сценарий выполняется заново
  const mark = env.writes.length;
  ZONE.create(relaysZone());
  const z2 = ZONE.get('room');
  env.advance(15 * 1000);
  check('после перезагрузки один тактовый цикл', env.timers.size <= timersBefore, timersBefore + ' -> ' + env.timers.size);
  check('интегратор перенесён', Math.abs(z2.integral - i1) < 1, i1 + ' -> ' + z2.integral);
  const offs = env.writes.slice(mark).filter((w) => w[1] === false && [VALVE, S1, S2, S3].indexOf(w[0]) >= 0);
  check('выходы не сбрасывались (вентилятор не ждёт прогрева заново)', offs.length === 0 && speed(env) === sp1, JSON.stringify(offs));
  let ticks = 0;
  const orig = z2._tick.bind(z2);
  z2._tick = () => (ticks++, orig());
  env.advance(100 * 1000);
  check('старый экземпляр не тикает (10 тактов за 100 с)', ticks === 10, ticks);
  // зону убрали из конфигурации
  ZONE.prune([]);
  env.advance(1000);
  check('удалённая зона гасит выходы', env.get(VALVE) === false && speed(env) === 0);

  // «перезапуск контроллера»: новый рантайм, хранилище то же
  const env2 = makeEnv({ storages });
  const Z2 = env2.require('wbclim-zone');
  Z2.create(relaysZone());
  check('интегратор восстановлен после перезапуска', Math.abs(Z2.get('room').integral - i1) < 1.5, i1 + ' -> ' + Z2.get('room').integral);
}

R.done('zone.js');
