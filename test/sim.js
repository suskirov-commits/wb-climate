/**
 * sim.js — прогон зоны с конвектором на модели помещения.
 *
 * Не автотест, а инструмент настройки: подставить параметры объекта
 * (теплопотери, мощность конвектора, температура подачи) и сравнить
 * варианты регулятора до выезда.
 *
 * Модель:
 *   - воздух помещения (C_a) и внутренний слой ограждений и мебели (C_m);
 *     теплопотери: инфильтрация с воздуха, ограждения — с массы;
 *   - термоголовка: восковой элемент греется/остывает с постоянной
 *     времени, клапан начинает открываться с 30 % хода элемента —
 *     получается реальное запаздывание 1–1,5 мин и полное открытие ~3–4 мин;
 *   - теплообменник конвектора с собственной теплоёмкостью воды и металла;
 *   - отдача: естественная конвекция + вентилятор (расход воздуха по ступени);
 *   - датчик в помещении: инерция корпуса 2 мин, шум, дискретность 0,01.
 *
 * Запуск: node test/sim.js                  — сравнение вариантов
 *         node test/sim.js --trace [--ti=0]  — трасса раз в 5 мин
 */
'use strict';
const { createEnv } = require('./harness');

/* ---------------- параметры помещения и конвектора ---------------- */
const ROOM = {
  Ca: 300e3, // Дж/К — воздух и лёгкая мебель
  Cm: 8e6, // Дж/К — внутренний слой стен/пола
  Ham: 250, // Вт/К — воздух <-> масса
  UAinf: 6, // Вт/К — инфильтрация, с воздуха
  UAenv: 16, // Вт/К — ограждения, с массы
  Tsup: 55, // °C — подача в конвекторы
  // Внутрипольный конвектор с вентилятором при подаче 55 °C:
  // естественная конвекция ~190 Вт, с вентилятором до ~1200 Вт.
  // Теплопотери помещения при −20 °C на улице ~880 Вт, при +8 ~300 Вт —
  // в мягкую погоду естественной конвекции не хватает, вентилятор нужен.
  UAnat: 6, // Вт/К
  UAfan: 45, // Вт/К на полной скорости
  Cw: 8e3, // Дж/К — вода и металл теплообменника
  mc: 200, // Вт/К — расход при открытом клапане
  airflow: [0, 0.45, 0.72, 1.0] // доля расхода воздуха по ступеням
};

/* ---------------- модель ---------------- */
function makePlant(T0, Tout, opts) {
  const p = Object.assign({}, ROOM, opts || {});
  // Старт из установившегося состояния: помещение давно держит T0
  const Tm0 = (p.Ham * T0 + p.UAenv * Tout) / (p.Ham + p.UAenv);
  return {
    p,
    Ta: T0,
    Tm: Tm0,
    Tw: T0,
    wax: 0, // 0..1 — восковой элемент термоголовки
    Ts: T0, // показание датчика (с инерцией)
    Tout: Tout,
    gain: 0, // внутренние теплопоступления, Вт
    windowUA: 0,
    Q: 0,
    step(dt, valveOn, fanFrac) {
      // термоголовка: открывается ~3 мин, закрывается ~4–5 мин
      const tau = valveOn ? 90 : 150;
      this.wax += ((valveOn ? 1 : 0) - this.wax) * (dt / tau);
      const v = Math.min(1, Math.max(0, (this.wax - 0.3) / 0.6));
      const UA = p.UAnat + (p.UAfan - p.UAnat) * fanFrac;
      const Q = UA * Math.max(0, this.Tw - this.Ta);
      this.Q = Q;
      this.Tw += ((p.mc * v * (p.Tsup - this.Tw) - Q) / p.Cw) * dt;
      const qAm = p.Ham * (this.Ta - this.Tm);
      this.Ta += ((Q + this.gain - qAm - (p.UAinf + this.windowUA) * (this.Ta - this.Tout)) / p.Ca) * dt;
      this.Tm += ((qAm - p.UAenv * (this.Tm - this.Tout)) / p.Cm) * dt;
      this.Ts += ((this.Ta - this.Ts) * dt) / 120;
    }
  };
}

