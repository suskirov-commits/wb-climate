/**
 * @file wbclim-fan.js
 * @description Вентилятор активного конвектора, фанкойла, вентустановки.
 *
 * Драйвер только выдаёт скорость на выходы. Какую скорость нужно —
 * решает исполнитель (конвектор) по потребности зоны.
 *
 * Один интерфейс — две реализации:
 *
 *   RelayFan  — 1–3 реле, по одному на скорость (отводы обмотки
 *               трёхскоростного двигателя). steps = числу реле.
 *               Режим exclusive (основной): включено не больше одного
 *               реле. При смене скорости старое реле выключается, новое
 *               включается после паузы interlock — два отвода обмотки,
 *               замкнутые одновременно хотя бы на миг, это межвитковое
 *               замыкание. Режим cumulative: для скорости N включены
 *               реле 1..N (встречается у ЕС-вентиляторов со ступенчатыми
 *               входами).
 *
 *   ValueFan  — числовой выход:
 *               analog — 0-10 В через WB-MAO4 (мВ 0..10000), плавно;
 *               modbus — регистр скорости конвектора со своим
 *                        контроллером (через шаблон wb-mqtt-serial):
 *                        ступени 0..N, ступени с заданными значениями
 *                        (values) или плавно в заданной шкале.
 *
 *               Плата конвектора может сохранять каждое записанное
 *               значение в энергонезависимую память (Varmann Vartronic
 *               так и делает). Плавная скорость, которая меняется
 *               каждый такт, — это тысячи записей в сутки, ресурс памяти
 *               кончится за недели. Поэтому плавное значение пишется,
 *               только если изменилось не меньше чем на minChange %;
 *               пуск, остановка и выход на 100 % — всегда.
 *
 * Общий интерфейс:
 *   .steps              число ступеней; 0 — плавное управление (0..100 %)
 *   .write(level, now)  выдать ступень (0..steps) или процент (steps = 0)
 *   .halt()             остановить
 *   .detach()           отпустить выходы как есть (перезагрузка сценария)
 *   .getFault()         связь с модулями выходов
 *   .outputs()          топики выходов (для проверки конфигурации)
 */

var U = require('wbclim-util');

function writeBool(topic, v, ctx) {
  if (!topic || dev[topic] === v) return;
  try {
    dev[topic] = v;
  } catch (e) {
    ctx.log.error('[{}] не удалось записать {}: {}', ctx.id, topic, e);
  }
}

/* ================================================================== */
/*  Реле скоростей                                                     */
/* ================================================================== */

/**
 * @param {Object} cfg
 *   speeds    {Array}  реле скоростей от медленной к быстрой
 *   relayMode {string} "exclusive" | "cumulative"
 *   interlock {number} пауза между выключением одной скорости
 *                      и включением другой, мс
 *   enable    {string} опционально: реле питания вентилятора
 */
function RelayFan(cfg, ctx) {
  this.ctx = ctx;
  this.topics = U.topicList(cfg.speeds);
  this.steps = this.topics.length;
  this.cumulative = cfg.relayMode === 'cumulative';
  this.interlockMs = U.def(cfg.interlock, 500);
  this.enable = cfg.enable || null;
  this.level = 0;
  this.pending = null; // ступень, ждущая окончания паузы
  this.startTimer = null;
  this.lastOff = null; // когда последний раз выключали реле скорости
}

RelayFan.prototype._want = function (i, level) {
  return this.cumulative ? i < level : i === level - 1;
};

RelayFan.prototype._cancel = function () {
  if (this.startTimer !== null) {
    clearTimeout(this.startTimer);
    this.startTimer = null;
  }
  this.pending = null;
};

