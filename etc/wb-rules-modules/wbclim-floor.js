/**
 * @file wbclim-floor.js
 * @description Исполнитель «Тёплый пол»: термоголовки петель на коллекторе,
 *              регулирование по датчикам пола.
 *
 * КАСКАД. Помещение (внешний контур) считает потребность в тепле по
 * воздуху. Пол (внутренний контур) превращает её в ЦЕЛЕВУЮ ТЕМПЕРАТУРУ
 * ПОЛА и держит её по своим датчикам:
 *
 *   цель = низ + (maxFloor − низ) · потребность / 100
 *   низ  = minFloor, если задан, иначе уставка помещения
 *
 *   - помещению тепло (потребность 0) — петли закрыты, пол остывает, но
 *     не ниже minFloor («пол не ниже»): ниже — петли открываются;
 *   - minFloor держится ВСЕГДА: и при выключенном помещении, и при
 *     открытом окне (решение пользователя 2026-10-02). Сильнее него только
 *     перегрев. Выключить пол совсем (лето) — «пол не ниже» = 0;
 *   - minFloor правится на карточке помещения (контрол <id>_min_floor),
 *     значение из настроек — начальное;
 *   - помещению холодно — цель растёт до maxFloor; выше пол не поднимается
 *     никогда (по умолчанию 29 °C — EN 1264 для жилых помещений;
 *     СП 60.13330 для постоянного пребывания — не выше 26 °C);
 *   - minFloor = maxFloor — пол просто держит заданную температуру,
 *     уставка помещения на него не влияет;
 *   - minFloor не задан — низ равен уставке помещения: пол, равный по
 *     температуре воздуху, тепла не отдаёт.
 *
 * Почему каскад, а не ШИМ по потребности помещения: стяжка копит тепло
 * часами, и регулятор по воздуху видит результат своих действий с большим
 * опозданием. Датчик в стяжке видит его в разы раньше — внутренний контур
 * гасит инерцию пола, а внешнему остаётся медленно подбирать нужную
 * температуру пола. И ограничения пола (мин/макс) получаются естественно.
 *
 * Внутренний контур — двухпозиционный по температуре пола с гистерезисом
 * floorHyst (по умолчанию 0,5 К: открыть ниже цели на 0,25 К, закрыть выше
 * на 0,25 К) с минимальными временами термоголовки. На стенде 0,5 К держит
 * помещение вдвое точнее, чем 1 К, при том же числе переключений.
 *
 * Нет датчиков пола или все отказали — ШИМ по потребности помещения
 * (цикл 20 мин), отказ — предупреждение на карточке.
 */

var U = require('wbclim-util');
var VALVE = require('wbclim-valve');

/**
 * Термоголовки пола работают в режиме ШИМ: по датчику пола им подаётся
 * 0 или 100 % (закрыть / открыть), без датчика — потребность помещения.
 * Цикл и минимальные времена — по стенду test/sim.js (PROMPT.md, раздел 8).
 */
var VALVE_DEFAULTS = { mode: 'pwm', cycle: 1200, minOn: 180, minOff: 180, openTime: 180 };

/**
 * @param {Object} cfg описание (см. README):
 *   id, title, valve{topics, normallyOpen, cycle, minOn, minOff, openTime},
 *   floorSensors, minFloor, maxFloor, floorHyst
 * @param {Object} ctx { log, id }
 */