/* Детерминированный шум — прогоны сравнимы между собой */
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/* ---------------- прогон ---------------- */
const TEMP = 'msw/Temperature',
  VALVE = 'mr6c/K1',
  S1 = 'mr6c/K2',
  S2 = 'mr6c/K3',
  S3 = 'mr6c/K4',
  AO = 'mao4/Channel 1',
  MB = 'conv_mb/fan_speed',
  WIN = 'win/Input 1';

function zoneConfig(v) {
  const fan =
    v.fan === 'none'
      ? { type: 'none' }
      : v.fan === 'analog'
      ? { type: 'analog', out: AO, start: v.fanStart, min: 20, hyst: v.fanHyst, delay: v.fanDelay }
      : v.fan === 'modbus'
      ? { type: 'modbus', out: MB, steps: 0, minChange: v.minChange, start: v.fanStart, min: 20, hyst: v.fanHyst, delay: v.fanDelay }
      : { type: 'relays', speeds: [S1, S2, S3], start: v.fanStart, hyst: v.fanHyst, minStepTime: v.fanStep, delay: v.fanDelay };
  return {
    id: 'zone',
    title: 'Комната',
    defaultSetpoint: 22,
    sensors: { temperature: [TEMP], tau: v.tau },
    window: v.window ? { topics: [WIN], delay: 30 } : {},
    control: { period: 10, band: v.band, ti: v.ti },
    devices: [
      {
        type: 'convector',
        id: 'conv',
        valve: { topics: [VALVE], mode: v.valveMode, minOn: v.minOn, minOff: v.minOff, cycle: v.cycle, openTime: 180 },
        fan
      }
    ]
  };
}

/**
 * Сценарий. Первые 6 часов — разгон без учёта: помещение держит 22 °C,
 * регулятор набирает интегральную часть (на объекте она хранится между
 * перезапусками). Дальше, минуты от начала учёта:
 *   0     установившийся режим, уставка 22, на улице tout
 *   180   внутренние теплопоступления +400 Вт на час (солнце, люди)
 *   300   окно открыто 10 минут
 *   420   ночное снижение уставки до 20
 *   660   утро — уставка 22
 *   900   конец
 */
const PRE = 360;
const SC = { gain: 180, window: 300, night: 420, morning: 660, end: 900 };

