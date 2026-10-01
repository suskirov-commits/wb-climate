/**
 * @file wbclim-convector.js
 * @description Исполнитель «Конвектор»: термоголовка + вентилятор.
 *
 * Получает от зоны потребность в тепле 0..100 % и раскладывает её
 * на свои выходы:
 *
 *   потребность   0 %  ─ уставка достигнута ─────────── клапан закрыт
 *               > 0 %  ─ тепло нужно ───────────────── клапан открыт,
 *                                                      греет естественной
 *                                                      конвекцией
 *          ≥ fanStart  ─ естественной конвекции мало ─ вентилятор на
 *                                                      первой скорости
 *              100 %   ─ сильное отставание ─────────── максимальная скорость
 *
 * Чем больше разница между уставкой и температурой, тем выше потребность
 * и тем быстрее вентилятор. На подходе к уставке скорость падает до нуля,
 * при достижении уставки закрывается термоголовка.
 *
 * Простой (пассивный) конвектор — тот же исполнитель без вентилятора:
 * управляется только термоголовкой, как тёплый пол.
 *
 * Защита от холодного дутья. Вентилятор не включается, пока
 * теплообменник не прогрелся: по датчику воды (если задан) — от
 * minWater, иначе — через delay после открытия термоголовки
 * (термоголовке нужно 2–4 минуты, чтобы открыться, и ещё время, чтобы
 * дошла горячая вода). Иначе первым делом в комнату дует холодный воздух.
 *
 * Ступени вентилятора. Пороги равномерно делят диапазон потребности
 * fanStart..100 %. Переключение вверх — сразу по достижении порога,
 * вниз — с гистерезисом hyst. Между переключениями ступеней выдерживается
 * minStepTime: датчик температуры шумит, и без этого реле скоростей
 * щёлкали бы на каждом такте. Пуск с нуля и остановка — без задержки.
 */

var U = require('wbclim-util');
var VALVE = require('wbclim-valve');
var FAN = require('wbclim-fan');

/**
 * @param {Object} cfg описание конвектора (см. README):
 *   id, title, valve{...}, fan{type, ..., start, min, max, hyst,
 *   minStepTime, delay, minWater}, waterSensor
 * @param {Object} ctx { log, id }
 */
function Convector(cfg, ctx) {
  cfg = cfg || {};
  ctx = ctx || {};
  this.id = cfg.id;
  this.title = cfg.title || cfg.id;
  this.log = ctx.log || log;
  var tag = (ctx.id ? ctx.id + '/' : '') + this.id;

  var v = cfg.valve || {};
  this.valve = new VALVE.ThermalValve(v, { log: this.log, id: tag });

  var f = cfg.fan || {};
  this.fan = FAN.create(f, { log: this.log, id: tag });
  this.fanStart = U.clamp(U.def(f.start, 20), 0, 95);
  this.fanMin = U.clamp(U.def(f.min, 20), 0, 100);
  this.fanMax = U.clamp(U.def(f.max, 100), this.fanMin, 100);
  // 10 %, а не 5: на стенде (test/sim.js) переключений ступеней в час
  // меньше на четверть при том же размахе температуры
  this.fanHyst = U.def(f.hyst, 10);
  this.fanStepMs = U.def(f.minStepTime, 60) * 1000;
  // По умолчанию вентилятор ждёт полного открытия термоголовки
  this.fanDelayMs = U.def(f.delay, U.def(v.openTime, 180)) * 1000;
  this.waterMin = U.def(f.minWater, 30);
  this.waterHyst = 3;

  this.water = cfg.waterSensor
    ? new U.Sensor(cfg.waterSensor, { tau: 10, min: -20, max: 110, required: false, maxRate: 2 })
    : null;
  this.warm = false; // гистерезис по датчику воды

  this.level = 0; // ступень или % вентилятора
  this.levelTs = null;
  this.blocked = ''; // почему вентилятор не работает при потребности
}

Convector.prototype.hasFan = function () {
  return this.fan !== null;
};

/** Теплообменник прогрет — можно дуть. */
Convector.prototype._isWarm = function (now) {
  if (this.water && this.water.ok()) {
    var t = this.water.value;
    if (t >= this.waterMin) this.warm = true;
    else if (t < this.waterMin - this.waterHyst) this.warm = false;
    return this.warm;
  }
  // Датчика воды нет или он неисправен — по времени открытия клапана
  return this.valve.openFor(now) >= this.fanDelayMs;
};

/** Скорость по потребности: ступень 0..N или процент. */
Convector.prototype._fanTarget = function (demand) {
  var start = this.fanStart;
  var n = this.fan.steps;
  if (n > 0) {
    var lvl = this.level;
    var thr = function (k) {
      return start + ((k - 1) * (100 - start)) / n;
    };
    while (lvl < n && demand >= thr(lvl + 1)) lvl++;
    while (lvl > 0 && demand < thr(lvl) - this.fanHyst) lvl--;
    return lvl;
  }
  var running = this.level > 0;
  if (demand < (running ? start - this.fanHyst : start)) return 0;
  var x = U.clamp((demand - start) / (100 - start), 0, 1);
  return Math.round(this.fanMin + (this.fanMax - this.fanMin) * x);
};