function Floor(cfg, ctx) {
  cfg = cfg || {};
  ctx = ctx || {};
  this.id = cfg.id;
  this.title = cfg.title || cfg.id;
  this.log = ctx.log || log;
  var tag = (ctx.id ? ctx.id + '/' : '') + this.id;

  var v = {};
  var k;
  for (k in VALVE_DEFAULTS) if (Object.prototype.hasOwnProperty.call(VALVE_DEFAULTS, k)) v[k] = VALVE_DEFAULTS[k];
  var src = cfg.valve || {};
  for (k in src) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== null && src[k] !== undefined) v[k] = src[k];
  v.mode = 'pwm'; // см. VALVE_DEFAULTS: и каскад, и запасной режим идут через ШИМ
  this.valve = new VALVE.ThermalValve(v, { log: this.log, id: tag });

  // Стяжка меняется медленно: 0,1 К/с отсекает мусор с шины с запасом
  this.floors = new U.SensorSet(cfg.floorSensors, { tau: 60, min: -20, max: 70, maxRate: 0.1 });
  this.maxFloor = U.def(cfg.maxFloor, 29);
  this.minFloorCfg = U.def(cfg.minFloor, 0); // 0 — низ по уставке помещения
  this.minFloor = this.minFloorCfg; // действующее: с карточки
  this.paused = false; // помещение выключено или открыто окно
  this.hyst = U.def(cfg.floorHyst, 0.5);

  this.heating = false; // решение внутреннего контура
  this.target = null; // целевая температура пола
  this.temp = null; // средняя по датчикам пола
  this.mode = 'pwm'; // cascade | pwm (запасной)
  this.limit = false;

  this.fan = null;
  this.level = 0;
}

Floor.prototype.hasFan = function () {
  return false;
};

/** «Пол не ниже» с карточки помещения; нет контрола — из настроек. */
Floor.prototype._min = function (zone) {
  var v = zone && zone.get ? U.toNum(zone.get('min_floor')) : NaN;
  return U.clamp(U.isNum(v) ? v : this.minFloorCfg, 0, this.maxFloor);
};

/** Целевая температура пола по доле потребности. */
Floor.prototype._target = function (demand, zone) {
  var hi = this.maxFloor;
  var lo = this.minFloor > 0 ? this.minFloor : zone && U.isNum(zone.setpoint) ? zone.setpoint : 20;
  lo = Math.min(lo, hi);
  return lo + ((hi - lo) * U.clamp(demand, 0, 100)) / 100;
};

/**
 * Такт.
 * @param {number} demand доля потребности зоны для пола, %
 * @param {number} now    мс
 * @param {number} dt     с с прошлого такта
 * @param {bool}   force  зона выключена или открыто окно: регулирование
 *                        по воздуху стоит, пол держит только minFloor
 * @param {Object} zone   { setpoint, get(name) } — уставка помещения и
 *                        чтение своих контролов на карточке
 */
Floor.prototype.update = function (demand, now, dt, force, zone) {
  var d = U.isNum(demand) ? demand : 0;
  this.floors.poll(dt);
  this.temp = this.floors.get(null);
  this.minFloor = this._min(zone);
  this.paused = !!force;

  if (this.temp === null) {
    // Датчиков пола нет или все отказали — ШИМ по потребности помещения.
    // Держать минимум не по чему: на паузе петли закрыты.
    this.mode = 'pwm';
    this.target = null;
    this.heating = false;
    this.limit = false;
    this.valve.update(force ? 0 : d, now, !!force);
    return;
  }

  this.mode = 'cascade';
  if (force) {
    if (this.minFloor <= 0) {
      this.target = null;
      this.heating = false;
      this.limit = false;
      this.valve.update(0, now, true);
      return;
    }
    this.target = this.minFloor;
  } else {
    this.target = this._target(d, zone);
  }
  var t = this.temp;
  var half = this.hyst / 2;
  if (!this.heating && t < this.target - half) this.heating = true;
  else if (this.heating && t > this.target + half) this.heating = false;

  // Жёсткий предел — закрыть сразу, без выдержки минимального времени.
  // На паузе (выключено, окно) пол выше минимума тоже закрывается сразу.
  this.limit = t >= this.maxFloor;
  if (this.limit) this.heating = false;
  this.valve.update(this.heating ? 100 : 0, now, this.limit || (force && !this.heating));
};