function run(v, trace) {
  const env = createEnv();
  const rnd = rng(12345);
  const plant = makePlant(22, v.tout, v.plant);
  env.control(TEMP, 22);
  for (const t of [VALVE, S1, S2, S3]) env.control(t, false);
  env.control(AO, 0);
  env.control(MB, 0);
  env.control(WIN, false);
  const ZONE = env.require('wbclim-zone');
  ZONE.create(zoneConfig(v));
  const z = ZONE.get('zone');

  const m = {
    steadyErr: [],
    switches: 0,
    fanChanges: 0,
    fanTime: [0, 0, 0, 0],
    gainMax: 0,
    windowMin: Infinity,
    windowBack: null,
    nightDip: Infinity,
    morning: null,
    overshoot: 0
  };
  let lastValve = false,
    lastFan = 0,
    mark = 0;
  for (let s = -PRE * 60; s < SC.end * 60; s++) {
    const min = s / 60;
    const counted = s >= 0;
    if (s === 0) mark = env.writes.length;
    plant.gain = min >= SC.gain && min < SC.gain + 60 ? 400 : 0;
    const winOpen = min >= SC.window && min < SC.window + 10;
    plant.windowUA = winOpen ? 50 : 0;
    if (v.window && env.get(WIN) !== winOpen) env.set(WIN, winOpen);
    if (s === SC.night * 60) env.set('zone/setpoint', 20);
    if (s === SC.morning * 60) env.set('zone/setpoint', 22);

    const valveOn = env.get(VALVE) === true;
    let fanFrac = 0;
    let lvl = 0;
    if (v.fan === 'analog') fanFrac = (env.get(AO) || 0) / 10000;
    else if (v.fan === 'modbus') fanFrac = (env.get(MB) || 0) / 100;
    else if (v.fan !== 'none') {
      lvl = env.get(S3) ? 3 : env.get(S2) ? 2 : env.get(S1) ? 1 : 0;
      fanFrac = ROOM.airflow[lvl];
    }
    if (counted) {
      if (v.fan === 'relays') {
        m.fanTime[lvl]++;
        if (lvl !== lastFan) m.fanChanges++;
      }
      if (valveOn !== lastValve) m.switches++;
    }
    lastFan = lvl;
    lastValve = valveOn;

    plant.step(1, valveOn, fanFrac);
    if (s % 5 === 0) env.set(TEMP, Math.round((plant.Ts + (rnd() - 0.5) * 0.06) * 100) / 100);
    env.advance(1000);

    const Ta = plant.Ta;
    if (counted) {
      if (min < SC.gain) m.steadyErr.push(Ta - 22);
      if (min >= SC.gain && min < SC.window) m.gainMax = Math.max(m.gainMax, Ta - 22);
      if (min >= SC.window && min < SC.night) {
        m.windowMin = Math.min(m.windowMin, Ta - 22);
        if (min > SC.window + 10 && m.windowBack === null && Ta >= 21.7) m.windowBack = min - SC.window - 10;
      }
      if (min >= SC.night + 120 && min < SC.morning) m.nightDip = Math.min(m.nightDip, Ta - 20);
      if (min >= SC.morning && m.morning === null && Ta >= 21.7) m.morning = min - SC.morning;
      if (m.morning !== null) m.overshoot = Math.max(m.overshoot, Ta - 22);
    }

    if (trace && s % 300 === 0 && (counted || trace === 'all')) {
      console.log(
        [
          String(Math.round(min)).padStart(4),
          'Ta ' + Ta.toFixed(2),
          'Ts ' + plant.Ts.toFixed(2),
          'Tw ' + plant.Tw.toFixed(1),
          'Q ' + String(Math.round(plant.Q)).padStart(4),
          'dem ' + String(Math.round(z.demand)).padStart(3),
          'I ' + z.integral.toFixed(1),
          'valve ' + (valveOn ? 1 : 0),
          'fan ' + (v.fan === 'analog' ? Math.round(fanFrac * 100) + '%' : lvl),
          z.state
        ].join('  ')
      );
    }
  }
  const se = m.steadyErr;
  m.mean = se.reduce((a, b) => a + b, 0) / se.length;
  m.dev = Math.max(...se.map((x) => Math.abs(x - m.mean)));
  m.switchesPerH = (m.switches * 60) / SC.end;
  m.fanPerH = (m.fanChanges * 60) / SC.end;
  // записи в регистр плавного вентилятора (ресурс памяти платы)
  if (v.fan === 'modbus' || v.fan === 'analog') m.fanPerH = (env.countWrites(v.fan === 'modbus' ? MB : AO, mark) * 60) / SC.end;
  return m;
}

/* ---------------- варианты ---------------- */
const BASE = {
  tout: -20,
  band: 1.5,
  ti: 30,
  tau: 30,
  fan: 'relays',
  fanStart: 20,
  fanHyst: 10,
  fanStep: 60,
  fanDelay: 180,
  valveMode: 'onoff',
  minOn: 120,
  minOff: 120,
  cycle: 900,
  window: true
};

function parseArgs() {
  const extra = {};
  for (const a of process.argv.slice(2)) {
    const mm = a.match(/^--(\w+)=(.*)$/);
    if (mm) extra[mm[1]] = isNaN(+mm[2]) ? mm[2] : +mm[2];
  }
  if (extra.passive) {
    extra.fan = 'none';
    extra.plant = { UAnat: 40 };
  }
  return extra;
}