/**
 * Такт.
 * @param {number} demand потребность зоны, %
 * @param {number} now    мс
 * @param {number} dt     с с прошлого такта
 * @param {bool}   force  переключить клапан без учёта минимальных времён
 */
Convector.prototype.update = function (demand, now, dt, force) {
  if (this.water) this.water.poll(dt);
  var open = this.valve.update(demand, now, force);
  if (!this.fan) return;

  var target = 0;
  this.blocked = '';
  if (open) {
    var want = this._fanTarget(demand);
    if (want > 0 && !this._isWarm(now)) {
      this.blocked = this.water && this.water.ok() ? 'water' : 'delay';
    } else target = want;
  }

  // Выдержка между ступенями. Пуск и остановка — сразу.
  if (
    this.fan.steps > 0 &&
    target !== this.level &&
    target > 0 &&
    this.level > 0 &&
    this.levelTs !== null &&
    now - this.levelTs < this.fanStepMs
  ) {
    target = this.level;
  }
  if (target !== this.level) {
    this.level = target;
    this.levelTs = now;
  }
  this.fan.write(this.level, now);
};

/** Текст состояния для карточки устройства. */
Convector.prototype.statusText = function (now) {
  if (!this.valve.open) return 'клапан закрыт';
  var s = 'клапан открыт';
  if (!this.fan) return s;
  if (this.blocked === 'delay') {
    var left = Math.max(0, Math.ceil((this.fanDelayMs - this.valve.openFor(now)) / 60000));
    return s + ', прогрев теплообменника (~' + left + ' мин)';
  }
  if (this.blocked === 'water') {
    return s + ', ждёт горячую воду (' + U.round(this.water.value, 1) + ' < ' + this.waterMin + ' °C)';
  }
  // уровень драйвера: плавный вентилятор может держать записанное значение
  var lvl = this.fan.level;
  if (lvl <= 0) return s + ', вентилятор стоит';
  return s + ', вентилятор ' + (this.fan.steps > 0 ? 'скорость ' + lvl : Math.round(lvl) + ' %');
};

/** Значения контролов на карточке помещения. */
Convector.prototype.publish = function (set, now) {
  set('valve', this.valve.open);
  if (this.fan) set('fan', U.round(this.fan.level, 0));
  if (this.water) set('water', U.round(this.water.get(0), 1));
  set('status', this.statusText(now));
};

Convector.prototype.getFault = function () {
  return this.valve.getFault() || (this.fan ? this.fan.getFault() : null);
};

/** Предупреждения, не останавливающие работу. */
Convector.prototype.getWarning = function () {
  if (this.water && this.water.fault) {
    return 'датчик воды ' + this.water.topic + ' (' + this.water.reason + '), вентилятор по таймеру';
  }
  return null;
};

/** Перезагрузка сценария: выходы остаются как есть, таймеры отменяются. */
Convector.prototype.detach = function () {
  if (this.fan) this.fan.detach();
};

Convector.prototype.halt = function () {
  if (this.fan) this.fan.halt();
  this.level = 0;
  this.valve.halt();
};

/* ================================================================== */

/** Контролы на карточке помещения: [{ name, spec, units }]. */
function controlsOf(cfg, title) {
  var list = [
    {
      name: 'valve',
      spec: { title: { en: title + ': valve', ru: title + ': клапан' }, type: 'switch', value: false, readonly: true }
    }
  ];
  var f = cfg.fan;
  if (FAN.present(f)) {
    var stepped =
      f.type === 'relays' || (f.type === 'modbus' && (U.def(f.steps, 3) > 0 || (Array.isArray(f.values) && f.values.length > 0)));
    list.push({
      name: 'fan',
      spec: { title: { en: title + ': fan', ru: title + ': вентилятор' }, type: 'value', value: 0 },
      units: stepped ? null : '%'
    });
  }
  if (cfg.waterSensor) {
    list.push({
      name: 'water',
      spec: { title: { en: title + ': water', ru: title + ': вода' }, type: 'value', value: 0 },
      units: 'deg C'
    });
  }
  list.push({
    name: 'status',
    spec: { title: { en: title + ': status', ru: title + ': состояние' }, type: 'text', value: '' }
  });
  return list;
}

/** Незаполненные обязательные поля. */
function missingOf(cfg) {
  var miss = [];
  if (!U.topicList(cfg.valve && cfg.valve.topics).length) miss.push('термоголовка');
  return miss.concat(FAN.missingOf(cfg.fan));
}

/** Выходы конвектора по конфигурации. */
function outputsOf(cfg) {
  var out = [];
  var v = U.topicList(cfg.valve && cfg.valve.topics);
  for (var i = 0; i < v.length; i++) out.push({ topic: v[i], name: 'термоголовка' });
  var f = FAN.outputsOf(cfg.fan);
  for (var j = 0; j < f.length; j++) out.push({ topic: f[j], name: 'вентилятор' });
  return out;
}

exports.Convector = Convector;
exports.controlsOf = controlsOf;
exports.missingOf = missingOf;
exports.outputsOf = outputsOf;