RelayFan.prototype.write = function (level, now) {
  level = U.clamp(Math.round(U.isNum(level) ? level : 0), 0, this.steps);
  now = U.def(now, Date.now());
  // Эта же ступень уже ждёт паузы — не перезапускаем таймер
  if (this.pending === level && this.startTimer !== null) return;
  this._cancel();

  // Сначала снимаем всё лишнее
  for (var i = 0; i < this.topics.length; i++) {
    if (!this._want(i, level) && dev[this.topics[i]] !== false) {
      writeBool(this.topics[i], false, this.ctx);
      this.lastOff = now;
    }
  }
  writeBool(this.enable, level > 0, this.ctx);
  this.level = level;

  var ons = [];
  for (var j = 0; j < this.topics.length; j++) {
    if (this._want(j, level) && dev[this.topics[j]] !== true) ons.push(this.topics[j]);
  }
  if (!ons.length) return;

  var self = this;
  var fire = function () {
    self.startTimer = null;
    self.pending = null;
    for (var k = 0; k < ons.length; k++) writeBool(ons[k], true, self.ctx);
  };
  // В режиме exclusive новая скорость включается не раньше чем через
  // interlock после выключения прежней. Таймер хранится: halt() в эту
  // паузу обязан его отменить (wbmix, грабля №15).
  var wait = this.cumulative || this.lastOff === null ? 0 : this.interlockMs - (now - this.lastOff);
  if (wait > 0) {
    this.pending = level;
    this.startTimer = setTimeout(fire, wait);
  } else fire();
};

RelayFan.prototype.halt = function () {
  this._cancel();
  for (var i = 0; i < this.topics.length; i++) writeBool(this.topics[i], false, this.ctx);
  writeBool(this.enable, false, this.ctx);
  this.level = 0;
  this.lastOff = Date.now();
};

/** Отпустить выходы как есть, отменив отложенное включение. */
RelayFan.prototype.detach = function () {
  this._cancel();
};

RelayFan.prototype.getFault = function () {
  var all = this.outputs();
  for (var i = 0; i < all.length; i++) {
    var e = U.linkError(all[i]);
    if (e) return 'вентилятор: ' + e;
  }
  return null;
};

RelayFan.prototype.outputs = function () {
  var o = this.topics.slice();
  if (this.enable) o.push(this.enable);
  return o;
};

/* ================================================================== */
/*  Числовой выход: 0-10 В, регистр Modbus                             */
/* ================================================================== */

/**
 * @param {Object} cfg
 *   out       {string} топик выхода
 *   steps     {number} ступеней (0 — плавно)
 *   values    {Array}  значения ступеней 1..N, напр. [30, 60, 100];
 *                      задано — число ступеней берётся отсюда
 *   minChange {number} плавно: не писать изменения меньше, %
 *   valueOff  {number} значение «стоп»
 *   valueMin  {number} значение при 0 % (для плавного), напр. 2000 для 2-10 В
 *   valueMax  {number} значение при 100 %
 *   enable    {string} опционально: реле питания вентилятора
 */
function ValueFan(cfg, ctx, defaults) {
  this.ctx = ctx;
  this.out = cfg.out || null;
  this.steps = Math.max(0, Math.round(U.def(cfg.steps, defaults.steps)));
  this.values = null;
  if (Array.isArray(cfg.values) && cfg.values.length) {
    this.values = [];
    for (var i = 0; i < cfg.values.length; i++) this.values.push(U.toNum(cfg.values[i]));
    this.steps = this.values.length;
  }
  this.minChange = U.def(cfg.minChange, defaults.minChange);
  this.sent = null; // плавно: уровень, записанный последним
  this.valueOff = U.def(cfg.valueOff, 0);
  this.valueMin = U.def(cfg.valueMin, defaults.valueMin);
  this.valueMax = U.def(cfg.valueMax, defaults.valueMax);
  this.enable = cfg.enable || null;
  this.level = 0;
  // null, а не 0: иначе первая команда «0» не запишется, и после
  // рестарта на выходе останется старое значение (wbmix, грабля №4)
  this.cmd = null;
  this.lastWrite = null;
}

ValueFan.prototype._raw = function (level) {
  if (level <= 0) return this.valueOff;
  if (this.steps > 0) return this.values ? this.values[level - 1] : level;
  var v = this.valueMin + ((this.valueMax - this.valueMin) * level) / 100;
  return Math.abs(this.valueMax - this.valueMin) >= 100 ? Math.round(v) : U.round(v, 2);
};

