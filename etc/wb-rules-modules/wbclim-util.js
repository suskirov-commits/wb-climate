/**
 * @file wbclim-util.js
 * @description Утилиты климат-контроля: валидация чисел, фильтрация
 *              показаний датчиков, отбраковка выбросов, контроль связи
 *              по meta/error, группа датчиков помещения.
 *
 * Датчик (Sensor) и фильтр (Ema) перенесены из wb-mixing-groups
 * (wbmix-util.js) без изменения логики — кандидаты в общую библиотеку.
 *
 * Целевой рантайм: wb-rules 2.x (duktape, ECMAScript 5).
 * Никаких let/const/=>/шаблонных строк.
 */

/* ------------------------------------------------------------------ */
/*  Базовые хелперы                                                    */
/* ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

/** Мягкое приведение значения из MQTT к числу. */
function toNum(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  var n = parseFloat(v);
  return isFinite(n) ? n : NaN;
}

/** Округление до N знаков (для публикации в MQTT). */
function round(v, digits) {
  if (!isNum(v)) return v;
  var k = Math.pow(10, digits === undefined ? 2 : digits);
  return Math.round(v * k) / k;
}

/**
 * Значение по умолчанию, если поле не задано.
 * Не годится там, где null несёт смысл («выключено»): null тоже
 * превращается в значение по умолчанию (wbmix, грабля №13).
 */
function def(v, d) {
  return v === undefined || v === null ? d : v;
}

/**
 * Список топиков из конфигурации. Принимает строку, массив строк или
 * массив объектов { control: "устройство/контрол" } — так списки топиков
 * хранит форма настроек (таблица, как в штатных сценариях wb-scenarios).
 * Пустые строки отбрасываются: эталон поставляется с пустыми полями.
 */
function topicList(v) {
  var src = Array.isArray(v) ? v : v ? [v] : [];
  var out = [];
  for (var i = 0; i < src.length; i++) {
    var t = src[i] && typeof src[i] === 'object' ? src[i].control : src[i];
    if (typeof t === 'string' && t !== '') out.push(t);
  }
  return out;
}

/**
 * Связь с контролом по meta/error.
 * @returns {string|null} причина отказа или null, если всё в порядке
 */
function linkError(topic) {
  if (!topic) return 'не задан топик';
  var err = dev[topic + '#error'];
  if (err === null) return 'нет контрола ' + topic;
  if (err !== undefined && err !== '' && err !== false) return 'нет связи (' + topic + ': ' + err + ')';
  return null;
}

/* ------------------------------------------------------------------ */
/*  Экспоненциальный фильтр первого порядка                            */
/* ------------------------------------------------------------------ */

/**
 * @param {number} tau постоянная времени фильтра, с (0 = фильтр выключен)
 */
function Ema(tau) {
  this.tau = tau || 0;
  this.value = null;
}

Ema.prototype.push = function (x, dt) {
  if (!isNum(x)) return this.value;
  if (this.value === null || this.tau <= 0 || !isNum(dt)) {
    this.value = x;
    return this.value;
  }
  // Внеочередной такт (смена уставки) в тот же момент — фильтр не трогаем.
  // В wbmix здесь было «value = x», и такой такт обнулял сглаживание.
  if (dt <= 0) return this.value;
  var a = dt / (this.tau + dt);
  this.value = this.value + a * (x - this.value);
  return this.value;
};

Ema.prototype.reset = function () {
  this.value = null;
};

/* ------------------------------------------------------------------ */
/*  Датчик                                                             */
/* ------------------------------------------------------------------ */

/**
 * Обёртка над MQTT-топиком датчика.
 *
 *   - проверяет наличие контрола и meta/error (обрыв 1-Wire, потеря Modbus);
 *   - отбраковывает значения вне физического диапазона;
 *   - отбраковывает выбросы (скачок быстрее maxRate единиц в секунду);
 *   - сглаживает показания фильтром первого порядка;
 *   - поднимает признак fault только после N подряд плохих чтений,
 *     чтобы одиночный сбой опроса не ронял зону в аварию.
 *
 * @param {string} topic  "device/control", например "wb-msw-v3_21/Temperature"
 * @param {Object} opts   { tau, min, max, maxRate, faultAfter, required }
 */