Floor.prototype.statusText = function () {
  var s = this.valve.open ? 'петли открыты' : 'петли закрыты';
  if (this.paused && this.target === null) {
    var noData = this.mode === 'pwm' && this.floors.configured;
    return s + ', помещение на паузе' + (noData ? '; нет данных датчиков пола — минимум не держится' : '');
  }
  if (this.mode === 'pwm' || this.target === null) {
    return this.floors.configured ? s + ', нет данных датчиков пола — ШИМ по помещению' : s + ', ШИМ по помещению';
  }
  if (this.paused) {
    s += ', помещение на паузе — пол ' + U.round(this.temp, 1) + ' °C, держу не ниже ' + U.round(this.target, 1) + ' °C';
  } else {
    s += ', пол ' + U.round(this.temp, 1) + ' °C, цель ' + U.round(this.target, 1) + ' °C';
  }
  if (this.limit) s += ' — ограничение ' + this.maxFloor + ' °C';
  return s;
};

/** Значения контролов на карточке помещения. */
Floor.prototype.publish = function (set, now) {
  set('valve', this.valve.open);
  if (this.floors.configured) {
    set('floor', this.temp === null ? 0 : U.round(this.temp, 1));
    set('target', this.target === null ? 0 : U.round(this.target, 1));
    // значение с карточки вне 0..maxFloor показываем исправленным
    set('min_floor', U.round(this.minFloor, 1));
  }
  set('status', this.statusText(now));
};

Floor.prototype.getFault = function () {
  return this.valve.getFault();
};

Floor.prototype.getWarning = function () {
  if (!this.floors.configured) return null;
  var f = this.floors.faults();
  if (!f) return null;
  return this.floors.ok()
    ? 'неисправен датчик пола ' + f + ', работаю по остальным'
    : 'нет данных датчиков пола: ' + f + ' — ШИМ по помещению, ограничение пола не работает';
};

Floor.prototype.detach = function () {};

Floor.prototype.halt = function () {
  this.valve.halt();
};

/* ================================================================== */

/** Контролы на карточке помещения: [{ name, spec, units }]. */
function controlsOf(cfg, title) {
  var list = [
    {
      name: 'valve',
      spec: { title: { en: title + ': loops', ru: title + ': петли' }, type: 'switch', value: false, readonly: true }
    }
  ];
  if (U.topicList(cfg.floorSensors).length) {
    list.push({
      name: 'floor',
      spec: { title: { en: title + ': floor', ru: title + ': пол' }, type: 'value', value: 0 },
      units: 'deg C'
    });
    list.push({
      name: 'target',
      spec: { title: { en: title + ': floor target', ru: title + ': цель для пола' }, type: 'value', value: 0 },
      units: 'deg C'
    });
    // «Пол не ниже» правит хозяин на карточке; из настроек — начальное
    list.push({
      name: 'min_floor',
      spec: {
        title: { en: title + ': floor min (0 = by setpoint)', ru: title + ': пол не ниже (0 — по уставке)' },
        type: 'value',
        readonly: false,
        value: U.def(cfg.minFloor, 0),
        min: 0,
        max: 35
      },
      units: 'deg C',
      writable: true
    });
  }
  list.push({
    name: 'status',
    spec: { title: { en: title + ': status', ru: title + ': состояние' }, type: 'text', value: '' }
  });
  return list;
}

function missingOf(cfg) {
  return U.topicList(cfg.valve && cfg.valve.topics).length ? [] : ['термоголовки петель'];
}

/** Заданные, но противоречивые параметры. */
function checkOf(cfg) {
  var lo = U.def(cfg.minFloor, 0);
  var hi = U.def(cfg.maxFloor, 29);
  return lo > hi ? ['минимум пола ' + lo + ' °C выше максимума ' + hi + ' °C'] : [];
}

function outputsOf(cfg) {
  var out = [];
  var v = U.topicList(cfg.valve && cfg.valve.topics);
  for (var i = 0; i < v.length; i++) out.push({ topic: v[i], name: 'термоголовка петли' });
  return out;
}

exports.Floor = Floor;
exports.controlsOf = controlsOf;
exports.missingOf = missingOf;
exports.checkOf = checkOf;
exports.outputsOf = outputsOf;
exports.VALVE_DEFAULTS = VALVE_DEFAULTS;