ValueFan.prototype.write = function (level, now) {
  now = U.def(now, Date.now());
  level = U.isNum(level) ? level : 0;
  level = this.steps > 0 ? U.clamp(Math.round(level), 0, this.steps) : U.clamp(level, 0, 100);
  // Плавно: мелкие изменения не пишем, держим записанное
  if (this.steps === 0 && this.sent !== null && this.sent > 0 && level > 0 && level < 100) {
    if (Math.abs(level - this.sent) < this.minChange) level = this.sent;
  }
  var raw = this._raw(level);
  // Значение пишем при изменении, а также раз в минуту, если модуль
  // показывает не то, что мы записали (перезапустился после пропадания
  // питания и вернул выход в безопасное состояние).
  var actual = U.toNum(dev[this.out]);
  // Ступени сравниваются точно: номер ступени 1 и 2 отличаются на 1,
  // а 2 % шкалы 0..100 — это 2, и сброс ступени остался бы незамеченным
  var tol = this.steps > 0 ? 0.5 : Math.max(Math.abs(this.valueMax - this.valueMin) * 0.02, 0.01);
  var drift = U.isNum(actual) && Math.abs(actual - raw) > tol;
  if (raw !== this.cmd || (drift && (this.lastWrite === null || now - this.lastWrite >= 60000))) {
    try {
      dev[this.out] = raw;
      this.cmd = raw;
      this.lastWrite = now;
      this.sent = level;
    } catch (e) {
      this.ctx.log.error('[{}] не удалось записать {}: {}', this.ctx.id, this.out, e);
    }
  }
  writeBool(this.enable, level > 0, this.ctx);
  this.level = level;
};

ValueFan.prototype.halt = function () {
  this.write(0);
};

ValueFan.prototype.detach = function () {};

ValueFan.prototype.getFault = RelayFan.prototype.getFault;

ValueFan.prototype.outputs = function () {
  var o = this.out ? [this.out] : [];
  if (this.enable) o.push(this.enable);
  return o;
};

/* ================================================================== */

var VALUE_DEFAULTS = {
  // WB-MAO4: канал в милливольтах 0..10000
  analog: { steps: 0, valueMin: 0, valueMax: 10000, minChange: 1 },
  // Типовой регистр скорости: 0 — стоп, 1..3 — скорости.
  // minChange 5 % — по стенду test/sim.js (см. PROMPT.md, раздел 8)
  modbus: { steps: 3, valueMin: 0, valueMax: 100, minChange: 5 }
};

/** Есть ли вентилятор в описании. */
function present(cfg) {
  return !!(cfg && cfg.type && cfg.type !== 'none');
}

/**
 * Фабрика по cfg.type: "relays" | "analog" | "modbus".
 * @returns {Object|null} null, если вентилятора нет
 */
function create(cfg, ctx) {
  if (!present(cfg)) return null;
  ctx = ctx || {};
  ctx.log = ctx.log || log;
  ctx.id = ctx.id || 'fan';
  if (cfg.type === 'relays') return new RelayFan(cfg, ctx);
  if (VALUE_DEFAULTS[cfg.type]) return new ValueFan(cfg, ctx, VALUE_DEFAULTS[cfg.type]);
  throw new Error('wbclim: неизвестный тип вентилятора: ' + cfg.type);
}

/** Незаполненные обязательные поля вентилятора. */
function missingOf(cfg) {
  if (!present(cfg)) return [];
  if (cfg.type === 'relays') return U.topicList(cfg.speeds).length ? [] : ['реле скоростей вентилятора'];
  return cfg.out ? [] : ['выход вентилятора'];
}

/** Все выходы вентилятора по конфигурации — без создания драйвера. */
function outputsOf(cfg) {
  if (!present(cfg)) return [];
  var o = cfg.type === 'relays' ? U.topicList(cfg.speeds) : U.topicList(cfg.out);
  if (cfg.enable) o.push(cfg.enable);
  return o;
}

exports.create = create;
exports.present = present;
exports.missingOf = missingOf;
exports.outputsOf = outputsOf;
exports.RelayFan = RelayFan;
exports.ValueFan = ValueFan;