function Sensor(topic, opts) {
  opts = opts || {};
  this.topic = topic || null;
  this.required = def(opts.required, true);
  this.min = def(opts.min, -60);
  this.max = def(opts.max, 150);
  this.maxRate = def(opts.maxRate, 2); // единиц/с
  this.faultAfter = def(opts.faultAfter, 3);
  this.ema = new Ema(def(opts.tau, 5));

  this.value = null; // отфильтрованное
  this.raw = null; // последнее принятое сырое
  this.badCount = 0;
  this.fault = false;
  this.reason = this.topic ? 'init' : 'not configured';
  this.configured = !!this.topic;
}

/**
 * Прочитать датчик.
 * @param {number} dt интервал с прошлого чтения, с
 * @returns {boolean} true, если значение валидно
 */
Sensor.prototype.poll = function (dt) {
  if (!this.configured) {
    this.fault = this.required;
    return false;
  }

  var bad = null;
  var v = NaN;

  // 1. Существование контрола и признак ошибки шины
  var errMeta = dev[this.topic + '#error'];
  if (errMeta === null) {
    bad = 'no control';
  } else if (errMeta !== undefined && errMeta !== '' && errMeta !== false) {
    bad = 'bus error: ' + errMeta;
  } else {
    // 2. Значение и физический диапазон
    v = toNum(dev[this.topic]);
    if (!isNum(v)) bad = 'no value';
    else if (v < this.min || v > this.max) bad = 'out of range: ' + v;
    // 3. Отбраковка выбросов
    else if (
      this.raw !== null &&
      isNum(dt) &&
      dt > 0 &&
      Math.abs(v - this.raw) > this.maxRate * dt + 1
    ) {
      bad = 'spike: ' + this.raw + ' -> ' + v;
    }
  }

  if (bad !== null) {
    this.badCount++;
    this.reason = bad;
    if (this.badCount >= this.faultAfter) {
      this.fault = true;
      // после устойчивой аварии сбрасываем историю, чтобы после
      // восстановления датчик не считался «выбросом»
      this.raw = null;
      this.ema.reset();
      this.value = null;
    }
    return false;
  }

  this.badCount = 0;
  this.fault = false;
  this.reason = 'ok';
  this.raw = v;
  this.value = this.ema.push(v, dt);
  return true;
};

/** Значение или fallback, если датчик неисправен/не настроен. */
Sensor.prototype.get = function (fallback) {
  return this.fault || this.value === null ? fallback : this.value;
};

Sensor.prototype.ok = function () {
  return !this.fault && this.value !== null;
};

/* ------------------------------------------------------------------ */
/*  Группа датчиков                                                    */
/* ------------------------------------------------------------------ */

/**
 * Несколько датчиков одной величины в одном помещении: среднее по
 * исправным. Отказ части датчиков — предупреждение, зона работает на
 * оставшихся; отказ всех — авария.
 *
 * Среднее, а не минимум: датчик у окна или над конвектором и так
 * врёт в свою сторону, а минимум держал бы помещение перегретым.
 *
 * @param {Array|string} topics топики датчиков
 * @param {Object} opts параметры Sensor для каждого
 */
function SensorSet(topics, opts) {
  var list = topicList(topics);
  this.sensors = [];
  for (var i = 0; i < list.length; i++) this.sensors.push(new Sensor(list[i], opts));
  this.configured = this.sensors.length > 0;
  this.value = null;
}

SensorSet.prototype.poll = function (dt) {
  var sum = 0;
  var n = 0;
  for (var i = 0; i < this.sensors.length; i++) {
    var s = this.sensors[i];
    s.poll(dt);
    if (s.ok()) {
      sum += s.value;
      n++;
    }
  }
  this.value = n > 0 ? sum / n : null;
  return n > 0;
};

SensorSet.prototype.ok = function () {
  return this.value !== null;
};

SensorSet.prototype.get = function (fallback) {
  return this.value === null ? fallback : this.value;
};

/** Описание неисправных датчиков (пустая строка — все в порядке). */
SensorSet.prototype.faults = function () {
  var out = [];
  for (var i = 0; i < this.sensors.length; i++) {
    var s = this.sensors[i];
    if (s.fault) out.push(s.topic + ' (' + s.reason + ')');
  }
  return out.join(', ');
};

/* ------------------------------------------------------------------ */

exports.clamp = clamp;
exports.isNum = isNum;
exports.toNum = toNum;
exports.round = round;
exports.def = def;
exports.topicList = topicList;
exports.linkError = linkError;
exports.Ema = Ema;
exports.Sensor = Sensor;
exports.SensorSet = SensorSet;
