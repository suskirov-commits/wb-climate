/**
 * @file wbclim-valve.js
 * @description Термоголовка (термоэлектрический сервопривод) на реле.
 *
 * Общий исполнитель для всего, что греет водой через клапан «открыт/закрыт»:
 * конвекторы, тёплый пол на коллекторе, радиаторы. Одна «термоголовка»
 * здесь — это группа реле, которые всегда переключаются вместе (например,
 * две петли пола в одном помещении).
 *
 * Свойства объекта, которые определяют логику:
 *
 *   1. Термоголовка медленная. От подачи напряжения до полного открытия
 *      2–4 минуты (нагрев воскового элемента), закрытие — столько же.
 *      Поэтому переключать её чаще, чем раз в пару минут, бессмысленно:
 *      клапан просто не успевает дойти. Минимальные времена «открыт» и
 *      «закрыт» — не прихоть, а физика привода.
 *
 *   2. Обратной связи по положению нет. «Клапан реально открыт» — это
 *      оценка по времени с момента команды (openTime). Ей пользуется
 *      вентилятор конвектора: дуть, пока теплообменник холодный, нельзя.
 *
 *   3. Бывают нормально закрытые (NC, обесточен — закрыт, основной случай)
 *      и нормально открытые (NO). Для NO реле включается, чтобы закрыть.
 *
 * Два режима:
 *
 *   onoff — двухпозиционный по потребности зоны: открыть при потребности
 *           не ниже onAt, закрыть при потребности не выше offAt (по
 *           умолчанию 0 — т. е. когда уставка достигнута).
 *   pwm   — широтно-импульсный: в каждом цикле (по умолчанию 15 мин)
 *           клапан открыт долю времени, равную потребности. Для тёплого
 *           пола и пассивных конвекторов даёт ровную температуру без
 *           раскачки.
 */

var U = require('wbclim-util');

/**
 * @param {Object} cfg
 *   topics        {Array}  реле термоголовок, например ["wb-mr6c_45/K1"]
 *   normallyOpen  {bool}   термоголовки NO (по умолчанию NC)
 *   mode          {string} "onoff" | "pwm"
 *   onAt, offAt   {number} пороги потребности для onoff, %
 *   minOn, minOff {number} минимальное время в открытом/закрытом, с
 *   cycle         {number} период ШИМ, с
 *   openTime      {number} время полного открытия термоголовки, с
 * @param {Object} ctx { log, id }
 */
function ThermalValve(cfg, ctx) {
  cfg = cfg || {};
  ctx = ctx || {};
  this.log = ctx.log || log;
  this.id = ctx.id || 'valve';

  this.topics = U.topicList(cfg.topics);
  this.normallyOpen = !!cfg.normallyOpen;
  this.mode = cfg.mode === 'pwm' ? 'pwm' : 'onoff';
  this.onAt = U.def(cfg.onAt, 5);
  this.offAt = U.def(cfg.offAt, 0);
  this.minOnMs = U.def(cfg.minOn, 120) * 1000;
  this.minOffMs = U.def(cfg.minOff, 120) * 1000;
  this.cycleMs = U.def(cfg.cycle, 900) * 1000;
  this.openTimeMs = U.def(cfg.openTime, 180) * 1000;

  // Начальное состояние берём с реле, а не навязываем «закрыто».
  // После перезагрузки сценария (сохранение в веб-интерфейсе) клапан
  // уже открыт и прогрет — сбрасывать его и заново ждать прогрева,
  // останавливая вентилятор на 3 минуты, незачем.
  var first = this.topics.length ? dev[this.topics[0]] : undefined;
  var relayOn = first === true || first === 1 || first === '1';
  this.open = this.normallyOpen ? first === false || first === 0 || first === '0' : relayOn;
  var now = Date.now();
  // since — момент последнего переключения. Для уже открытого клапана
  // считаем, что он открыт давно: прогрев закончен.
  this.since = this.open ? now - this.openTimeMs : null;
  this.cycleStart = null;
  this.lastDemand = 0;
  this.switches = 0;
}

/** Состояние реле, соответствующее положению клапана. */
ThermalValve.prototype._relayFor = function (open) {
  return this.normallyOpen ? !open : !!open;
};

/** Привести реле к нужному состоянию. Пишем, только если отличается. */
ThermalValve.prototype._write = function () {
  var want = this._relayFor(this.open);
  for (var i = 0; i < this.topics.length; i++) {
    var t = this.topics[i];
    if (dev[t] === want) continue;
    try {
      dev[t] = want;
    } catch (e) {
      this.log.error('[{}] не удалось записать {}: {}', this.id, t, e);
    }
  }
};

ThermalValve.prototype._onoff = function (demand) {
  if (!this.open && demand >= this.onAt) return true;
  if (this.open && demand <= this.offAt) return false;
  return this.open;
};

/**
 * ШИМ: в каждом цикле клапан открыт долю времени, равную потребности.
 * Потребность пересчитывается каждый такт, так что изменение уставки
 * сказывается в текущем цикле, а не через 15 минут.
 */
ThermalValve.prototype._pwm = function (demand, now) {
  var cyc = this.cycleMs;
  // Потребность появилась после простоя — цикл начинается сейчас,
  // иначе клапан ждал бы конца «пустого» цикла до 15 минут.
  if (this.cycleStart === null || now - this.cycleStart >= cyc || (this.lastDemand <= 0 && demand > 0)) {
    this.cycleStart = now;
  }
  var onMs = (U.clamp(demand, 0, 100) / 100) * cyc;
  // Импульс короче времени открытия термоголовки ничего не даст —
  // клапан не успеет открыться. Пауза короче минимальной — тоже.
  if (onMs < this.minOnMs) onMs = 0;
  else if (cyc - onMs < this.minOffMs) onMs = cyc;
  return now - this.cycleStart < onMs;
};

/**
 * Такт: отработать потребность.
 * @param {number} demand потребность зоны, %
 * @param {number} now    текущее время, мс
 * @param {bool}   force  переключить сразу, без учёта минимальных времён
 *                        (зону выключили, открыли окно)
 * @returns {bool} клапан открыт
 */
ThermalValve.prototype.update = function (demand, now, force) {
  demand = U.isNum(demand) ? demand : 0;
  var want = this.mode === 'pwm' ? this._pwm(demand, now) : this._onoff(demand);
  this.lastDemand = demand;

  if (want !== this.open && !force && this.since !== null) {
    var minMs = this.open ? this.minOnMs : this.minOffMs;
    if (now - this.since < minMs) want = this.open;
  }
  if (want !== this.open) {
    this.open = want;
    this.since = now;
    this.switches++;
  }
  this._write();
  return this.open;
};

/** Сколько клапан открыт, мс (0 — закрыт). */
ThermalValve.prototype.openFor = function (now) {
  if (!this.open) return 0;
  return this.since === null ? this.openTimeMs : now - this.since;
};

/** Термоголовка успела открыться полностью. */
ThermalValve.prototype.isFullyOpen = function (now) {
  return this.openFor(now) >= this.openTimeMs;
};

ThermalValve.prototype.getFault = function () {
  for (var i = 0; i < this.topics.length; i++) {
    var e = U.linkError(this.topics[i]);
    if (e) return 'термоголовка: ' + e;
  }
  return null;
};

/** Закрыть немедленно. */
ThermalValve.prototype.halt = function () {
  if (this.open) {
    this.open = false;
    this.since = Date.now();
  }
  this._write();
};

ThermalValve.prototype.outputs = function () {
  return this.topics.slice();
};

exports.ThermalValve = ThermalValve;