if (require.main !== module) {
  module.exports = { run, BASE };
} else if (process.argv.includes('--trace')) {
  run(Object.assign({}, BASE, parseArgs()), process.argv.includes('--all') ? 'all' : true);
} else table();

function table() {

const PASSIVE = { fan: 'none', plant: { UAnat: 40 } };
const VARIANTS = [
  ['по умолчанию (band 1,5, ti 30)', {}],
  ['чистый П (ti 0)', { ti: 0 }],
  ['ti 60', { ti: 60 }],
  ['band 2, ti 60, hyst 5', { band: 2, ti: 60, fanHyst: 5 }],
  ['band 1', { band: 1 }],
  ['band 3', { band: 3 }],
  ['fanStart 30', { fanStart: 30 }],
  ['без выдержки ступеней', { fanStep: 0 }],
  ['вентилятор 0-10 В', { fan: 'analog' }],
  ['Modbus плавно, minChange 1', { fan: 'modbus', minChange: 1 }],
  ['Modbus плавно, minChange 5', { fan: 'modbus', minChange: 5 }],
  ['Modbus плавно, minChange 10', { fan: 'modbus', minChange: 10 }],
  ['  … +8 °C, minChange 5', { fan: 'modbus', minChange: 5, tout: 8 }],
  ['без датчика окна', { window: false }],
  ['мягкая погода +8 °C', { tout: 8 }],
  ['  … чистый П', { tout: 8, ti: 0 }],
  ['  … band 3', { tout: 8, band: 3 }],
  ['лёгкое помещение', { plant: { Cm: 3e6, Ca: 200e3 } }],
  ['конвектор вдвое мощнее', { plant: { UAfan: 90, UAnat: 12 } }],
  ['конвектор слабый', { plant: { UAfan: 36 } }],
  ['пассивный, onoff', PASSIVE],
  ['  … ШИМ', Object.assign({ valveMode: 'pwm' }, PASSIVE)],
  ['  … onoff, чистый П', Object.assign({ ti: 0 }, PASSIVE)],
  ['  … onoff, +8 °C', Object.assign({ tout: 8 }, PASSIVE)],
  ['  … ШИМ, +8 °C', Object.assign({ tout: 8, valveMode: 'pwm' }, PASSIVE)]
];

const f = (x, d) => (x === null || !isFinite(x) ? '    — ' : x.toFixed(d === undefined ? 2 : d).padStart(6));
console.log('\nвариант                         ст.ср ст.разм +400Вт  окно  возвр   ночь   утро заброс клап/ч вент/ч  ск 0/1/2/3 %');
for (const [name, opt] of VARIANTS) {
  const v = Object.assign({}, BASE, opt);
  const m = run(v);
  const tot = m.fanTime.reduce((a, b) => a + b, 0);
  console.log(
    name.padEnd(30) +
      [
        f(m.mean),
        f(m.dev),
        f(m.gainMax),
        f(m.windowMin),
        f(m.windowBack, 0),
        f(m.nightDip),
        f(m.morning, 0),
        f(m.overshoot),
        f(m.switchesPerH, 1),
        f(m.fanPerH, 1)
      ].join(' ') +
      '  ' +
      (tot ? m.fanTime.map((x) => Math.round((100 * x) / tot)).join('/') : '')
  );
}
console.log(
  [
    '',
    'ст.ср / ст.разм — средняя ошибка и размах в установившемся режиме, К;',
    '+400Вт — макс превышение уставки при теплопоступлениях, К;',
    'окно — провал за 10 минут открытого окна, К; возвр — мин до 21,7 °C после закрытия;',
    'ночь — мин. ошибка при уставке 20, К; утро — мин до 21,7 °C после возврата уставки 22;',
    'заброс — макс превышение 22 °C после утреннего выхода, К;',
    'клап/ч, вент/ч — переключений термоголовки и ступеней вентилятора в час;',
    '  для плавных (0-10 В, Modbus) вент/ч — записей в выход в час.'
  ].join('\n')
);
}
